'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createPumpDumpFeed({ root = __dirname, runDir = process.env.PUMP_DUMP_RUN_DIR || '', clock = Date.now } = {}) {
  const snapshotPath = path.join(root, 'data', 'pump-dump-feed.json');
  const sourcePath = path.join(root, 'data', 'pump-dump-source.json');
  let cached = null, refreshedAt = 0;
  const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const clean = e => ({ id: e.id, first: e.first, candle_finality: e.candle_finality, review_context: e.review_context || [] });
  const empty = () => ({ schema_version: 1, dataset_id: 'empty', updated_at_ms: null, run: { stage: 'unavailable' }, events: [] });
  function fallback() {
    try { const d = readJSON(snapshotPath); if (d.schema_version !== 1 || !Array.isArray(d.events)) throw Error('Invalid snapshot'); return d; }
    catch (_) { return empty(); }
  }
  return {
    get() {
      const now = clock(); if (cached && now - refreshedAt < 2000) return cached;
      try {
        let dir = runDir;
        if (!dir && fs.existsSync(sourcePath)) { const source = readJSON(sourcePath); if (source.index_path && fs.existsSync(source.index_path)) dir = readJSON(source.index_path).directory; }
        if (!dir) { cached = fallback(); refreshedAt = now; return cached; }
        // Source paths are local deployment configuration, never request parameters.
        const status = readJSON(path.join(dir, 'status.json'));
        const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n');
        const events = new Map();
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          let record; try { record = JSON.parse(lines[i]); } catch (e) { if (i === lines.length - 1) break; throw e; }
          if (record.type === 'episode' && record.id && record.first && ['pump', 'dump'].includes(record.first.direction)) events.set(record.id, clean(record));
        }
        cached = { schema_version: 1, dataset_id: path.basename(dir), updated_at_ms: status.updated_at_ms,
          run: { stage: status.stage, start_ms: status.start_ms, end_ms: status.actual_end_ms || status.end_ms, actual_end_ms: status.actual_end_ms || null },
          events: [...events.values()].sort((a, b) => b.first.detection_ms - a.first.detection_ms) };
      } catch (_) {
        cached = { ...(cached || fallback()), feed_error: 'Источник сигналов временно недоступен' };
      }
      refreshedAt = now; return cached;
    }
  };
}
module.exports = { createPumpDumpFeed };
