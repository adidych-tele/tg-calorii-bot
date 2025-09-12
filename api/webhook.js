// api/webhook.js
// Vercel serverless-функция (Node 18). Нужны ENV: BOT_TOKEN, OPENAI_API_KEY

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TG_FILE = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

const FREE_DAILY_LIMIT = 5;       // 5 бесплатных фото/день
const DEFAULT_ACTIVITY_K = 1.4;   // коэффициент K в формуле вес×24×K

// Хранилища (в памяти — достаточно для MVP; на проде вынеси в БД)
const usage = new Map();   // { chatId: { day:'YYYY-M-D', freeCount:int, credits:int } }
const users = new Map();   // { chatId: { weightKg, activityK, dailyTarget, consumedToday, lastReset } }
const lastTips = new Map(); // { chatId: ["совет1","совет2",...] }

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Only POST');
    const update = req.body;

    // 0) обслужим pre_checkout / successful_payment позже (когда подключим Stars)
    if (update.pre_checkout_query) {
      // Telegram требует ответить положительно/отрицательно. Сейчас всегда ок.
      await fetch(`${TG_API}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
      });
      return res.json({ ok: true });
    }
    if (update.message && update.message.successful_payment) {
      // Когда подключим оплату пакетами — тут увеличим credits.
      const chat_id = update.message.chat.id;
      bumpCredits(chat_id, 50); // пример: добавить 50 анализов
      await sendMessage(chat_id, `Оплата получена ✅ Я добавил 50 анализов на твой баланс.`);
      return res.json({ ok: true });
    }

    // 1) callback_query (кнопки)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat_id = cq.message.chat.id;
      const data = cq.data || '';

      if (data === 'how') {
        await sendMessage(chat_id, howItWorksText());
      } else if (data === 'tips') {
        // Показать советы, если сохранили в lastTips
        const tips = lastTips.get(String(chat_id));
        if (Array.isArray(tips) && tips.length) {
          await sendMessage(chat_id, formatTips(tips));
        } else {
          await sendMessage(chat_id, `Советы пока не готовы. Пришли фото блюда ещё раз — я их сгенерирую.`);
        }
      }
      await answerCallbackQuery(cq.id);
      return res.json({ ok: true });
    }

    // 2) обычные сообщения
    if (update.message) {
      const msg = update.message;
      const chat_id = msg.chat.id;

      // команды
      if (msg.text) {
        const text = msg.text.trim();

        if (text === '/start') {
          await sendMessage(chat_id, 
`Привет! Я посчитаю калории по фото 🍽️
Чтобы показывать «сколько осталось на сегодня», напиши свой вес (в кг).

Например: 72
`, {
            inline_keyboard: [
              [{ text: 'ℹ️ Как это работает', callback_data: 'how' }]
            ]
          });
          return res.json({ ok: true });
        }

        if (text === '/help') {
          await sendMessage(chat_id, howItWorksText());
          return res.json({ ok: true });
        }

        if (text === '/stats') {
          const { freeCount, credits, leftFree } = getUsage(chat_id);
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
          await sendMessage(chat_id, `Текущий вес: ${u.weightKg ?? 'не задан'} кг. Введи новый вес в кг (например: 70):`);
          // дальше отловим следующее текстовое сообщение как число
          u._awaitingWeight = true;
          setUser(chat_id, u);
          return res.json({ ok: true });
        }

        // Если ждём вес
        const u0 = getUser(chat_id);
        if (u0._awaitingWeight) {
          const kg = extractNumberKg(text);
          if (kg) {
            u0._awaitingWeight = false;
            u0.weightKg = kg;
            u0.activityK = u0.activityK || DEFAULT_ACTIVITY_K;
            u0.dailyTarget = Math.round(kg * 24 * u0.activityK);
            setUser(chat_id, u0);
            await sendMessage(chat_id, `Готово! Твоя дневная норма: ~${u0.dailyTarget} ккал (формула: вес×24×1.4).
Пришли фото блюда — посчитаю и покажу остаток на сегодня.`);
          } else {
            await sendMessage(chat_id, `Не понял вес. Введи число в кг, например: 72`);
          }
          return res.json({ ok: true });
        }

        // Если это просто текст (не команда) — попробуем распознать вес
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

        // Иначе просим фото
        await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
        return res.json({ ok: true });
      }

      // фото
      if (msg.photo && msg.photo.length) {
        // 1) проверим ежедневный сброс «съедено»
        dailyReset(chat_id);

        // 2) проверим кредиты и бесплатный лимит
        const canSpend = canSpendAnalysis(chat_id);
        if (!canSpend.allowed) {
          await sendMessage(chat_id, 
`Сегодня лимит исчерпан (${FREE_DAILY_LIMIT}/${FREE_DAILY_LIMIT}) 🚦
Завтра снова бесплатно 🎉

Хочешь продолжить сейчас? (позже подключим покупку пакетов)
`);
          return res.json({ ok: true });
        }
        // списываем
        spendOne(chat_id);

        // 3) берём самое большое фото → file_url
        const largest = msg.photo[msg.photo.length - 1];
        const fileId = largest.file_id;
        const filePath = await getFilePath(fileId);
        if (!filePath) {
          await sendMessage(chat_id, `Не смог скачать фото. Попробуй ещё раз.`);
          return res.json({ ok: true });
        }
        const fileUrl = `${TG_FILE}/${filePath}`;

        // 4) отправляем в OpenAI Vision
        const analysis = await analyzeImageWithOpenAI(fileUrl);

        if (analysis?.error === 'not_food') {
          await sendMessage(chat_id, `Похоже, на фото не еда 🙂 Пришли фото блюда сверху, при хорошем освещении.`);
          return res.json({ ok: true });
        }
        if (!analysis) {
          await sendMessage(chat_id, `Не удалось проанализировать. Попробуй другой ракурс или ярче освещение.`);
          return res.json({ ok: true });
        }

        // 5) обновим «съедено сегодня» и посчитаем остаток
        const kcal = Math.max(0, Math.round(analysis.calories_estimate || 0));
        const u = getUser(chat_id);
        u.consumedToday = (u.consumedToday || 0) + kcal;
        setUser(chat_id, u);
        const remaining = (u.dailyTarget!=null) ? Math.max(0, u.dailyTarget - u.consumedToday) : null;

        // сохраним советы для кнопки
        if (Array.isArray(analysis.tips)) lastTips.set(String(chat_id), analysis.tips);

        // 6) скомпонуем ответ (без советов по умолчанию)
        const text = formatMealMessage(analysis, remaining, u.dailyTarget);
        await sendMessage(chat_id, text, {
          inline_keyboard: [
            [{ text: '🔁 Хочу советы', callback_data: 'tips' }]
          ]
        });
        return res.json({ ok: true });
      }

      // ни текст, ни фото
      await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // чтобы TG не ретраил
  }
};

// ====== Telegram helpers ======
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
async function getFilePath(file_id) {
  const r = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(file_id)}`);
  const j = await r.json();
  return j?.ok && j?.result?.file_path ? j.result.file_path : null;
}

