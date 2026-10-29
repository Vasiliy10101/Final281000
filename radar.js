"use strict";
/*
 * Радар-движок: кросс-биржевой сканер + анализ.
 * Биржи: BingX, MEXC, Bybit (перпы-USDT).
 *
 * Слои:
 *  1) Сканер: % чистого хода (свежий рывок + 5-мин окно) по всем парам.
 *  2) Кросс-биржа: ход на >=2 биржах + малый спред → "Подтверждён";
 *     иначе → "Локальный вынос (риск возврата)". + RVOL из свечей.
 *  3) Нормировка по своей волатильности: ход меряем "во сколько раз сильнее
 *     обычного" (z по 1-мин доходностям). Режимы строгости: strict/medium/soft.
 *  4) Катализатор: новости (через news.catalystFor) — news(N) либо none.
 *
 * Это ДЕТЕКТОР-ПРЕДУПРЕЖДЕНИЕ, не сигнал и не финсовет.
 * Чистая логика вынесена в _pure и тестируется без сети.
 */

const EXCHANGES = ["bingx", "mexc", "bybit"];
const STABLES = new Set(["USDT","USDC","USDD","TUSD","DAI","FDUSD","USDE","BUSD","USD","EUR","USTC"]);

function num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }
function nowMs(){ return Date.now(); }

/* ---------- нормализация символов → базовый тикер (только USDT-перпы) ---------- */
function normBase(ex, sym){
  if(!sym) return null;
  const s = String(sym).toUpperCase();
  if(ex === "bingx"){ if(!s.endsWith("-USDT")) return null; return s.slice(0, -5); }
  if(ex === "mexc"){ if(!s.endsWith("_USDT")) return null; return s.slice(0, -5); }
  if(ex === "bybit"){ if(!s.endsWith("USDT")) return null; return s.slice(0, -4); }
  return null;
}
function exSymbol(ex, base){
  if(ex === "bingx") return base + "-USDT";
  if(ex === "mexc") return base + "_USDT";
  if(ex === "bybit") return base + "USDT";
  return base;
}

/* ---------- чистая аналитика ---------- */
function pctSpread(prices){
  const v = prices.filter((p) => p > 0);
  if(v.length < 2) return 0;
  const mn = Math.min.apply(null, v), mx = Math.max.apply(null, v);
  return mn > 0 ? (mx - mn) / mn * 100 : 0;
}
// RVOL = объём последней свечи / средний объём предыдущих.
function rvolFrom(vols){
  if(!vols || vols.length < 6) return null;
  const last = vols[vols.length - 1];
  const prev = vols.slice(0, -1);
  const avg = prev.reduce((s, v) => s + v, 0) / prev.length;
  return avg > 0 ? last / avg : null;
}
// Обычный 1-мин размах монеты (%, stdev доходностей) — её собственная волатильность.
function vol1mFrom(closes){
  if(!closes || closes.length < 6) return null;
  const r = [];
  for(let i = 1; i < closes.length; i++){ if(closes[i - 1] > 0) r.push((closes[i] - closes[i - 1]) / closes[i - 1] * 100); }
  if(r.length < 5) return null;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const v = r.reduce((s, x) => s + (x - m) * (x - m), 0) / r.length;
  return Math.sqrt(v);
}
// Аномальность: во сколько раз ход сильнее обычного для этой монеты.
function anomalyScore(move, vol1m){
  if(vol1m == null || vol1m <= 0.01) return null;
  return Math.abs(move) / vol1m;
}
// Дискретная "сила" 1..3 для индикатора (без чисел для пользователя).
function strengthFrom(anom){ if(anom == null) return 1; if(anom >= 4.5) return 3; if(anom >= 3) return 2; return 1; }
// Порог режима строгости (по аномальности относительно своей волатильности).
function modeThreshold(mode){ if(mode === "strict") return 4.5; if(mode === "soft") return 2.0; return 3.0; }
// Порог-floor по голому % (чтобы не ловить копеечный шум) — широкий, фильтрует режим.
function rawFloor(){ return 1.0; }

