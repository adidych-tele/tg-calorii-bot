// api/webhook.js
// Vercel serverless-функция (Node 18+). ENV: BOT_TOKEN, OPENAI_API_KEY

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const FREE_DAILY_LIMIT = 5;      // 5 бесплатных фото/день
const DEFAULT_ACTIVITY_K = 1.4;  // вес × 24 × K

// На MVP храним в памяти процесса (при перезапуске сбросится)
const usage = new Map();   // { chatId: { day, freeCount, credits } }
const users = new Map();   // { chatId: { weightKg, activityK, dailyTarget, consumedToday, lastReset, _awaitingWeight, _awaitingPortionG, _lastAnalysis } }
const lastTips = new Map();// { chatId: ["совет1",...] }

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Only POST');
    const update = req.body;

    // --- Payments заглушка (на будущее Stars) ---
    if (update.pre_checkout_query) {
      await fetch(`${TG_API}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
      });
      return res.json({ ok: true });
    }
    if (update.message && update.message.successful_payment) {
      const chat_id = update.message.chat.id;
      bumpCredits(chat_id, 50);
      await sendMessage(chat_id, `Оплата получена ✅ Я добавил 50 анализов на твой баланс.`);
      return res.json({ ok: true });
    }

    // --- Callback кнопки ---
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat_id = cq.message.chat.id;
      const data = cq.data || '';

      if (data === 'how') {
        await sendMessage(chat_id, howItWorksText());
      } else if (data === 'tips') {
        const tips = lastTips.get(String(chat_id));
        if (Array.isArray(tips) && tips.length) {
          await sendMessage(chat_id, formatTips(tips));
        } else {
          await sendMessage(chat_id, `Советы пока не готовы. Пришли фото блюда ещё раз — я их сгенерирую.`);
        }
      } else if (data.startsWith('portion:')) {
        await handlePortionCallback(chat_id, data);
      } else if (data === 'portion:manual') {
        const u = getUser(chat_id);
        u._awaitingPortionG = true;
        setUser(chat_id, u);
        await sendMessage(chat_id, 'Введи граммы числом, например: 25');
      } else if (data === 'next') {
        await sendMessage(chat_id, 'Ок! Пришли следующее фото 📸');
      } else if (data.startsWith('buy:')) {
        await sendMessage(chat_id, 'Оплата пакетами скоро буде підключена ⭐');
      } else if (data === 'diary:add') {
        await sendMessage(chat_id, 'Збережу в денник у наступній версії 🗒️');
      } else if (data === 'remind:morning') {
        await sendMessage(chat_id, 'Нагадування додамо в /settings найближчим часом ⏰');
      }
      await answerCallbackQuery(cq.id);
      return res.json({ ok: true });
    }

    // --- Сообщения ---
    if (update.message) {
      const msg = update.message;
      const chat_id = msg.chat.id;

      // Тексты
      if (msg.text) {
        const text = (msg.text || '').trim();

        if (text === '/start') {
          await sendMessage(chat_id,
`Привет! Я посчитаю калории по фото 🍽️
Чтобы показывать «сколько осталось на сегодня», напиши свой вес (в кг).

Например: 72`,
            { inline_keyboard: [[{ text: 'ℹ️ Как это работает', callback_data: 'how' }]] }
          );
          return res.json({ ok: true });
        }

        if (text === '/help') {
          await sendMessage(chat_id, howItWorksText());
          return res.json({ ok: true });
        }

        if (text === '/stats') {
          const { freeCount, credits } = getUsage(chat_id);
          const u = getUser(chat_id);
          const consumed = u.consumedToday ?? 0;
          const daily = u.dailyTarget ?? null;
          const leftKcal = daily ? Math.max(0, daily - consumed) : null;
          await sendMessage(chat_id,
`Сегодня: ${freeCount}/${FREE_DAILY_LIMIT} бесплатных анализов.
Платные кредиты: ${credits}.
Съедено сегодня: ~${consumed} ккал${leftKcal!==null ? `, осталось ~${leftKcal} ккал` : ''}.`);
          return res.json({ ok: true });
        }

        if (text === '/weight') {
          const u = getUser(chat_id);
          u._awaitingWeight = true;
          setUser(chat_id, u);
          await sendMessage(chat_id, `Текущий вес: ${u.weightKg ?? 'не задан'} кг. Введи новый вес (например: 70):`);
          return res.json({ ok: true });
        }

        // ждём вес?
        const uWait = getUser(chat_id);
        if (uWait._awaitingWeight) {
          const kg = extractNumberKg(text);
          if (kg) {
            uWait._awaitingWeight = false;
            uWait.weightKg = kg;
            uWait.activityK = uWait.activityK || DEFAULT_ACTIVITY_K;
            uWait.dailyTarget = Math.round(kg * 24 * uWait.activityK);
            setUser(chat_id, uWait);
            await sendMessage(chat_id, `Готово! Твоя дневная норма: ~${uWait.dailyTarget} ккал (формула: вес×24×1.4).
Пришли фото блюда — посчитаю и покажу остаток на сегодня.`);
          } else {
            await sendMessage(chat_id, `Не понял вес. Введи число в кг, например: 72`);
          }
          return res.json({ ok: true });
        }

        // Похоже, пользователь отправил вес числом
        const maybeKg = extractNumberKg(text);
        if (maybeKg) {
          const u = getUser(chat_id);
          u.weightKg = maybeKg;
          u.activityK = u.activityK || DEFAULT_ACTIVITY_K;
          u.dailyTarget = Math.round(maybeKg * 24 * u.activityK);
          setUser(chat_id, u);
          await sendMessage(chat_id, `Отлично! Дневная норма: ~${u.dailyTarget} ккал. Пришли фото блюда — посчитаю и покажу остаток на сегодня.`);
          return res.json({ ok: true });
        }

        // Если это другое сообщение
        await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
        return res.json({ ok: true });
      }

      // Фото
     // === Фото или картинка как документ ===
let fileId = null;

if (msg.photo && msg.photo.length) {
  // обычное "Фото"
  const largest = msg.photo[msg.photo.length - 1];
  fileId = largest.file_id;
} else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
  // "Отправить как файл" -> document (image/*)
  fileId = msg.document.file_id;
}

if (fileId) {
  dailyReset(chat_id);

  const can = canSpendAnalysis(chat_id);
  if (!can.allowed) {
    await sendMessage(chat_id,
`Сегодня лимит исчерпан (${FREE_DAILY_LIMIT}/${FREE_DAILY_LIMIT}) 🚦
Завтра снова бесплатно 🎉

Хочешь продолжить сейчас? Пакеты оплат добавим скоро ⭐`);
    return res.json({ ok: true });
  }
  spendOne(chat_id);

  // Получаем file_path с диагностикой
  const { ok, file_path, debug } = await safeGetFilePath(fileId);

  if (!ok || !file_path) {
    // ВРЕМЕННАЯ диагностика: покажем пользователю, что ответил Telegram (обрежем до 400 символов)
    const dbg = (debug && JSON.stringify(debug).slice(0, 400)) || 'нет данных';
    await sendMessage(chat_id, `Не смог скачать фото. Спробуй ще раз як "Фото", а не "Файл".\n(dbg: ${dbg})`);
    return res.json({ ok: true });
  }

  const fileUrl = `${TG_FILE}/${file_path}`;

  const analysis = await analyzeImageWithOpenAI(fileUrl);
  if (analysis?.error === 'not_food') {
    await sendMessage(chat_id, `Похоже, на фото не еда 🙂 Пришли фото блюда сверху, при хорошем освещении.`);
    return res.json({ ok: true });
  }
  if (!analysis) {
    await sendMessage(chat_id, `Не удалось проанализировать. Попробуй другой ракурс или ярче освещение.`);
    return res.json({ ok: true });
  }

  // Сохраняем последний анализ у пользователя
  const u = getUser(chat_id);
  u._lastAnalysis = analysis;
  setUser(chat_id, u);

  // Обновим съедено и остаток
  const kcal = Math.max(0, Math.round(analysis.calories_estimate || 0));
  u.consumedToday = (u.consumedToday || 0) + kcal;
  setUser(chat_id, u);
  const remaining = u.dailyTarget != null ? Math.max(0, u.dailyTarget - u.consumedToday) : null;

  if (Array.isArray(analysis.tips)) lastTips.set(String(chat_id), analysis.tips);

  // Сообщение №1 — карточка результата (советы по кнопке)
  const text = formatMealMessage(analysis, remaining, u.dailyTarget);
  await sendMessage(chat_id, text, {
    inline_keyboard: [[{ text: '🔁 Хочу советы', callback_data: 'tips' }]]
  });

  // Небольшая пауза
  await new Promise(r => setTimeout(r, 700));

  // Сообщение №2 — follow-up
  const followup = buildFollowup(chat_id, u, analysis);
  await sendMessage(chat_id, followup.text, followup.keyboard);

  return res.json({ ok: true });
}

// Если не фото и не изображение-документ:
await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
return res.json({ ok: true });


        // Сохраняем последний анализ у пользователя
        const u = getUser(chat_id);
        u._lastAnalysis = analysis;
        setUser(chat_id, u);

        // Обновим съедено и остаток
        const kcal = Math.max(0, Math.round(analysis.calories_estimate || 0));
        u.consumedToday = (u.consumedToday || 0) + kcal;
        setUser(chat_id, u);
        const remaining = u.dailyTarget != null ? Math.max(0, u.dailyTarget - u.consumedToday) : null;

        if (Array.isArray(analysis.tips)) lastTips.set(String(chat_id), analysis.tips);

        // Сообщение №1 — карточка результата (советы по кнопке)
        const text = formatMealMessage(analysis, remaining, u.dailyTarget);
        await sendMessage(chat_id, text, {
          inline_keyboard: [[{ text: '🔁 Хочу советы', callback_data: 'tips' }]]
        });

        // Небольшая естественная пауза
        await new Promise(r => setTimeout(r, 700));

        // Сообщение №2 — вовлечение + уточнение порции при низкой уверенности
        const followup = buildFollowup(chat_id, u, analysis);
        await sendMessage(chat_id, followup.text, followup.keyboard);

        return res.json({ ok: true });
      }

      await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // чтобы TG не ретраил
  }
};

// ---------- Telegram helpers ----------
async function sendMessage(chat_id, text, replyMarkup) {
  const body = { chat_id, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
async function answerCallbackQuery(id) {
  await fetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id })
  });
}
async function safeGetFilePath(file_id) {
  try {
    const r = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(file_id)}`);
    const j = await r.json();
    if (j && j.ok && j.result && j.result.file_path) {
      return { ok: true, file_path: j.result.file_path, debug: j };
    }
    return { ok: false, file_path: null, debug: j || null };
  } catch (e) {
    return { ok: false, file_path: null, debug: { error: String(e) } };
  }
}

