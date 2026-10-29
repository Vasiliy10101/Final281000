// Реферальная система: серверная логика (идемпотентная, защищённая от накрутки).

const REF_POINTS = 100;     // инвайтеру за каждого приглашённого, кто реально зашёл
const REF_SPINS = 1;        // + бонусная прокрутка инвайтеру

// start-параметр вида "ref123456789" -> id инвайтера (число) либо null
function parseRef(startParam) {
  if (!startParam) return null;
  const m = String(startParam).match(/^ref(\d{1,20})$/);
  const id=m?Number(m[1]):NaN;
  return Number.isSafeInteger(id)&&id>0?id:null;
}

// Зачесть приглашение при ПЕРВОМ входе нового пользователя.
// Идемпотентно: referred_by ставится только один раз и только если != сам.
async function creditJoin(pool, userId, inviterId) {
  if (!pool || !Number.isSafeInteger(Number(inviterId)) || Number(inviterId)<=0 || !Number.isSafeInteger(Number(userId)) || Number(userId)<=0) return { ok: false, reason: "no_inviter" };
  const inv = Number(inviterId);
  if (inv === Number(userId)) return { ok: false, reason: "self" };
  // One statement makes attribution and credit atomic, including failures/retries.
  const credited = await pool.query(`WITH linked AS (
    UPDATE users SET referred_by=$1 WHERE id=$2 AND referred_by IS NULL AND id<>$1
      AND EXISTS (SELECT 1 FROM users inviter WHERE inviter.id=$1) RETURNING id
    ) UPDATE users SET points=COALESCE(points,0)+$3,bonus_spins=COALESCE(bonus_spins,0)+$4
      WHERE id=$1 AND EXISTS (SELECT 1 FROM linked) RETURNING id`,[inv,Number(userId),REF_POINTS,REF_SPINS]);
  if (!credited.rows.length) return { ok:false,reason:'not_credited' };
  return { ok: true, credited: true };
}

async function stats(pool, userId) {
  if (!pool) return { count: 0 };
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE referred_by = $1`, [userId]);
  return { count: rows[0] ? rows[0].c : 0 };
}

module.exports = { REF_POINTS, REF_SPINS, parseRef, creditJoin, stats };
