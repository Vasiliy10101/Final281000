"use strict";
/*
 * Новостной слой: бесплатные крипто-RSS → "катализатор" для монеты.
 * Цель — понять, был ли памп/дамп вызван новостями (и сколько их), а не
 * пересказывать новости. Пользователю выдаётся только итог: news(N) / none.
 * Чистые функции (parseRss/matchCoin) тестируются без сети.
 */

const FEEDS = [
  "https://cointelegraph.com/rss",
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://decrypt.co/feed",
  "https://cryptoslate.com/feed/",
  "https://www.newsbtc.com/feed/",
  "https://cryptopotato.com/feed/",
  "https://bitcoinmagazine.com/feed"
];

// Алиасы тикер → имена (для матчинга по названию, не только по тикеру).
const ALIASES = {
  BTC:["bitcoin"], ETH:["ethereum","ether"], SOL:["solana"], XRP:["ripple"],
  BNB:["binance coin"], DOGE:["dogecoin"], ADA:["cardano"], AVAX:["avalanche"],
  LINK:["chainlink"], DOT:["polkadot"], MATIC:["polygon"], POL:["polygon"],
  TON:["toncoin"], TRX:["tron"], LTC:["litecoin"], SHIB:["shiba inu","shiba"],
  PEPE:["pepe"], SUI:["sui network"], APT:["aptos"], ARB:["arbitrum"],
  OP:["optimism"], INJ:["injective"], NEAR:["near protocol"], ATOM:["cosmos"],
  FIL:["filecoin"], RNDR:["render"], RENDER:["render"], WIF:["dogwifhat"],
  BONK:["bonk"], FET:["fetch.ai"], TIA:["celestia"], SEI:["sei network"],
  ORDI:["ordinals"], JUP:["jupiter"], PYTH:["pyth"], STX:["stacks"],
  AAVE:["aave"], UNI:["uniswap"], LDO:["lido"], CRV:["curve"], MKR:["maker"],
  HBAR:["hedera"], ICP:["internet computer"], ETC:["ethereum classic"],
  XLM:["stellar"], ALGO:["algorand"], VET:["vechain"], GALA:["gala games"],
  SAND:["the sandbox"], MANA:["decentraland"], AXS:["axie"], EOS:["eos"]
};

function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function stripCdata(s){ return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); }
function decodeEntities(s){
  return String(s).replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&apos;/g,"'").replace(/&#x27;/gi,"'");
}

// Парсер RSS без зависимостей: вытаскиваем title/pubDate/link из <item>.
function parseRss(xml){
  if(!xml || typeof xml !== "string") return [];
  const out = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for(const b of blocks){
    const tm = b.match(/<title>([\s\S]*?)<\/title>/i);
    const dm = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const lm = b.match(/<link>([\s\S]*?)<\/link>/i);
    const title = decodeEntities(stripCdata(tm ? tm[1] : "")).trim();
    if(!title) continue;
    const dRaw = dm ? stripCdata(dm[1]).trim() : "";
    const ts = dRaw ? Date.parse(dRaw) : NaN;
    out.push({ title: title, ts: Number.isFinite(ts) ? ts : Date.now(), link: lm ? stripCdata(lm[1]).trim() : "" });
  }
  return out;
}

// Сколько свежих заголовков (в окне) упоминают монету — по тикеру или имени.
function matchCoin(base, headlines, opts){
  opts = opts || {};
  const windowMs = opts.windowMs || 45 * 60 * 1000;
  const now = opts.now || Date.now();
  const b = String(base).toUpperCase();
  const names = (ALIASES[b] || []).map((s) => s.toLowerCase());
  const tickerRe = new RegExp("(^|[^A-Za-z0-9])\\$?" + escapeRe(b) + "([^A-Za-z0-9]|$)");
  const hits = [];
  for(const h of (headlines || [])){
    if(now - h.ts > windowMs) continue;
    const title = h.title || "";
    let hit = false;
    // тикер: как отдельное слово (с возможным $), регистр важен для коротких тикеров
    if(b.length >= 4 ? new RegExp("(^|[^A-Za-z0-9])\\$?" + escapeRe(b) + "([^A-Za-z0-9]|$)", "i").test(title) : tickerRe.test(title)) hit = true;
    if(!hit && names.length){ const low = title.toLowerCase(); for(const nm of names){ if(low.indexOf(nm) !== -1){ hit = true; break; } } }
    if(hit) hits.push(h.title);
  }
  return { count: hits.length, items: hits.slice(0, 5) };
}

// Кэш новостей с периодическим обновлением.
function createNews(opts){
  opts = opts || {};
  const refreshMs = opts.refreshMs || 3 * 60 * 1000;
  const keepMs = opts.keepMs || 2 * 60 * 60 * 1000;
  const windowMs = opts.windowMs || 45 * 60 * 1000;
  let headlines = [], timer = null, lastRun = 0;

  async function fetchFeed(url){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/rss+xml, application/xml, text/xml" } });
      clearTimeout(t);
      if(!r.ok) return [];
      return parseRss(await r.text());
    }catch(e){ return []; }
  }
  async function refresh(){
    try{
      const all = await Promise.all(FEEDS.map(fetchFeed));
      const merged = [].concat.apply([], all);
      const cut = Date.now() - keepMs;
      const seen = new Set(), out = [];
      for(const h of merged){ if(h.ts < cut) continue; const k = h.title.toLowerCase(); if(seen.has(k)) continue; seen.add(k); out.push(h); }
      headlines = out; lastRun = Date.now();
    }catch(e){}
  }
  function start(){ if(timer) return; refresh(); timer = setInterval(refresh, refreshMs); }
  function stop(){ if(timer){ clearInterval(timer); timer = null; } }
  function catalystFor(base){
    const m = matchCoin(base, headlines, { windowMs: windowMs });
    return m.count > 0 ? { type: "news", count: m.count, items: m.items } : { type: "none" };
  }
  return { start, stop, catalystFor, size: () => headlines.length, lastRun: () => lastRun, _setHeadlines: (h) => { headlines = h; } };
}

module.exports = { createNews, FEEDS, ALIASES, _pure: { parseRss, matchCoin, stripCdata, decodeEntities } };