// ---------- OpenAI Vision ----------
async function analyzeImageWithOpenAI(imageUrl) {
  try {
    const systemPrompt = `
Ты – диетологический ассистент. На входе одно фото блюда.
Оцени ориентировочно калории и макросы на привычную порцию. Советы дай кратко (но не показывай их, это по запросу).
Если фото не еда — верни {"error":"not_food"}.

Если видишь упаковку, попробуй OCR:
- общий вес упаковки (package_total_g)
- калории на 100 г (per_100g_kcal)

Если видишь эталоны размера (банковская карта 85.6×54 мм, чайная/столовая ложка, монета) — используй для оценки массы.

Верни строго JSON с полями:
{
 "dish_name": "строка",
 "calories_estimate": число,
 "macros_estimate": {"protein_g": число, "fat_g": число, "carbs_g": число},
 "portion_estimate_g": число | null,
 "portion_confidence": число 0..1,
 "package_total_g": число | null,
 "per_100g_kcal": число | null,
 "tips": ["совет1","совет2","совет3"],
 "uncertainty_note": "строка",
 "suggested_portion_options": ["1/2","1/3","1/4","10g","20g","30g"]
}`;
    const userPrompt = `Проанализируй фото блюда и верни JSON строго по схеме. Если не еда — {"error":"not_food"}.`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]}
        ],
        temperature: 0.3
      })
    });
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (e) {
    console.error('OpenAI error', e);
    return null;
  }
}

