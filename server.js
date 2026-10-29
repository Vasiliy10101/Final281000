const express = require("express");
const path = require("path");
const { createChannelAccess } = require("./channel-access");
const channelConfig = require("./channel-config.json");
const { createRadar } = require("./radar");
const { createPumpDumpFeed } = require("./pump-dump-feed");
const { createNews } = require("./news");
const earn = require("./earn");
const journal = require("./journal");
const referral = require("./referral");
const { createCommunityCounter, createProfileService } = require("./profile");
const { createMarketProxy } = require("./market-proxy");
const { createUserState } = require("./user-state");
const { communitySummary } = require("./community-stats");

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const BOT_MODE = process.env.BOT_MODE || "polling";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map((s) => Number(s.trim())).filter(Boolean);
let PUBLIC_URL = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || "";
if (PUBLIC_URL && !/^https?:\/\//.test(PUBLIC_URL)) PUBLIC_URL = "https://" + PUBLIC_URL;
PUBLIC_URL = PUBLIC_URL.replace(/\/$/, "");
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");

/* ---------- База (Postgres): без неё личные записи недоступны; проверка подписки обязательна ---------- */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
  });
  pool.on("error", (e) => console.error("pg pool error:", e.message));
}

const { makeBot } = require("./bot");
const bot = makeBot({ pool, botToken: BOT_TOKEN, adminIds: ADMIN_IDS, publicUrl: PUBLIC_URL });

/* ---------- Радар: рыночные данные и новости внутри приложения ---------- */
const news = createNews();
const radar = createRadar({ news });
async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      points INTEGER DEFAULT 0,
      last_spin DATE,
      bonus_spins INTEGER DEFAULT 0,
      last_daily DATE,
      best_discount INTEGER DEFAULT 0,
      completed_quests JSONB DEFAULT '[]'::jsonb,
      bingx_uid TEXT,
      bingx_verified BOOLEAN DEFAULT FALSE,
      referred_by BIGINT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS journal (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      entry DOUBLE PRECISION NOT NULL,
      exit DOUBLE PRECISION NOT NULL,
      size DOUBLE PRECISION NOT NULL,
      emotion TEXT,
      note TEXT,
      ts TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS journal_user_idx ON journal(user_id)`);
  await pool.query('ALTER TABLE journal ADD COLUMN IF NOT EXISTS client_id TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS journal_user_client_idx ON journal(user_id,client_id)');
  // миграции для уже существующих баз (безопасно, если колонки уже есть)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_spins INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily DATE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS users_ref_idx ON users(referred_by)`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS app_first_seen_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ');
  await pool.query('CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users(last_seen_at)');
  await pool.query("ALTER TABLE journal ADD COLUMN IF NOT EXISTS thesis TEXT DEFAULT ''");
  await pool.query("ALTER TABLE journal ADD COLUMN IF NOT EXISTS lesson TEXT DEFAULT ''");
  await pool.query('CREATE TABLE IF NOT EXISTS member_reflections (user_id BIGINT NOT NULL REFERENCES users(id),week_start DATE NOT NULL,body TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(user_id,week_start))');
  await pool.query('CREATE TABLE IF NOT EXISTS member_summaries (user_id BIGINT PRIMARY KEY REFERENCES users(id),body TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now())');
  await pool.query("CREATE TABLE IF NOT EXISTS member_awards (user_id BIGINT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK (kind IN ('helper','mentor')),granted_by BIGINT NOT NULL,granted_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(user_id,kind))");
  await pool.query('CREATE TABLE IF NOT EXISTS user_state (user_id BIGINT NOT NULL REFERENCES users(id),state_key TEXT NOT NULL,value JSONB NOT NULL,revision INTEGER NOT NULL DEFAULT 1,last_operation TEXT NOT NULL,updated_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(user_id,state_key))');
  console.log("DB ready");
}