// Анализ одной базы по всем биржам, где она есть.
// byEx: { bingx:{price,move,vol24,rvol,anom}, ... }
function analyzeBase(base, byEx, opts){
  opts = opts || {};
  if(STABLES.has(base)) return null;
  const exs = Object.keys(byEx);
  if(!exs.length) return null;
  const thr = opts.threshold != null ? opts.threshold : rawFloor();
  const spreadOk = opts.spreadOk != null ? opts.spreadOk : 0.5;
  let up = 0, down = 0, maxAbs = 0, dirSign = 0;
  exs.forEach((e) => {
    const m = num(byEx[e].move);
    if(m >= thr) up++; else if(m <= -thr) down++;
    if(Math.abs(m) > maxAbs){ maxAbs = Math.abs(m); dirSign = m >= 0 ? 1 : -1; }
  });
  if(maxAbs < thr) return null;
  const dir = dirSign > 0 ? "pump" : "dump";
  const movedExs = exs.filter((e) => dirSign > 0 ? num(byEx[e].move) >= thr : num(byEx[e].move) <= -thr);
  if(!movedExs.length) return null;
  const prices = exs.map((e) => num(byEx[e].price)).filter((p) => p > 0);
  const spread = pctSpread(prices);
  const rvol = Math.max.apply(null, [0].concat(movedExs.map((e) => num(byEx[e].rvol))));
  const vol24 = exs.reduce((s, e) => s + num(byEx[e].vol24), 0);
  // аномальность — максимум среди двинувшихся бирж (может быть null, если нет свечей)
  let anom = null;
  movedExs.forEach((e) => { const a = byEx[e].anom; if(a != null && (anom == null || a > anom)) anom = a; });
  const verdict = (movedExs.length >= 2 && spread <= spreadOk) ? "confirmed" : "local";
  let score = maxAbs * 5 + (anom != null ? Math.min(40, anom * 6) : 0) + (verdict === "confirmed" ? 18 : 0) + Math.min(14, rvol * 3);
  score = Math.max(0, Math.min(100, score));
  return {
    base: base, dir: dir,
    move: Number(maxAbs.toFixed(2)),
    spread: Number(spread.toFixed(2)),
    rvol: rvol > 0 ? Number(rvol.toFixed(1)) : null,
    anom: anom != null ? Number(anom.toFixed(2)) : null,
    strength: strengthFrom(anom),
    vol24: Math.round(vol24),
    verdict: verdict,
    movedCount: movedExs.length,
    exCount: exs.length,
    exchanges: exs.map((e) => ({
      ex: e, price: num(byEx[e].price), move: Number(num(byEx[e].move).toFixed(2)),
      vol24: Math.round(num(byEx[e].vol24)), moved: movedExs.indexOf(e) !== -1
    })),
    catalyst: null,
    score: Number(score.toFixed(1)),
    ts: nowMs()
  };
}