// ---------- Бизнес-логика и утилиты ----------
function howItWorksText() {
  return `Як це працює:
1) Надішли одне фото страви (краще зверху, без фільтрів).
2) Я дам орієнтовні калорії та БЖУ.
3) Покажу, скільки залишилось на сьогодні (вага×24×1.4), якщо вказаний вагу.
4) 5 аналізів/день безкоштовно. Далі — пакети за Stars.

Порада для точності: клади поруч монету/картку/ложку або показуй вагу упаковки (напр. 95 г). 
⚠️ Оцінка орієнтовна і не є медичною порадою.`;
}

function getUser(chat_id) {
  const key = String(chat_id);
  const u = users.get(key) || {};
  if (!u.activityK) u.activityK = DEFAULT_ACTIVITY_K;
  if (!u.lastReset) u.lastReset = todayKey();
  return u;
}
function setUser(chat_id, data) { users.set(String(chat_id), data); }

function dailyReset(chat_id) {
  const u = getUser(chat_id);
  const today = todayKey();
  if (u.lastReset !== today) {
    u.lastReset = today;
    u.consumedToday = 0;
    setUser(chat_id, u);
  }
}

function extractNumberKg(text) {
  const m = (text || '').replace(',', '.').match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  const kg = parseFloat(m[1]);
  if (!kg || kg < 20 || kg > 300) return null;
  return kg;
}
function extractIntGrams(text) {
  const m = (text || '').replace(',', '.').match(/(\d+)/);
  if (!m) return null;
  const g = parseInt(m[1], 10);
  if (!g || g < 1 || g > 2000) return null;
  return g;
}