/* ---------- Доступ: личность Telegram и подписка на канал ---------- */
const channelAccess = createChannelAccess({
  botToken: BOT_TOKEN,
  channelId: process.env.CHANNEL_ID || channelConfig.channel_id,
  channelUrl: process.env.CHANNEL_URL || channelConfig.channel_url,
});
app.use("/api", channelAccess.requireMember);
app.post("/api/access", (req, res) => res.json({ ok: true, userId: req.tgUser.id }));

/* ---------- Пользователь: создание и обновление профиля ---------- */
async function getOrCreateUser(tgUser) {
  if (!pool) {
    // Без БД: отдаём имя и значения по умолчанию (без сохранения).
    return { name: tgUser.first_name || "трейдер", points: 0, completedQuests: [], canSpinToday: true, bestDiscount: 0, dbless: true };
  }
  const ins = await pool.query(
    `INSERT INTO users (id, first_name, username, app_first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (id) DO UPDATE SET first_name = EXCLUDED.first_name, username = EXCLUDED.username, app_first_seen_at = COALESCE(users.app_first_seen_at, now()), last_seen_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [tgUser.id, tgUser.first_name, tgUser.username]
  );
  const isNew = !!(ins.rows[0] && ins.rows[0].inserted);
  // реферал: засчитываем ТОЛЬКО при первом входе нового пользователя
  if (isNew && tgUser.startParam) {
    try { await referral.creditJoin(pool, tgUser.id, referral.parseRef(tgUser.startParam)); } catch (e) { console.error("ref_join", e.message); }
  }
  const { rows } = await pool.query(
    `SELECT first_name, points, best_discount, completed_quests, bonus_spins, app_first_seen_at,
            (last_spin IS NULL OR last_spin < CURRENT_DATE) AS can_spin,
            (last_daily IS NOT NULL AND last_daily >= CURRENT_DATE) AS daily_done
     FROM users WHERE id = $1`,
    [tgUser.id]
  );
  const u = rows[0];
  const can = !!u.can_spin;
  const bonus = u.bonus_spins || 0;
  let refs = { count: 0 };
  try { refs = await referral.stats(pool, tgUser.id); } catch (e) {}
  return {
    name: u.first_name || "трейдер",
    points: u.points || 0,
    completedQuests: u.completed_quests || [],
    canSpinToday: can,
    bonusSpins: bonus,
    spinsLeft: (can ? 1 : 0) + bonus,
    dailyDone: !!u.daily_done,
    bestDiscount: u.best_discount || 0,
    referrals: refs.count || 0,
    refReward: referral.REF_POINTS,
    refLink: BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=ref${tgUser.id}` : "",
    since: u.app_first_seen_at || null,
  };
}

/* Personal memory is always owned by the verified Telegram identity. */
const userState = createUserState({pool,ensureUser:getOrCreateUser});
app.get('/api/user-state',async(req,res)=>{try{const result=await userState.get(req.tgUser);res.status(result.ok?200:503).json(result);}catch(e){console.error('state_read',e.message);res.status(503).json({ok:false,reason:'state_unavailable'});}});
app.put('/api/user-state',async(req,res)=>{try{const result=await userState.put(req.tgUser,req.body);res.status(result.ok?200:result.reason==='state_conflict'?409:result.reason==='no_db'?503:400).json(result);}catch(e){console.error('state_write',e.message);res.status(503).json({ok:false,reason:'state_unavailable'});}});

app.get('/api/community/summary',async(req,res)=>{if(!ADMIN_IDS.includes(req.tgUser.id))return res.status(403).json({ok:false,reason:'admin_required'});try{const result=await communitySummary(pool);res.status(result.ok?200:503).json(result);}catch(e){console.error('community_summary',e.message);res.status(503).json({ok:false,reason:'summary_unavailable'});}});
/* ---------- API: мой профиль ---------- */
app.post("/api/me", async (req, res) => {
  const tgUser = req.tgUser;
  if (!tgUser) {
    // Нет подтверждённой личности Telegram
    return res.status(401).json({ ok: false, reason: "auth", user: { name: "трейдер", points: 0, completedQuests: [], canSpinToday: true, bonusSpins: 0, spinsLeft: 1, dailyDone: false, bestDiscount: 0, referrals: 0, refReward: 100, refLink: "" } });
  }
  try {
    const user = await getOrCreateUser(tgUser);
    res.json({ ok: true, user });
  } catch (e) {
    console.error("me_failed", e.message);
    res.json({ ok: false, guest: true, user: { name: tgUser.first_name || "трейдер", points: 0, completedQuests: [], canSpinToday: true, bonusSpins: 0, spinsLeft: 1, dailyDone: false, bestDiscount: 0, referrals: 0, refReward: 100, refLink: "" } });
  }
});

