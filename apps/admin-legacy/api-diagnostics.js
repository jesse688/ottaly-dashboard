'use strict';

/**
 * Diagnostic signal collection — logSignal() + async queue + batch flush.
 *
 * Call logSignal() anywhere in the app without awaiting it.
 * Signals are batched and flushed every 5 seconds or when the batch hits 50.
 *
 * Usage:
 *   const { logSignal } = require('./api-diagnostics');
 *   logSignal({ signal_type: 'api_health', metric_key: 'pv_latency_ms', metric_value: 120, workspace_id: ws });
 */

let _db = null;

function init(dbInstance) {
  _db = dbInstance;
}

// ── Queue ──────────────────────────────────────────────────────────────────
const _queue = [];
let _flushTimer = null;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5000;

function logSignal(signal) {
  if (!signal || signal.metric_value === null || signal.metric_value === undefined) return;

  _queue.push({
    timestamp:   signal.timestamp   || new Date(),
    signal_type: signal.signal_type || 'unknown',
    workspace_id: signal.workspace_id || null,
    metric_key:  signal.metric_key,
    metric_value: Number(signal.metric_value),
    unit:        signal.unit  || null,
    status:      signal.status || classifyStatus(signal),
    notes:       signal.notes || null,
  });

  if (_queue.length >= BATCH_SIZE) {
    _flush();
  } else if (!_flushTimer) {
    _flushTimer = setTimeout(_flush, FLUSH_INTERVAL_MS);
  }
}

function classifyStatus(signal) {
  const thresholds = STATUS_THRESHOLDS[signal.metric_key] || STATUS_THRESHOLDS[signal.signal_type];
  if (!thresholds) return 'normal';
  const v = Number(signal.metric_value);
  if (v >= thresholds.critical_min && v <= thresholds.critical_max) return 'critical';
  if (v >= thresholds.warning_min  && v <= thresholds.warning_max)  return 'warning';
  return 'normal';
}

// Inline thresholds — match diagnostic_checks table defaults
const STATUS_THRESHOLDS = {
  'warmup_pct':           { warning_min: 60, warning_max: 80,  critical_min: 0,  critical_max: 60  },
  'bounce_rate_pct':      { warning_min: 5,  warning_max: 10,  critical_min: 10, critical_max: 100 },
  'pv_api_latency_ms':    { warning_min: 500, warning_max: 1000, critical_min: 1000, critical_max: 99999 },
  'memory_used_pct':      { warning_min: 70, warning_max: 85,  critical_min: 85, critical_max: 100 },
  'event_loop_lag_ms':    { warning_min: 10, warning_max: 50,  critical_min: 50, critical_max: 99999 },
  'queue_pending':        { warning_min: 100, warning_max: 500, critical_min: 500, critical_max: 99999 },
};

// ── Flush ──────────────────────────────────────────────────────────────────
async function _flush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_queue.length === 0 || !_db) return;

  const batch = _queue.splice(0, _queue.length);

  const placeholders = batch.map((_, i) => {
    const b = i * 8;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`;
  }).join(',');

  const values = [];
  batch.forEach(s => {
    values.push(s.timestamp, s.signal_type, s.workspace_id,
                s.metric_key, s.metric_value, s.unit, s.status, s.notes);
  });

  try {
    await _db.query(
      `INSERT INTO diagnostic_signals
         (timestamp, signal_type, workspace_id, metric_key, metric_value, unit, status, notes)
       VALUES ${placeholders}`,
      values
    );
  } catch (err) {
    // Don't crash the app if signal logging fails
    console.warn('[diagnostics] flush error:', err.message);
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on('exit',    () => { if (_queue.length) _flush(); });
process.on('SIGTERM', () => _flush().then(() => process.exit(0)));
process.on('SIGINT',  () => _flush().then(() => process.exit(0)));

// ── Infrastructure signal — call on an interval ────────────────────────────
let _loopCheckScheduledAt = null;

function startInfraPolling(intervalMs = 60_000) {
  _loopCheckScheduledAt = Date.now();
  setInterval(() => {
    const mem = process.memoryUsage();
    const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);

    logSignal({ signal_type: 'infrastructure', metric_key: 'memory_heap_used_mb',
      metric_value: Math.round(mem.heapUsed / 1024 / 1024), unit: 'MB' });
    logSignal({ signal_type: 'infrastructure', metric_key: 'memory_heap_used_pct',
      metric_value: heapPct, unit: '%' });

    // Event loop lag: difference between when we expected to run and when we actually ran
    const now = Date.now();
    const lag = now - _loopCheckScheduledAt - intervalMs;
    _loopCheckScheduledAt = now;
    logSignal({ signal_type: 'infrastructure', metric_key: 'event_loop_lag_ms',
      metric_value: Math.max(0, lag), unit: 'ms' });
  }, intervalMs);
}

module.exports = { init, logSignal, startInfraPolling, _flush };