function getUsage(chat_id) {
  const key = String(chat_id);
  const today = todayKey();
  let u = usage.get(key);
  if (!u || u.day !== today) {
    u = { day: today, freeCount: 0, credits: u?.credits || 0 };
    usage.set(key, u);
  }
  return { freeCount: u.freeCount, credits: u.credits, leftFree: Math.max(0, FREE_DAILY_LIMIT - u.freeCount) };
}
function canSpendAnalysis(chat_id) {
  const key = String(chat_id);
  const today = todayKey();
  let u = usage.get(key);
  if (!u || u.day !== today) {
    u = { day: today, freeCount: 0, credits: u?.credits || 0 };
    usage.set(key, u);
  }
  if (u.credits > 0) return { allowed: true, mode: 'credit' };
  if (u.freeCount < FREE_DAILY_LIMIT) return { allowed: true, mode: 'free' };
  return { allowed: false };
}
function spendOne(chat_id) {
  const key = String(chat_id);
  const u = usage.get(key);
  if (u.credits > 0) u.credits -= 1;
  else u.freeCount += 1;
  usage.set(key, u);
}
function bumpCredits(chat_id, n) {
  const key = String(chat_id);
  const today = todayKey();
  let u = usage.get(key);
  if (!u || u.day !== today) u = { day: today, freeCount: 0, credits: 0 };
  u.credits += n;
  usage.set(key, u);
}

function progressBar(consumed, total) {
  const p = Math.max(0, Math.min(1, consumed / total));
  const filled = Math.round(p * 5); // 5 сегментов
  return '🔋 ' + '█'.repeat(filled) + '░'.repeat(5 - filled);
}

function formatMealMessage(a, remaining, dailyTarget) {
  const name = a.dish_name || 'Блюдо';
  const kcal = a.calories_estimate ? Math.round(a.calories_estimate) : '—';
  const p = a.macros_estimate?.protein_g ?? '—';
  const f = a.macros_estimate?.fat_g ?? '—';
  const c = a.macros_estimate?.carbs_g ?? '—';
  const portion = a.portion_estimate_g ? `Порция: ~${Math.round(a.portion_estimate_g)} г\n` : '';
  const bar = (remaining != null && dailyTarget) ? progressBar(dailyTarget - remaining, dailyTarget) : '';
  const left = (remaining != null)
    ? `Осталось на сегодня: ~${remaining} ккал ${bar}\n`
    : `(Чтобы считать остаток за день — укажи вес: /weight)\n`;
  return `🍽️ ${name}
≈ ${kcal} ккал (±15%)
БЖУ (прибл.): Б ${p} г, Ж ${f} г, У ${c} г
${portion}${left}
⚠️ Это ориентировочная оценка, не медицинский совет.`;
}

function formatTips(tips) {
  return `Идеи по улучшению:\n${tips.map(t => `• ${t}`).join('\n')}`;
}