/* ---------- Профиль участника и сообщество ---------- */
const communityCounter = createCommunityCounter({ botToken: BOT_TOKEN, channelId: process.env.CHANNEL_ID || channelConfig.channel_id });
const profiles = createProfileService({ pool, ensureUser: getOrCreateUser, counter: communityCounter, channelUrl: channelAccess.joinUrl, adminIds: ADMIN_IDS });
app.post("/api/profile", async (req, res) => {
  try { res.json(await profiles.get(req.tgUser)); }
  catch (e) { console.error("profile_failed", e.message); res.status(500).json({ ok: false, reason: "profile_unavailable" }); }
});
app.post("/api/profile/reflection", async (req, res) => {
  try { const result = await profiles.saveReflection(req.tgUser, req.body); res.status(result.ok ? 200 : result.reason === "reflection_conflict" ? 409 : 400).json(result); }
  catch (e) { console.error("reflection_failed", e.message); res.status(500).json({ ok: false, reason: "save_failed" }); }
});
app.post("/api/profile/award", async (req, res) => {
  if (!ADMIN_IDS.includes(req.tgUser.id)) return res.status(403).json({ ok: false, reason: "admin_required" });
  try { const result = await profiles.award(req.tgUser, req.body); res.status(result.ok ? 200 : 400).json(result); }
  catch (e) { console.error("award_failed", e.message); res.status(500).json({ ok: false, reason: "save_failed" }); }
});

/* ---------- API: прокрутка колеса (1/день + бонусные) ---------- */
app.post("/api/spin", async (req, res) => {
  if (process.env.LEGACY_EARN_ENABLED !== "1") return res.status(410).json({ ok: false, reason: "feature_removed" });
  const tg = req.tgUser;
  if (!tg) return res.status(401).json({ ok: false, reason: "auth" });
  if (!pool) return res.json({ ok: false, reason: "no_db" });
  try {
    res.json(await earn.doSpin(pool, getOrCreateUser, tg));
  } catch (e) {
    console.error("spin_failed", e.message);
    res.status(500).json({ ok: false, reason: "error" });
  }
});

/* ---------- API: выполнить задание ---------- */
app.post("/api/quest", async (req, res) => {
  if (process.env.LEGACY_EARN_ENABLED !== "1") return res.status(410).json({ ok: false, reason: "feature_removed" });
  const tg = req.tgUser;
  if (!tg) return res.status(401).json({ ok: false, reason: "auth" });
  if (!pool) return res.json({ ok: false, reason: "no_db" });
  const id = String((req.body && req.body.id) || "");
  const uid = req.body && req.body.uid;
  try {
    res.json(await earn.doQuest(pool, getOrCreateUser, tg, id, uid));
  } catch (e) {
    console.error("quest_failed", e.message);
    res.status(500).json({ ok: false, reason: "error" });
  }
});