// ====== OpenAI Vision ======
async function analyzeImageWithOpenAI(imageUrl) {
  try {
    const systemPrompt = `
Ты – диетологический ассистент. На входе одно фото блюда.
Оцени ориентировочно калории и макросы на привычную порцию и дай 2–3 простых совета.
Если фото не еда — верни {"error":"not_food"}.
Верни строго JSON с полями:
{
 "dish_name": "строка",
 "calories_estimate": число,
 "macros_estimate": {"protein_g": число, "fat_g": число, "carbs_g": число},
 "portion_estimate_g": число | null,
 "tips": ["совет1","совет2","совет3"],
 "uncertainty_note": "строка"
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
            ]
          }
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

// ====== Бизнес-логика ======
function getUser(chat_id) {
  const key = String(chat_id);
  const u = users.get(key) || {};
  if (!u.activityK) u.activityK = DEFAULT_ACTIVITY_K;
  if (!u.lastReset) u.lastReset = todayKey();
  return u;
}
function setUser(chat_id, data) {
  users.set(String(chat_id), data);
}
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
  if (!kg || kg < 20 || kg > 300) return null; // простая валидация
  return kg;
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

function formatMealMessage(a, remaining, dailyTarget) {
  const name = a.dish_name || 'Блюдо';
  const kcal = a.calories_estimate ? Math.round(a.calories_estimate) : '—';
  const p = a.macros_estimate?.protein_g ?? '—';
  const f = a.macros_estimate?.fat_g ?? '—';
  const c = a.macros_estimate?.carbs_g ?? '—';
  const portion = a.portion_estimate_g ? `Порция: ~${Math.round(a.portion_estimate_g)} г\n` : '';
  const bar = (remaining!=null && dailyTarget) ? progressBar(dailyTarget-remaining, dailyTarget) : '';
  const left = (remaining!=null) ? `Осталось на сегодня: ~${remaining} ккал ${bar}\n` : `(Чтобы считать остаток за день — укажи вес: /weight)\n`;

  return (
`🍽️ ${name}
≈ ${kcal} ккал (±15%)
БЖУ (прибл.): Б ${p} г, Ж ${f} г, У ${c} г
${portion}${left}
⚠️ Это ориентировочная оценка, не медицинский совет.`
  );
}
function formatTips(tips) {
  return `Идеи по улучшению:\n${tips.map(t => `• ${t}`).join('\n')}`;
}
function progressBar(consumed, total) {
  const p = Math.max(0, Math.min(1, consumed / total));
  const filled = Math.round(p * 5); // 5 сегментов
  return '🔋 ' + '█'.repeat(filled) + '░'.repeat(5 - filled);
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