function buildFollowup(chat_id, user, analysis) {
  const { freeCount, credits, leftFree } = getUsage(chat_id);
  const hasWeight = user.dailyTarget != null;
  const remaining = (user.dailyTarget != null) ? Math.max(0, user.dailyTarget - (user.consumedToday || 0)) : null;

  // Предложим уточнить порцию, если уверенность низкая или есть данные упаковки
  const needRefine = (analysis.portion_confidence != null && analysis.portion_confidence < 0.7)
    || (!analysis.portion_estimate_g && (analysis.package_total_g || analysis.per_100g_kcal));

  if (!hasWeight) {
    return {
      text: `Хочешь, буду считать «сколько осталось на сегодня»? Напиши свой вес в кг (например: 72).`,
      keyboard: { inline_keyboard: [[{ text: 'ℹ️ Как это работает', callback_data: 'how' }]] }
    };
  }

  const rows = [];
  let text = '';

  if (needRefine) {
    // Кнопки уточнения порции
    const opts = Array.isArray(analysis.suggested_portion_options) && analysis.suggested_portion_options.length
      ? analysis.suggested_portion_options
      : ['1/2', '1/3', '1/4', '10g', '20g', '30g'];

    const btnRows = [];
    for (const o of opts) {
      const norm = o.toLowerCase();
      let data = null;
      if (norm.includes('g')) data = `portion:g:${parseInt(norm)}`;
      else if (norm.includes('1/2')) data = `portion:frac:0.5`;
      else if (norm.includes('1/3')) data = `portion:frac:0.333`;
      else if (norm.includes('1/4')) data = `portion:frac:0.25`;
      if (data) btnRows.push([{ text: o, callback_data: data }]);
    }
    btnRows.push([{ text: 'Ввести граммы вручную', callback_data: 'portion:manual' }]);

    text = `Уточним порцию? Выбери долю или граммы — я пересчитаю калории.`;
    return { text, keyboard: { inline_keyboard: btnRows } };
  }

  if (remaining !== null && remaining <= 300) {
    text = `Осталось на сегодня совсем немного: ~${remaining} ккал. Поставить лёгкое напоминание на завтра?`;
    rows.push(
      [{ text: '⏰ Напомни завтра утром', callback_data: 'remind:morning' }],
      [{ text: '📸 Прислать следующее блюдо', callback_data: 'next' }]
    );
  } else {
    text = `Продолжим? Могу зберегти в денник або дати короткі поради.`;
    rows.push(
      [{ text: '🔁 Хочу советы', callback_data: 'tips' }],
      [{ text: '➕ В денник', callback_data: 'diary:add' }],
      [{ text: '📸 Прислать следующее блюдо', callback_data: 'next' }]
    );
  }

  const nearlyOut = (leftFree <= 1) && credits === 0;
  if (nearlyOut) rows.push([{ text: '⭐ 50 анализов (150⭐)', callback_data: 'buy:50' }]);

  return { text, keyboard: { inline_keyboard: rows } };
}

async function handlePortionCallback(chat_id, data) {
  const u = getUser(chat_id);
  const A = u._lastAnalysis;
  if (!A) {
    await sendMessage(chat_id, 'Нет последнего анализа. Пришли фото ещё раз 🙂');
    return;
  }

  let grams = null;
  if (data.startsWith('portion:g:')) {
    grams = parseInt(data.split(':')[2], 10);
  } else if (data.startsWith('portion:frac:')) {
    const frac = parseFloat(data.split(':')[2]);
    if (A.package_total_g) grams = Math.round(A.package_total_g * frac);
    else if (A.portion_estimate_g) grams = Math.round(A.portion_estimate_g * frac);
  }

  if (!grams) {
    await sendMessage(chat_id, 'Не удалось распознать порцию. Введи граммы числом, например: 25');
    u._awaitingPortionG = true;
    setUser(chat_id, u);
    return;
  }

  const kcalNew = recalcKcal(A, grams);
  if (kcalNew == null) {
    await sendMessage(chat_id, 'Без данных на 100 г сложно пересчитать. Введи граммы вручную или пришли фото упаковки.');
    return;
  }

  const old = Math.max(0, Math.round(A.calories_estimate || 0));
  u.consumedToday = Math.max(0, (u.consumedToday || 0) - old + kcalNew);
  // Обновим базовый анализ, чтобы следующие уточнения считались от новой базы
  A.calories_estimate = kcalNew;
  A.portion_estimate_g = grams;
  u._lastAnalysis = A;
  setUser(chat_id, u);

  const remaining = (u.dailyTarget != null) ? Math.max(0, u.dailyTarget - u.consumedToday) : null;
  await sendMessage(chat_id, `Ок! Пересчитал порцию ~${grams} г → ≈ ${kcalNew} ккал.\nОсталось на сегодня: ${remaining ?? '—'} ккал`);
}

function recalcKcal(A, grams) {
  const per100 = A?.per_100g_kcal || null;
  const baseKcal = A?.calories_estimate || null;
  const baseGr = A?.portion_estimate_g || null;
  if (per100) return Math.round(per100 * (grams / 100));
  if (baseKcal && baseGr) return Math.round(baseKcal * (grams / baseGr));
  return null;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
