// Дневник трейдера: серверная логика (чистые функции, тестируемые с мок-пулом).

const SIDES = ["long", "short"];
const EMOTIONS = ["calm", "fear", "greed", "tilt"]; // спокойствие / страх / жадность / тильт

function num(v) {
  if (!['number','string'].includes(typeof v) || String(v).trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// P&L в котируемой валюте: long = (exit-entry)*size, short = (entry-exit)*size
function pnlOf(t) {
  const d = t.side === "short" ? t.entry - t.exit : t.exit - t.entry;
  const value = d * t.size;
  return Math.abs(value) < Number.MAX_SAFE_INTEGER / 1e8 ? Math.round(value * 1e8) / 1e8 : value;
}

function rowToTrade(r) {
  const t = {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    entry: Number(r.entry),
    exit: Number(r.exit),
    size: Number(r.size),
    emotion: r.emotion || null,
    note: r.note || "",
    thesis: r.thesis || "",
    lesson: r.lesson || "",
    ts: r.ts,
  };
  t.pnl = pnlOf(t);
  return t;
}

async function addTrade(pool, ensureUser, tg, body) {
  await ensureUser(tg);
  const symbol = String((body && body.symbol) || "").trim().toUpperCase();
  const side = String((body && body.side) || "").toLowerCase();
  const entry = num(body && body.entry);
  const exit = num(body && body.exit);
  const size = num(body && body.size);
  let emotion = body && body.emotion ? String(body.emotion).toLowerCase() : null;
  if (emotion && !EMOTIONS.includes(emotion)) emotion = null;
  const note = String((body && body.note) || "").slice(0, 280);

  const thesis = typeof body?.thesis === "string" ? body.thesis.trim() : "";
  const lesson = typeof body?.lesson === "string" ? body.lesson.trim() : "";
  if (thesis.length > 1000 || lesson.length > 1000) return { ok: false, reason: "review_too_long" };

  if (!/^[A-Z0-9]{1,15}-USDT$/.test(symbol)) return { ok: false, reason: "bad_symbol" };
  if (!SIDES.includes(side)) return { ok: false, reason: "bad_side" };
  if (!(entry > 0) || !(exit > 0) || !(size > 0)) return { ok: false, reason: "bad_numbers" };
  if (!Number.isFinite((exit-entry)*size) || !Number.isFinite(entry*size)) return { ok: false, reason: "bad_numbers" };
  const clientId = body?.clientId ?? null;
  if (clientId !== null && (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(clientId))) return { ok: false, reason: 'bad_client_id' };

  const { rows } = await pool.query(
    `INSERT INTO journal (user_id, symbol, side, entry, exit, size, emotion, note, thesis, lesson, client_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (user_id,client_id) DO NOTHING
     RETURNING id, symbol, side, entry, exit, size, emotion, note, thesis, lesson, ts`,
    [tg.id, symbol, side, entry, exit, size, emotion, note, thesis, lesson, clientId]
  );
  if (!rows.length && clientId) {
    const existing = await pool.query('SELECT id,symbol,side,entry,exit,size,emotion,note,thesis,lesson,ts FROM journal WHERE user_id=$1 AND client_id=$2',[tg.id,clientId]);
    if (!existing.rows.length) return { ok:false, reason:'retry_save' };
    const trade = rowToTrade(existing.rows[0]);
    if (trade.symbol!==symbol || trade.side!==side || trade.entry!==entry || trade.exit!==exit || trade.size!==size || trade.emotion!==emotion || trade.note!==note || trade.thesis!==thesis || trade.lesson!==lesson) return {ok:false,reason:'idempotency_conflict'};
    return {ok:true,trade,replayed:true};
  }
  return { ok: true, trade: rowToTrade(rows[0]) };
}

async function listTrades(pool, ensureUser, tg) {
  await ensureUser(tg);
  const { rows } = await pool.query(
    `SELECT id, symbol, side, entry, exit, size, emotion, note, thesis, lesson, ts
     FROM journal WHERE user_id = $1 ORDER BY ts DESC, id DESC LIMIT 501`,
    [tg.id]
  );
  // Fetch the newest records; the extra row signals that this is a bounded window.
  return { ok: true, trades: rows.slice(0, 500).reverse().map(rowToTrade), hasMore: rows.length > 500 };
}

async function deleteTrade(pool, ensureUser, tg, id) {
  await ensureUser(tg);
  const tid = num(id);
  if (!Number.isSafeInteger(tid) || tid <= 0) return { ok: false, reason: "bad_id" };
  const r = await pool.query(`DELETE FROM journal WHERE id = $1 AND user_id = $2 RETURNING id`, [tid, tg.id]);
  return { ok: r.rowCount > 0 };
}

module.exports = { SIDES, EMOTIONS, pnlOf, addTrade, listTrades, deleteTrade };
