// Vercel Serverless Function (Node 18+)
// ENV required: BOT_TOKEN, OPENAI_API_KEY

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TG_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const TG_FILE = BOT_TOKEN ? `https://api.telegram.org/file/bot${BOT_TOKEN}` : null;

const FREE_DAILY_LIMIT = 5;      // 5 бесплатных фото/день
const DEFAULT_ACTIVITY_K = 1.4;  // формула: вес × 24 × K

// MVP-хранилище в памяти (при перезапуске деплоя сбросится)
const usage = new Map(); // {chatId:{day,freeCount,credits}}
const users = new Map(); // {chatId:{weightKg,activityK,dailyTarget,consumedToday,lastReset,_awaitingWeight,_awaitingPortionG,_lastAnalysis}}
const lastTips = new Map(); // {chatId:[tips...]}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      // health/ping
      res.status(200).send('OK');
      return;
    }

    // --- безопасно читаем JSON тело (на случай, если req.body отсутствует) ---
    const update = await readJsonBody(req);
    if (!update) {
      console.error('Empty or invalid JSON body');
      res.status(200).json({ ok: true });
      return;
    }

    // --- базовые проверки ENV (в логах будет видно) ---
    if (!BOT_TOKEN || !OPENAI_API_KEY) {
      console.error('Missing ENV:', { hasBotToken: !!BOT_TOKEN, hasOpenAI: !!OPENAI_API_KEY });
      // ответим 200, чтобы Telegram не ретраил бесконечно
      res.status(200).json({ ok: true });
      return;
    }

    // ============== PAYMENTS (заглушки под Stars) ==============
    if (update.pre_checkout_query) {
      await safeFetch(`${TG_API}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
      });
      res.status(200).json({ ok: true });
      return;
    }
    if (update.message && update.message.successful_payment) {
      const chat_id = update.message.chat.id;
      bumpCredits(chat_id, 50); // пример
      await sendMessage(chat_id, `Оплата получена ✅ Я добавил 50 анализов на твой баланс.`);
      res.status(200).json({ ok: true });
      return;
    }

    // ============== CALLBACKS ==============
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat_id = cq.message.chat.id;
      const data = cq.data || '';

      try {
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
      } catch (e) {
        console.error('callback error', e);
      } finally {
        await answerCallbackQuery(cq.id);
        res.status(200).json({ ok: true });
        return;
      }
    }

    // ============== MESSAGES ==============
    if (update.message) {
      const msg = update.message;
      const chat_id = msg.chat.id;

      // ---- ТЕКСТ ----
      if (msg.text) {
        const text = (msg.text || '').trim();

        if (text === '/start') {
          await sendMessage(chat_id,
`Привет! Я посчитаю калории по фото 🍽️
Чтобы показывать «сколько осталось на сегодня», напиши свой вес (в кг).

Например: 72`,
            { inline_keyboard: [[{ text: 'ℹ️ Как это работает', callback_data: 'how' }]] }
          );
          res.status(200).json({ ok: true });
          return;
        }

        if (text === '/help') {
          await sendMessage(chat_id, howItWorksText());
          res.status(200).json({ ok: true });
          return;
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
          res.status(200).json({ ok: true });
          return;
        }

        if (text === '/weight') {
          const u = getUser(chat_id);
          u._awaitingWeight = true;
          setUser(chat_id, u);
          await sendMessage(chat_id, `Текущий вес: ${u.weightKg ?? 'не задан'} кг. Введи новый вес (например: 70):`);
          res.status(200).json({ ok: true });
          return;
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
          res.status(200).json({ ok: true });
          return;
        }

        // возможно, пользователь просто прислал вес числом
        const maybeKg = extractNumberKg(text);
        if (maybeKg) {
          const u = getUser(chat_id);
          u.weightKg = maybeKg;
          u.activityK = u.activityK || DEFAULT_ACTIVITY_K;
          u.dailyTarget = Math.round(maybeKg * 24 * u.activityK);
          setUser(chat_id, u);
          await sendMessage(chat_id, `Отлично! Дневная норма: ~${u.dailyTarget} ккал. Пришли фото блюда — посчитаю и покажу остаток на сегодня.`);
          res.status(200).json({ ok: true });
          return;
        }

        // прочий текст
        await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
        res.status(200).json({ ok: true });
        return;
      }

      // ---- ФОТО / ДОКУМЕНТ-ИЗОБРАЖЕНИЕ ----
      let fileId = null;

      if (msg.photo && msg.photo.length) {
        const largest = msg.photo[msg.photo.length - 1];
        fileId = largest.file_id;
      } else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
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
          res.status(200).json({ ok: true });
          return;
        }
        spendOne(chat_id);

        const { ok, file_path, debug } = await safeGetFilePath(fileId);
        if (!ok || !file_path) {
          console.error('getFile error', debug);
          await sendMessage(chat_id, `Не смог скачать фото. Попробуй отправить как «Фото», а не «Файл», либо ещё раз.`);
          res.status(200).json({ ok: true });
          return;
        }
        const fileUrl = `${TG_FILE}/${file_path}`;

        const analysis = await analyzeImageWithOpenAI(fileUrl);
        if (analysis?.error === 'not_food') {
          await sendMessage(chat_id, `Похоже, на фото не еда 🙂 Пришли фото блюда сверху, при хорошем освещении.`);
          res.status(200).json({ ok: true });
          return;
        }
        if (!analysis) {
          await sendMessage(chat_id, `Не удалось проанализировать. Попробуй другой ракурс или ярче освещение.`);
          res.status(200).json({ ok: true });
          return;
        }

        // Сохраняем последний анализ
        const u = getUser(chat_id);
        u._lastAnalysis = analysis;
        setUser(chat_id, u);

        // Учёт калорий и остатка
        const kcal = Math.max(0, Math.round(analysis.calories_estimate || 0));
        u.consumedToday = (u.consumedToday || 0) + kcal;
        setUser(chat_id, u);
        const remaining = u.dailyTarget != null ? Math.max(0, u.dailyTarget - u.consumedToday) : null;

        if (Array.isArray(analysis.tips)) lastTips.set(String(chat_id), analysis.tips);

        // Сообщение №1 — карточка результата
        const text = formatMealMessage(analysis, remaining, u.dailyTarget);
        await sendMessage(chat_id, text, {
          inline_keyboard: [[{ text: '🔁 Хочу советы', callback_data: 'tips' }]]
        });

        // Небольшая естественная пауза
        await sleep(700);

        // Сообщение №2 — follow-up / уточнение порции
        const followup = buildFollowup(chat_id, u, analysis);
        await sendMessage(chat_id, followup.text, followup.keyboard);

        res.status(200).json({ ok: true });
        return;
      }

      // не текст и не фото
      await sendMessage(chat_id, `Пришли, пожалуйста, фото блюда 📸`);
      res.status(200).json({ ok: true });
      return;
    }

    // ничего из ожидаемого не пришло
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('handler error', e);
    // всегда 200, чтобы TG не долбил ретраями
    res.status(200).json({ ok: true });
  }
};

// -------------------- helpers: transport --------------------
async function readJsonBody(req) {
  try {
    if (req.body) {
      if (typeof req.body === 'string') return JSON.parse(req.body);
      if (typeof req.body === 'object') return req.body;
    }
    // дочитать поток (на всякий случай)
    const raw = await readStream(req);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('readJsonBody error', e);
    return null;
  }
}
function readStream(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(null));
  });
}
function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}
async function safeFetch(url, opts) {
  try {
    const r = await fetch(url, opts);
    const text = await r.text().catch(() => '');
    if (!r.ok) console.error('fetch not ok', { url, status: r.status, text });
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    console.error('fetch error', { url, e });
    return { ok: false, status: 0, text: String(e) };
  }
}
async function sendMessage(chat_id, text, replyMarkup) {
  if (!TG_API) return;
  const body = { chat_id, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await safeFetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body)
  });
}
async function answerCallbackQuery(id) {
  if (!TG_API) return;
  await safeFetch(`${TG_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: jsonHeaders(),
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------------------- OpenAI Vision --------------------
async function analyzeImageWithOpenAI(imageUrl) {
  try {
    const systemPrompt = `
Ты – диетологический ассистент. На входе одно фото блюда.
Оцени ориентировочно калории и макросы на привычную порцию. Советы дай кратко (но не показывай их, это по запросу).
Если фото
