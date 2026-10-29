/* Signals grouped by direction. Loading this view never starts the market collector. */
(function (global) {
  'use strict';
  const EX = { bybit: 'Bybit', bingx: 'BingX' };
  const DIRECTIONS = [{ id: 'pump', label: 'Pump' }, { id: 'dump', label: 'Dump' }];
  const number = (v, n = 2) => Number.isFinite(v) ? v.toLocaleString('ru-RU', { maximumFractionDigits: n }) : '—';
  const validTime = ms => Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000;
  const time = (ms, full = false) => validTime(ms) ? new Date(ms).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...(full ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) }) : '—';
  function ordered(events) { return [...new Map((Array.isArray(events)?events:[]).filter(e => e && typeof e.id==='string' && e.id && e.first && ['pump', 'dump'].includes(e.first.direction) && validTime(e.first.detection_ms) && typeof e.first.base==='string' && typeof e.first.exchange==='string' && Number.isFinite(e.first.return_pct) && Number.isFinite(e.first.detection_price) && e.first.detection_price>0 && Number.isFinite(e.first.window_minutes)).map(e => [e.id, e])).values()].sort((a, b) => b.first.detection_ms - a.first.detection_ms); }
  function feedState(data, failed) {
    if (!data) return { text: 'Нет данных', live: false, detail: 'Пока нет сохранённых сигналов.' };
    if (data.run?.stage === 'stopped' || data.run?.stage === 'completed') return { text: data.run.stage === 'stopped' ? 'Сканер остановлен' : 'Тест завершён', live: false, detail: 'Сохранённые сигналы · ' + time(data.run.start_ms, true) + ' — ' + time(data.run.actual_end_ms || data.run.end_ms) + ' МСК' };
    if (failed || !validTime(data.updated_at_ms) || data.updated_at_ms-Date.now()>30000 || Date.now() - data.updated_at_ms > 90000 || !['running','collecting'].includes(data.run?.stage)) return { text: 'Нет свежих данных', live: false, detail: 'Показаны последние сохранённые сигналы.' };
    return { text: 'Сканер работает', live: true, detail: 'Новые сигналы появляются автоматически' };
  }
  global.PumpDumpHelpers = { ordered, feedState };
  // One request loop in App supplies the home card and both signal tabs.
  global.createPumpDumpFeedHook = function (React) {
    const { useState, useEffect, useMemo } = React;
    return function usePumpDumpFeed() {
      const [data, setData] = useState(global.PUMP_DUMP_DATA || null), [failed, setFailed] = useState(false);
      useEffect(() => {
        let stopped = false, timer, controller;
        const load = async () => {
          if (global.location.protocol === 'file:') return;
          controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 7000);
          try { const r = await (global.appFetch || fetch)('/api/pump-dump', { cache: 'no-store', signal: controller.signal }); if (!r.ok) throw Error('feed_unavailable'); const next = await r.json(); if (next.schema_version !== 1 || !Array.isArray(next.events)) throw Error('invalid_feed'); if (!stopped) { setData(next); setFailed(false); } }
          catch (_) { if (!stopped) setFailed(true); }
          finally { clearTimeout(timeout); if (!stopped) timer = setTimeout(load, 10000); }
        };
        load(); return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
      }, []);
      const events = useMemo(() => ordered(data?.events), [data]);
      const status = feedState(data, failed || !!data?.feed_error);
      if (global.location.protocol === 'file:' && status.live) {
        status.text = 'Сохранённые сигналы'; status.live = false; status.detail = 'Показана сохранённая копия сигналов.';
      }
      return { events, status };
    };
  };
  global.createPumpDumpHomeWidget = function (React) {
    const h = React.createElement;
    return function PumpDumpHomeWidget({ feed, onOpen }) {
      const { events, status } = feed;
      return h('section', { className: 'pd-root pd-home', 'aria-label': 'Последние сигналы PUMP DUMP' },
        h('button', { type: 'button', className: 'pd-home-open', onClick: onOpen, 'aria-label': 'Открыть скринер PUMP DUMP' },
          h('span', { className: 'pd-home-title' }, 'Pump / Dump'),
          h('span', { className: 'pd-home-link' }, 'Все сигналы ', h('span', { 'aria-hidden': true }, '→'))),
        h('div', { className: 'pd-home-status', role: 'status' },
          h('span', { className: 'pd-status-dot' + (status.live ? ' live' : ''), 'aria-hidden': true }), h('span', null, status.text)),
        events.length ? h('div', { className: 'pd-home-signals' }, events.slice(0, 2).map(e => {
          const f = e.first;
          return h('article', { className: 'pd-home-signal ' + f.direction, key: e.id },
            h('div', { className: 'pd-home-signal-top' },
              h('div', { className: 'pd-asset' }, h('strong', null, f.base), h('span', { className: 'pd-direction ' + f.direction }, f.direction.toUpperCase())),
              h('strong', { className: 'pd-home-return ' + f.direction }, (f.return_pct > 0 ? '+' : '') + number(f.return_pct) + '%')),
            h('div', { className: 'pd-home-signal-meta' }, h('span', null, (EX[f.exchange] || f.exchange) + ' · ' + f.window_minutes + ' мин'),
              h('time', { dateTime: new Date(f.detection_ms).toISOString() }, time(f.detection_ms, true))));
        })) : h('div', { className: 'pd-home-empty' }, 'Пока нет сигналов. Здесь появятся движения, которые обнаружит система.'),
        h('p', { className: 'pd-home-note' }, status.live ? 'Последние сигналы · обновление каждые 10 с · МСК' : status.detail));
    };
  };
  global.createPumpDumpModule = function (React) {
    const h = React.createElement, { useState, useMemo } = React;
    const MotionReveal = global.AppMotion?.createReveal(React) || function ({ open, children }) { return open ? h('div', null, children) : null; };
    function Chart({ rows, direction }) {
      rows=(Array.isArray(rows)?rows:[]).filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(Number.isFinite)&&validTime(r[0])&&r[1]>0&&r[2]>0&&r[3]>0&&r[4]>0&&r[2]>=r[3]&&r[5]>=0);
      if (!rows.length) return h('p',{className:'pd-note'},'Для этого сигнала график недоступен.');
      const width = 440, right = 68, plotH = 148, top = 24;
      const lo = Math.min(...rows.map(r => r[3])), hi = Math.max(...rows.map(r => r[2])), range = hi - lo || hi * .001 || 1;
      const y = p => top + (hi - p) / range * plotH, step = (width - right - 8) / rows.length, x = i => 8 + step * (i + .5), bw = Math.max(1.4, step * .65), vmax = Math.max(...rows.map(r => r[5]), 1);
      const price = p => Number(p).toLocaleString('ru-RU', { maximumSignificantDigits: 6 });
      return h('svg', { className: 'pd-chart', viewBox: '0 0 440 240', role: 'img', 'aria-label': 'Минутные свечи и объём до сигнала' },
        [0, .5, 1].map((v, i) => h('g', { key: 'g' + i }, h('line', { x1: 0, x2: width - right, y1: top + v * plotH, y2: top + v * plotH, stroke: '#ffffff12' }), h('text', { x: width - right + 7, y: top + v * plotH + 3, fill: '#94939e', fontSize: 9 }, price(hi - v * range)))),
        rows.map((r, i) => { const c = r[4] >= r[1] ? '#34d17c' : '#ff617b'; return h('g', { key: r[0] }, h('line', { x1: x(i), x2: x(i), y1: y(r[2]), y2: y(r[3]), stroke: c }), h('rect', { x: x(i) - bw / 2, y: Math.min(y(r[1]), y(r[4])), width: bw, height: Math.max(1, Math.abs(y(r[1]) - y(r[4]))), fill: c }), h('rect', { x: x(i) - bw / 2, y: 216 - r[5] / vmax * 28, width: bw, height: Math.max(.5, r[5] / vmax * 28), fill: c, opacity: .45 })); }),
        h('text', { x: 8, y: 12, fill: '#94939e', fontSize: 9 }, '1 МИН · ЦЕНА И ОБЪЁМ'), h('text', { x: 8, y: 234, fill: '#94939e', fontSize: 9 }, time(rows[0][0])), h('text', { x: width - right, y: 234, textAnchor: 'end', fill: '#94939e', fontSize: 9 }, time(rows.at(-1)[0] + 60000) + ' МСК'));
    }
    function Panel({ feed }) {
      const { events, status } = feed;
      const useSaved=global.createMemoryBindings?.(React).useStoredState||((_key,initial)=>useState(initial));
      const [limit, setLimit] = useState(20), [expanded, setExpanded] = useState(null), [direction, setDirection] = useSaved('pump-direction','pump');
      const groups = useMemo(() => ({ pump: events.filter(e => e.first.direction === 'pump'), dump: events.filter(e => e.first.direction === 'dump') }), [events]);
      const filtered = groups[direction], directionLabel = direction === 'pump' ? 'Pump' : 'Dump';
      const selectDirection = next => { if (next !== direction) { setDirection(next); setLimit(20); setExpanded(null); } };
      const onTabKeyDown = event => {
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = direction === 'pump' ? 'dump' : 'pump';
        else if (event.key === 'Home') next = 'pump';
        else if (event.key === 'End') next = 'dump';
        else return;
        event.preventDefault(); selectDirection(next);
        event.currentTarget.parentElement.querySelector('#pd-tab-' + next)?.focus();
      };
      return h('section', { className: 'pd-root', 'aria-label': 'Лента сигналов PUMP DUMP' },
        h('header', { className: 'pd-header' }, h('div', { className: 'pd-eyebrow' }, 'BingX + Bybit · фьючерсы'), h('h1', null, 'Pump / ', h('span', null, 'Dump')), h('p', null, 'Сигналы роста и падения цены')),
        h('div', { className: 'pd-status' }, h('div', { className: 'pd-status-line' }, h('span', { className: 'pd-status-dot' + (status.live ? ' live' : ''), 'aria-hidden': true }), h('b', null, status.text), h('span', { className: 'pd-count' }, events.length + ' сигналов')), h('p', null, status.detail)),
        h('div', { className: 'pd-tabs', role: 'tablist', 'aria-label': 'Направление сигналов' }, DIRECTIONS.map(tab => h('button', { type: 'button', key: tab.id, id: 'pd-tab-' + tab.id, role: 'tab', className: 'pd-tab ' + tab.id + (direction === tab.id ? ' active' : ''), 'aria-selected': direction === tab.id, 'aria-controls': 'pd-signals', tabIndex: direction === tab.id ? 0 : -1, onClick: () => selectDirection(tab.id), onKeyDown: onTabKeyDown }, h('span', null, tab.label), h('span', { className: 'pd-tab-count' }, groups[tab.id].length)))),
        h('div', { id: 'pd-signals', key: direction, className: 'motion-panel', role: 'tabpanel', 'aria-labelledby': 'pd-tab-' + direction, tabIndex: 0 },
        h('div', { className: 'pd-feed-label' }, h('span', null, 'Последние сигналы ' + directionLabel), h('span', null, 'От 3% · 1–5 мин')),
        filtered.length ? h('div', { className: 'pd-feed' }, filtered.slice(0, limit).map(e => { const f = e.first, open = expanded === e.id; return h('article', { className: 'pd-signal ' + f.direction, key: e.id },
          h('button', { className: 'pd-signal-summary', onClick: () => setExpanded(open ? null : e.id), 'aria-expanded': open, 'aria-label': f.base + ', ' + f.direction.toUpperCase() + ', ' + number(f.return_pct) + '%' },
            h('div', { className: 'pd-signal-head' }, h('div', { className: 'pd-asset' }, h('strong', null, f.base), h('span', { className: 'pd-direction ' + f.direction }, f.direction.toUpperCase())), h('strong', { className: 'pd-return ' + f.direction }, (f.return_pct > 0 ? '+' : '') + number(f.return_pct) + '%')),
            h('div', { className: 'pd-signal-meta' }, h('span', null, (EX[f.exchange] || f.exchange) + ' · за ' + f.window_minutes + ' мин'), h('time', { dateTime: new Date(f.detection_ms).toISOString() }, time(f.detection_ms, true))),
            h('div', { className: 'pd-signal-bottom' }, h('span', null, 'Объём ' + (Number.isFinite(f.volume_ratio_to_prior_median) ? number(f.volume_ratio_to_prior_median) + '×' : '—')), h('span', null, open ? 'Скрыть график ↑' : 'График ↗'))),
          h(MotionReveal, { open }, h('div', { className: 'pd-expanded' }, h(Chart, { rows: e.review_context, direction: f.direction }), h('div', { className: 'pd-metrics' }, h('div', null, h('span', null, 'Цена при сигнале'), h('b', null, number(f.detection_price, 8))), h('div', null, h('span', null, 'Необычность'), h('b', null, number(f.abs_robust_z)))), h('p', { className: 'pd-note' }, f.profile_id?.endsWith('insufficient') ? 'Для полного сравнения с обычным движением не хватает данных.' : 'Движение и объём сравниваются с предыдущим часом. График заканчивается в момент сигнала.'))));
        })) : h('div', { className: 'pd-empty' }, h('b', null, 'Пока нет сигналов ' + directionLabel), h('p', null, direction === 'pump' ? 'Здесь появятся сигналы резкого роста цены.' : 'Здесь появятся сигналы резкого падения цены.')),
        limit < filtered.length && h('button', { className: 'pd-more', onClick: () => setLimit(limit + 20) }, 'Показать ещё · ' + (filtered.length - limit))),
        h('p', { className: 'pd-footer' }, 'Сигналы отмечают резкое движение цены. Необычность ситуации ещё требует оценки. Время — МСК.'));
    }
    return Panel;
  };
})(window);