// Фильтрация + сортировка по режиму строгости (аномальности).
function rankFilter(items, opts){
  opts = opts || {};
  const minVol = opts.minVol || 0;
  const dir = opts.dir || "all";
  const limit = opts.limit || 30;
  const mode = opts.mode || "medium";
  const thr = modeThreshold(mode);
  let out = (items || []).filter((it) => {
    if(!it || it.vol24 < minVol) return false;
    if(dir === "pump" && it.dir !== "pump") return false;
    if(dir === "dump" && it.dir !== "dump") return false;
    // главный фильтр — аномальность относительно своей волатильности
    if(it.anom != null) return it.anom >= thr;
    return mode === "soft"; // нет данных по волатильности → показываем только в мягком режиме
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// Тип события одним ярлыком (из уже посчитанных сигналов).
function eventType(it){
  if(it.movedCount <= 1 && it.spread >= 1.0) return "divergence";
  if(it.rvol != null && it.rvol >= 3 && it.move < 2.0) return "vol_no_price";
  if(it.catalyst && it.catalyst.type === "news") return it.dir === "pump" ? "news_pump" : "news_dump";
  return it.dir; // "pump" | "dump" (без катализатора)
}
// Звёздный рейтинг доверия 1..3 (без чисел для пользователя).
function starRating(it){
  let s = 0;
  const a = it.anom || 0;
  if(a >= 4.5) s += 3; else if(a >= 3) s += 2; else if(a >= 2) s += 1;
  if(it.verdict === "confirmed") s += 1;
  if(it.rvol != null && it.rvol >= 3) s += 1;
  if(it.catalyst && it.catalyst.type === "news") s += 1;
  if(s >= 5) return 3; if(s >= 2) return 2; return 1;
}
// Кто тащит движение + сколько бирж отстаёт.
function leaderInfo(it){
  let leader = null, mx = -1, laggards = 0;
  (it.exchanges || []).forEach((e) => { if(Math.abs(e.move) > mx){ mx = Math.abs(e.move); leader = e.ex; } if(!e.moved) laggards++; });
  return { leader: leader, laggards: laggards };
}

/* ---------- сеть ---------- */
async function fetchJson(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 8000);
  try{
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if(!r.ok) return null;
    return await r.json();
  }catch(e){ return null; }
  finally{ clearTimeout(t); }
}
async function fetchTickers(ex){
  if(ex === "bingx"){
    const j = await fetchJson("https://open-api.bingx.com/openApi/swap/v2/quote/ticker");
    const arr = (j && j.data) || []; const out = [];
    for(const t of arr){ const b = normBase("bingx", t.symbol); if(!b) continue; out.push({ base: b, price: num(t.lastPrice), vol24: num(t.quoteVolume) }); }
    return out;
  }
  if(ex === "bybit"){
    const j = await fetchJson("https://api.bybit.com/v5/market/tickers?category=linear");
    const arr = (j && j.result && j.result.list) || []; const out = [];
    for(const t of arr){ const b = normBase("bybit", t.symbol); if(!b) continue; out.push({ base: b, price: num(t.lastPrice), vol24: num(t.turnover24h) }); }
    return out;
  }
  if(ex === "mexc"){
    const j = await fetchJson("https://contract.mexc.com/api/v1/contract/ticker");
    const arr = (j && j.data) || []; const out = [];
    for(const t of arr){ const b = normBase("mexc", t.symbol); if(!b) continue; out.push({ base: b, price: num(t.lastPrice), vol24: num(t.amount24) }); }
    return out;
  }
  return [];
}
// 1m-свечи → {vols, closes} (по возрастанию времени).
async function fetchCandles(ex, base){
  try{
    if(ex === "bingx"){
      const j = await fetchJson("https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=" + exSymbol("bingx", base) + "&interval=1m&limit=30");
      const a = ((j && j.data) || []).slice().reverse();
      return { vols: a.map((k) => num(k.volume != null ? k.volume : k[5])), closes: a.map((k) => num(k.close != null ? k.close : k[4])) };
    }
    if(ex === "bybit"){
      const j = await fetchJson("https://api.bybit.com/v5/market/kline?category=linear&symbol=" + exSymbol("bybit", base) + "&interval=1&limit=30");
      const a = ((j && j.result && j.result.list) || []).slice().reverse();
      return { vols: a.map((k) => num(k[5])), closes: a.map((k) => num(k[4])) };
    }
    if(ex === "mexc"){
      const j = await fetchJson("https://contract.mexc.com/api/v1/contract/kline/" + exSymbol("mexc", base) + "?interval=Min1");
      const d = (j && j.data) || {};
      return { vols: Array.isArray(d.vol) ? d.vol.map(num) : [], closes: Array.isArray(d.close) ? d.close.map(num) : [] };
    }
  }catch(e){}
  return { vols: [], closes: [] };
}

/* ---------- движок ---------- */
function createRadar(opts){
  opts = opts || {};
  const intervalMs = opts.intervalMs || 20000;
  const histMs = 6 * 60 * 1000;
  const candThr = rawFloor();
  const maxKlines = opts.maxKlines || 8;
  const spreadOk = opts.spreadOk != null ? opts.spreadOk : 0.5;
  const news = opts.news || null;

  const hist = new Map();
  const track = new Map(); // жизненный цикл ситуации по базе
  let snapshot = {}, results = [], lastRun = 0, running = false, timer = null, warming = true;

  // Обновляет фазу: разогрев → пик → остывает → возврат.
  function updatePhase(it, leaderPrice){
    const k = it.base, mv = it.move, p = leaderPrice, t = nowMs();
    let st = track.get(k);
    if(!st || t - st.lastTs > 15 * 60 * 1000){
      st = { firstTs: t, lastTs: t, peakMove: mv, peakPrice: p, phase: "heating", dir: it.dir };
      track.set(k, st); it.phase = "heating"; return;
    }
    st.lastTs = t;
    if(mv >= st.peakMove * 0.98){
      st.peakMove = mv;
      st.peakPrice = it.dir === "pump" ? Math.max(st.peakPrice, p) : Math.min(st.peakPrice || p, p);
      st.phase = "peak";
    } else {
      let retr = 0;
      if(st.peakPrice > 0) retr = it.dir === "pump" ? (st.peakPrice - p) / st.peakPrice * 100 : (p - st.peakPrice) / st.peakPrice * 100;
      if(retr >= st.peakMove * 0.4) st.phase = "reverting";
      else if(mv < st.peakMove * 0.6) st.phase = "cooling";
      else st.phase = "peak";
    }
    it.phase = st.phase;
  }

  function pushHist(key, p){
    let a = hist.get(key); if(!a){ a = []; hist.set(key, a); }
    const t = nowMs(); a.push({ t: t, p: p });
    const cut = t - histMs; while(a.length && a[0].t < cut) a.shift();
  }
  function moveOf(key, price){
    const a = hist.get(key); if(!a || a.length < 2) return 0;
    const prev = a[a.length - 2];
    const m1 = prev && prev.p > 0 ? (price - prev.p) / prev.p * 100 : 0;
    const fiveAgo = nowMs() - 5 * 60 * 1000;
    let ref = null; for(let i = 0; i < a.length; i++){ if(a[i].t <= fiveAgo) ref = a[i]; }
    const m5 = ref && ref.p > 0 ? (price - ref.p) / ref.p * 100 : 0;
    return Math.abs(m5) > Math.abs(m1) ? m5 : m1;
  }
  function maxMove(byEx){ let m = 0; for(const e in byEx){ m = Math.max(m, Math.abs(num(byEx[e].move))); } return m; }

  async function cycle(){
    if(running) return; running = true;
    try{
      const settled = await Promise.all(EXCHANGES.map((e) => fetchTickers(e).catch(() => [])));
      const snap = {};
      EXCHANGES.forEach((e, i) => {
        const m = new Map();
        for(const t of settled[i]){ if(t.price > 0){ m.set(t.base, { price: t.price, vol24: t.vol24 }); pushHist(e + ":" + t.base, t.price); } }
        snap[e] = m;
      });
      snapshot = snap;

      const bases = new Set();
      EXCHANGES.forEach((e) => snap[e].forEach((_, b) => bases.add(b)));

      const raw = [];
      bases.forEach((b) => {
        const byEx = {}; let cand = false;
        EXCHANGES.forEach((e) => {
          const row = snap[e].get(b); if(!row) return;
          const mv = moveOf(e + ":" + b, row.price);
          byEx[e] = { price: row.price, move: mv, vol24: row.vol24, rvol: null, anom: null };
          if(Math.abs(mv) >= candThr) cand = true;
        });
        if(Object.keys(byEx).length) raw.push({ base: b, byEx: byEx, cand: cand });
      });

      // RVOL + волатильность по топ-кандидатам (с лимитом запросов на биржу)
      const candidates = raw.filter((r) => r.cand).sort((a, b) => maxMove(b.byEx) - maxMove(a.byEx));
      const perEx = {}; EXCHANGES.forEach((e) => perEx[e] = 0);
      const jobs = [];
      for(const c of candidates){
        for(const e of EXCHANGES){
          const row = c.byEx[e]; if(!row) continue;
          if(Math.abs(row.move) >= candThr && perEx[e] < maxKlines){
            perEx[e]++;
            jobs.push(fetchCandles(e, c.base).then((cd) => { row.rvol = rvolFrom(cd.vols); row.anom = anomalyScore(row.move, vol1mFrom(cd.closes)); }).catch(() => {}));
          }
        }
      }
      await Promise.all(jobs);

      const items = [];
      for(const r of raw){
        const it = analyzeBase(r.base, r.byEx, { threshold: candThr, spreadOk: spreadOk });
        if(!it) continue;
        it.catalyst = news ? news.catalystFor(it.base) : { type: "none" };
        it.type = eventType(it);
        it.stars = starRating(it);
        const li = leaderInfo(it); it.leader = li.leader; it.laggards = li.laggards;
        const lp = (it.exchanges.find((e) => e.ex === it.leader) || {}).price || 0;
        updatePhase(it, lp);
        items.push(it);
      }
      results = items; warming = false; lastRun = nowMs();
    }catch(e){}
    finally{ running = false; }
  }

  function start(){ if(timer) return; if(news && news.start) news.start(); cycle(); timer = setInterval(cycle, intervalMs); }
  function stop(){ if(timer){ clearInterval(timer); timer = null; } if(news && news.stop) news.stop(); }
  function getRadar(q){
    q = q || {};
    const out = rankFilter(results, { minVol: q.minVol || 0, dir: q.dir || "all", limit: q.limit || 30, mode: q.mode || "medium" });
    return { ok: true, warming: warming, ts: lastRun, mode: q.mode || "medium", count: out.length, items: out };
  }
  return { start, stop, getRadar };
}

module.exports = {
  createRadar, EXCHANGES,
  _pure: { normBase, exSymbol, pctSpread, rvolFrom, vol1mFrom, anomalyScore, strengthFrom, modeThreshold, analyzeBase, rankFilter, eventType, starRating, leaderInfo }
};
