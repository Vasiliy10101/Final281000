const crypto = require("crypto");
const referral = require("./referral");

// Фабрика бота. Зависимости передаются снаружи, чтобы модуль был тестируемым.
function makeBot({ pool, botToken, adminIds, publicUrl }) {
  const API = botToken ? `https://api.telegram.org/bot${botToken}` : "";
  // Секрет для проверки входящих вебхуков (Telegram шлёт его в заголовке).
  const secret =
    process.env.WEBHOOK_SECRET ||
    (botToken ? crypto.createHash("sha256").update(botToken).digest("hex").slice(0, 32) : crypto.randomBytes(32).toString("hex"));

  async function tg(method, body) {
    if (!API) return { ok: false, error: "no_token" };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), method === 'getUpdates' ? 60000 : 10000);
    try { const r = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await r.json(); } finally { clearTimeout(timer); }
  }

  function send(chatId, text, extra = {}) {
    return tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  }

  function isAdmin(id) {
    return adminIds.includes(Number(id));
  }

  async function stats() {
    if (!pool) return "База не подключена.";
    const a = await pool.query(`SELECT count(*)::int AS total FROM users`);
    return `👥 Пользователей: ${a.rows[0].total}`;
  }

  const HELP =
    "Команды администратора:\n" +
    "<code>/stats</code> — статистика\n\n" +
    "Для всех:\n<code>/myid</code> — узнать свой Telegram ID";

  async function handleUpdate(update) {
    const msg = update && update.message;
    if (!msg || !msg.text) return;
    const fromId = msg.from && msg.from.id;
    const chatId = msg.chat && msg.chat.id;
    const parts = msg.text.trim().split(/\s+/);
    const base = parts[0].split("@")[0].toLowerCase(); // убираем @botname у команды
    const arg = parts.slice(1).join(" ").trim();

    if (base === "/start") {
      if (pool && msg.from) {
        try {
          const ins = await pool.query(
            `INSERT INTO users (id, first_name, username) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO UPDATE SET first_name=EXCLUDED.first_name, username=EXCLUDED.username
             RETURNING (xmax = 0) AS inserted`,
            [msg.from.id, msg.from.first_name || "", msg.from.username || null]
          );
          const isNew = !!(ins.rows[0] && ins.rows[0].inserted);
          const inviter = referral.parseRef(arg);
          if (isNew && inviter) await referral.creditJoin(pool, msg.from.id, inviter);
        } catch (e) { console.error("start_ref", e.message); }
      }
      const canOpen = msg.chat?.type === 'private' && /^https:\/\/[^\s]+$/.test(publicUrl || '');
      return send(chatId, "Бот сообщества. Открой приложение кнопкой ниже или через меню. Команда <code>/myid</code> покажет твой ID.", canOpen ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: publicUrl } }]] } } : {});
    }
    if (base === "/myid") {
      return send(chatId, `Твой Telegram ID: <code>${fromId}</code>`);
    }
    if (base === "/help") {
      if (!isAdmin(fromId)) return send(chatId, "Доступно: <code>/myid</code>");
      return send(chatId, HELP);
    }

    // дальше — только админ
    const adminCmds = ["/stats"];
    if (adminCmds.includes(base)) {
      if (!isAdmin(fromId)) return send(chatId, "Команда доступна только администратору.");
      if (base === "/stats") return send(chatId, await stats());
    }
    // неизвестные команды игнорируем молча
  }

  async function setupWebhook() {
    if (!botToken) { console.log("BOT: BOT_TOKEN не задан — бот выключен."); return { ok: false, reason: "no_token" }; }
    if (!publicUrl) { console.log("BOT: публичный URL неизвестен — вебхук не установлен. Задай переменную PUBLIC_URL."); return { ok: false, reason: "no_url" }; }
    const url = `${publicUrl}/api/tg/webhook`;
    const res = await tg("setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
    console.log("BOT: setWebhook ->", url, JSON.stringify(res));
    return res;
  }

  // Long-polling: бот сам забирает апдейты у Telegram. Не нужен публичный URL/вебхук.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function startPolling() {
    if (!botToken) { console.log("BOT: BOT_TOKEN не задан — бот выключен."); return; }
    // снимаем вебхук, иначе getUpdates вернёт 409
    try { await tg("deleteWebhook", { drop_pending_updates: false }); } catch (e) {}
    console.log("BOT: long-polling запущен");
    let offset = 0;
    // бесконечный цикл опроса; ошибки не роняют процесс
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
        if (res && res.ok && Array.isArray(res.result)) {
          if (res.result.length === 0) { await sleep(800); }
          for (const u of res.result) {
            offset = u.update_id + 1;
            try { await handleUpdate(u); } catch (e) { console.error("BOT update failed:", e.message); }
          }
        } else if (res && res.error_code === 409) {
          // вебхук всё ещё активен — снимаем и ждём
          try { await tg("deleteWebhook", {}); } catch (e) {}
          await sleep(2000);
        } else if (res && res.ok === false) {
          console.error("BOT getUpdates:", JSON.stringify(res));
          await sleep(3000);
        }
      } catch (e) {
        console.error("BOT getUpdates failed:", e.message);
        await sleep(3000);
      }
    }
  }

  async function fetchUsername() {
    if (!botToken) return "";
    try { const r = await tg("getMe", {}); return (r && r.ok && r.result && r.result.username) ? r.result.username : ""; }
    catch (e) { return ""; }
  }

  return { handleUpdate, setupWebhook, startPolling, fetchUsername, secret, isAdmin };
}

module.exports = { makeBot };
