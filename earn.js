const crypto = require("crypto");

// Порядок сегментов ДОЛЖЕН совпадать с фронтом (SEG в TraderApp.jsx).
const WHEEL = [
  { type: "disc", pct: 5 },
  { type: "disc", pct: 10 },
  { type: "spin" },
  { type: "disc", pct: 15 },
  { type: "signal" },
  { type: "disc", pct: 20 },
  { type: "disc", pct: 10 },
  { type: "disc", pct: 30 },
];

const QUESTS = {
  daily:   { pts: 10, spin: true, daily: true },
  link:    { pts: 50 },                 // ввод BingX-UID (Этап 4 — авто-сверка партнёркой)
  invite:  { pts: 100 },                // рефералы (позже)
  journal: { pts: 30 },                 // 3 сделки в дневнике (позже — серверный дневник)
  bingx:   { pts: 200, locked: true },  // только авто-зачёт после регистрации (Этап 4)
};

// Прокрутка колеса: 1 бесплатная в день + бонусные. Сегмент выбирает СЕРВЕР.
async function doSpin(pool, ensureUser, tg) {
  await ensureUser(tg);
  const { rows } = await pool.query(
    `SELECT points, best_discount, bonus_spins,
            (last_spin IS NULL OR last_spin < CURRENT_DATE) AS can_daily
     FROM users WHERE id = $1`,
    [tg.id]
  );
  const u = rows[0];
  const canDaily = !!u.can_daily;
  const bonus = u.bonus_spins || 0;
  if (!canDaily && bonus <= 0) {
    return { ok: false, reason: "no_spins", points: u.points || 0, bonusSpins: 0, canSpinToday: false, spinsLeft: 0, bestDiscount: u.best_discount || 0 };
  }
  const idx = crypto.randomInt(WHEEL.length);
  const seg = WHEEL[idx];
  // сначала тратим дневную, иначе — бонусную; приз "spin" добавляет бонусную
  const newBonus = Math.max(0, bonus - (canDaily ? 0 : 1) + (seg.type === "spin" ? 1 : 0));
  const newBest = seg.type === "disc" ? Math.max(u.best_discount || 0, seg.pct) : (u.best_discount || 0);
  await pool.query(
    `UPDATE users SET bonus_spins = $2, best_discount = $3${canDaily ? ", last_spin = CURRENT_DATE" : ""} WHERE id = $1`,
    [tg.id, newBonus, newBest]
  );
  return {
    ok: true,
    index: idx,
    prize: { type: seg.type, pct: seg.pct || 0 },
    points: u.points || 0,
    bestDiscount: newBest,
    bonusSpins: newBonus,
    canSpinToday: false,
    spinsLeft: newBonus,
  };
}

// Выполнить задание. daily — раз в день; остальные — один раз (идемпотентно).
async function doQuest(pool, ensureUser, tg, id, uid) {
  const q = QUESTS[id];
  if (!q) return { ok: false, reason: "unknown" };
  if (q.locked) return { ok: false, reason: "locked", message: "Засчитается автоматически после регистрации на BingX." };
  await ensureUser(tg);
  const { rows } = await pool.query(
    `SELECT points, bonus_spins, completed_quests,
            (last_daily IS NULL OR last_daily < CURRENT_DATE) AS can_daily
     FROM users WHERE id = $1`,
    [tg.id]
  );
  const u = rows[0];
  const newBonus = (u.bonus_spins || 0) + (q.spin ? 1 : 0);

  if (q.daily) {
    if (!u.can_daily) return { ok: false, reason: "daily_done", points: u.points || 0, bonusSpins: u.bonus_spins || 0 };
    await pool.query(`UPDATE users SET points = points + $2, last_daily = CURRENT_DATE, bonus_spins = $3 WHERE id = $1`, [tg.id, q.pts, newBonus]);
    return { ok: true, points: (u.points || 0) + q.pts, bonusSpins: newBonus, daily: true };
  }

  const done = u.completed_quests || [];
  if (done.includes(id)) return { ok: false, reason: "done", points: u.points || 0 };
  const newDone = [...done, id];
  const cleanUid = id === "link" && uid ? String(uid).slice(0, 64) : null;
  if (cleanUid) {
    await pool.query(`UPDATE users SET points = points + $2, completed_quests = $3::jsonb, bonus_spins = $4, bingx_uid = $5 WHERE id = $1`, [tg.id, q.pts, JSON.stringify(newDone), newBonus, cleanUid]);
  } else {
    await pool.query(`UPDATE users SET points = points + $2, completed_quests = $3::jsonb, bonus_spins = $4 WHERE id = $1`, [tg.id, q.pts, JSON.stringify(newDone), newBonus]);
  }
  return { ok: true, points: (u.points || 0) + q.pts, completedQuests: newDone, bonusSpins: newBonus };
}

module.exports = { WHEEL, QUESTS, doSpin, doQuest };