/* ---------- API: дневник трейдера ---------- */
app.post("/api/journal/list", async (req, res) => {
  const tg = req.tgUser;
  if (!tg) return res.status(401).json({ ok: false, reason: "auth", trades: [] });
  if (!pool) return res.json({ ok: false, reason: "no_db", trades: [] });
  try { res.json(await journal.listTrades(pool, getOrCreateUser, tg)); }
  catch (e) { console.error("journal_list", e.message); res.status(500).json({ ok: false, reason: "error", trades: [] }); }
});
app.post("/api/journal/add", async (req, res) => {
  const tg = req.tgUser;
  if (!tg) return res.status(401).json({ ok: false, reason: "auth" });
  if (!pool) return res.json({ ok: false, reason: "no_db" });
  try { res.json(await journal.addTrade(pool, getOrCreateUser, tg, req.body)); }
  catch (e) { console.error("journal_add", e.message); res.status(500).json({ ok: false, reason: "error" }); }
});
app.post("/api/journal/delete", async (req, res) => {
  const tg = req.tgUser;
  if (!tg) return res.status(401).json({ ok: false, reason: "auth" });
  if (!pool) return res.json({ ok: false, reason: "no_db" });
  try { res.json(await journal.deleteTrade(pool, getOrCreateUser, tg, req.body && req.body.id)); }
  catch (e) { console.error("journal_del", e.message); res.status(500).json({ ok: false, reason: "error" }); }
});

/* ---------- Прокси публичных рыночных данных BingX (без ключа) ---------- */
const market = createMarketProxy({ fetchImpl: fetch });
app.get("/api/bingx", async (req, res) => {
  const result = await market.get(req.query.path, req.query.symbol);
  res.set("cache-control", "no-store");
  res.status(result.status).json(result.body);
});

/* ---------- PUMP DUMP: единая лента исследовательской системы ---------- */
const pumpDumpFeed = createPumpDumpFeed();
app.get("/api/pump-dump", (_req, res) => {
  res.set("cache-control", "no-store");
  res.json(pumpDumpFeed.get());
});

/* ---------- Pump/Dump радар ---------- */
app.get("/api/radar", (req, res) => {
  if (process.env.LEGACY_RADAR_ENABLED !== "1") return res.status(410).json({ ok: false, reason: "legacy_radar_disabled" });
  const data = radar.getRadar({
    mode: String(req.query.mode || "medium"),
    dir: String(req.query.dir || "all"),
    minVol: Number(req.query.minVol || 0),
    limit: Number(req.query.limit || 50),
  });
  res.set("cache-control", "no-store");
  res.json(data);
});

/* ---------- Telegram-бот: вебхук + админ-команды ---------- */
app.post("/api/tg/webhook", async (req, res) => {
  if (req.get("x-telegram-bot-api-secret-token") !== bot.secret) return res.sendStatus(401);
  if (BOT_MODE !== "webhook") return res.status(409).json({ error: "webhook_mode_required" });
  res.sendStatus(200); // быстрый ответ Telegram, обработка — асинхронно
  try { await bot.handleUpdate(req.body); } catch (e) { console.error("tg update failed:", e.message); }
});
app.get("/api/tg/setup", async (req, res) => {
  if (req.query.key !== bot.secret) return res.status(401).json({ error: "bad_key" });
  if (BOT_MODE !== "webhook") return res.status(409).json({ error: "webhook_mode_required" });
  try { res.json(await bot.setupWebhook()); } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- Статика мини-аппа ---------- */
app.use("/api", (_req, res) => res.status(404).json({ ok: false, reason: "api_not_found" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  },
}));
app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  if (!["polling", "webhook", "off"].includes(BOT_MODE)) throw Error("Invalid BOT_MODE");
  await initDb(); // Never accept requests against a partially migrated database.
  return app.listen(PORT, () => {
    console.log("Trader app on :" + PORT);
    if (!BOT_USERNAME) bot.fetchUsername().then(name => { BOT_USERNAME = name; }).catch(() => {});
    console.log("CONFIG:", JSON.stringify({ db: !!pool, botToken: !!BOT_TOKEN, botMode: BOT_MODE, admins: ADMIN_IDS.length, publicUrl: PUBLIC_URL || "(none)" }));
    if (process.env.LEGACY_RADAR_ENABLED === "1") radar.start();
    if (BOT_MODE === "polling") bot.startPolling().catch((e) => console.error("bot polling failed:", e.message));
  });
}
if (typeof module !== "undefined") {
  module.exports = { app, start, initDb };
  if (require.main === module) start().catch(error => { console.error("Startup failed:", error.message); process.exit(1); });
}
