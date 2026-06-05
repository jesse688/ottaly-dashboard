'use strict';

/**
 * Performance Intelligence Engine
 *
 * Classifies each day as Excellent/Good/Fair/Poor, identifies which signals
 * were present, and builds a rolling pattern library with correlation scores.
 *
 * Called from the 11:45pm cron (after campaign snapshots).
 * Can also be backfilled from existing email_events data.
 */

// ── Performance tier thresholds ────────────────────────────────────────────
// Calibrated to cold-email reply rates (Stats page treats 2.5% as "good").
const MIN_SENDS_FOR_TIER = 200; // below this, rates are statistical noise (holidays, etc.)

function classifyTier(replyRatePct, bounceRatePct, warmupPct, sends = null) {
  if (replyRatePct === null) return 'unknown';
  // Low-volume days (holidays, ramp-up) are unreliable — don't tier them
  if (sends !== null && sends < MIN_SENDS_FOR_TIER) return 'unknown';
  // Demote tier if bounce or warmup is bad regardless of reply rate
  const bounceFlag  = bounceRatePct !== null && bounceRatePct > 5;
  const warmupFlag  = warmupPct     !== null && warmupPct     < 60;
  const degraded    = bounceFlag || warmupFlag;

  if (replyRatePct >= 3   && !degraded)  return 'excellent';
  if (replyRatePct >= 2   && !bounceFlag) return 'good';
  if (replyRatePct >= 1)  return 'fair';
  return 'poor';
}

// ── Signal identification ──────────────────────────────────────────────────
// Returns a flat object of key signals present on a given day
// that the pattern library can slice on
function identifySignals({ replyRate, bounceRate, warmup, apiLatency, sends, externalFactors, dayOfWeek }) {
  const signals = {};

  // Reply rate tier
  if (replyRate !== null) {
    signals.rr_tier = replyRate >= 15 ? 'excellent' : replyRate >= 10 ? 'good' : replyRate >= 5 ? 'fair' : 'poor';
  }

  // Account warmup health
  if (warmup !== null) {
    signals.warmup_health = warmup >= 85 ? 'strong' : warmup >= 70 ? 'ok' : warmup >= 50 ? 'weak' : 'critical';
  }

  // Bounce rate health
  if (bounceRate !== null) {
    signals.bounce_health = bounceRate < 3 ? 'clean' : bounceRate < 6 ? 'ok' : bounceRate < 10 ? 'elevated' : 'high';
  }

  // API health
  if (apiLatency !== null) {
    signals.api_health = apiLatency < 300 ? 'fast' : apiLatency < 600 ? 'ok' : apiLatency < 1000 ? 'slow' : 'degraded';
  }

  // Send volume (relative — low volume days are unreliable for rate calculations)
  if (sends !== null) {
    signals.send_volume = sends >= 1000 ? 'high' : sends >= 300 ? 'medium' : 'low';
  }

  // Day of week
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (dayOfWeek !== undefined && dayOfWeek !== null) {
    signals.day_of_week = days[dayOfWeek] || 'unknown';
  }

  // External factors present
  if (externalFactors && externalFactors.length > 0) {
    signals.external_factor = externalFactors.map(f => f.factor_type).join(',');
    signals.has_external_factor = true;
  } else {
    signals.has_external_factor = false;
  }

  return signals;
}

// ── Daily intelligence run ─────────────────────────────────────────────────
async function runDailyIntelligence(db, date) {
  // date: 'YYYY-MM-DD'

  // 1. Fetch metrics for this date from diagnostic_signals
  const sigRows = await db.query(`
    SELECT signal_type, metric_key, AVG(metric_value) AS avg_value
    FROM diagnostic_signals
    WHERE DATE(timestamp)::text = $1
    GROUP BY signal_type, metric_key
  `, [date]);

  const sig = {};
  for (const r of sigRows.rows) {
    sig[`${r.signal_type}:${r.metric_key}`] = parseFloat(r.avg_value);
  }

  let replyRate  = sig['campaign_metrics:daily_reply_rate_pct'] ?? null;
  let sends      = sig['campaign_metrics:daily_sends']           ?? null;
  let bounceRate = sig['bounce_analysis:bounce_rate_pct']        ?? null;

  // Compute from perf_cache_daily — EXACT same source as the Stats page.
  // Try the specific date first; if no data, use a 7-day window ending on that date.
  if (replyRate === null) {
    let pc = await db.query(`
      SELECT
        SUM(COALESCE((data->>'sent')::numeric, 0))    AS sends,
        SUM(COALESCE((data->>'replies')::numeric, 0)) AS replies,
        SUM(COALESCE((data->>'bounces')::numeric, 0)) AS bounces
      FROM perf_cache_daily
      WHERE date = $1
    `, [date]);
    let row = pc.rows[0];
    if (!row || parseFloat(row.sends || 0) < 50) {
      // Fall back to 7-day window ending on this date
      pc = await db.query(`
        SELECT
          SUM(COALESCE((data->>'sent')::numeric, 0))    AS sends,
          SUM(COALESCE((data->>'replies')::numeric, 0)) AS replies,
          SUM(COALESCE((data->>'bounces')::numeric, 0)) AS bounces
        FROM perf_cache_daily
        WHERE date <= $1 AND date > TO_CHAR($1::date - INTERVAL '7 days', 'YYYY-MM-DD')
      `, [date]);
      row = pc.rows[0];
    }
    const s = parseFloat(row?.sends || 0);
    if (s >= 50) {
      replyRate  = Math.round((parseFloat(row.replies || 0) / s) * 10000) / 100;
      bounceRate = Math.round((parseFloat(row.bounces || 0) / s) * 10000) / 100;
      sends      = Math.round(s);
    }
  }

  if (replyRate === null) {
    return { date, tier: 'unknown', replyRate: null, bounceRate: null, signals: {}, notes: 'No data for this date.' };
  }

  if (bounceRate === null) bounceRate = sig['bounce_analysis:bounce_rate_pct'] ?? null;
  const warmup     = sig['email_account_health:warmup_inbox_pct']  ?? null;
  const apiLatency = sig['api_health:pv_latency_ms']               ?? null;
  const memPct     = sig['infrastructure:memory_heap_used_pct']    ?? null; // eslint-disable-line no-unused-vars

  // 2. Fetch external factors for this date
  const efRows = await db.query(
    `SELECT factor_type, description, severity FROM diagnostic_external_factors WHERE date = $1`,
    [date]
  );
  const externalFactors = efRows.rows;

  // 3. Classify tier (low-volume days → unknown)
  const tier = classifyTier(replyRate, bounceRate, warmup, sends);

  // 4. Identify signals
  const d = new Date(date + 'T12:00:00Z');
  const signals = identifySignals({
    replyRate, bounceRate, warmup, apiLatency, sends,
    externalFactors,
    dayOfWeek: d.getDay(),
  });

  // 5. Generate human-readable notes
  const notes = generateNotes({ tier, replyRate, bounceRate, warmup, apiLatency, sends, externalFactors, signals });

  // 6. Upsert into daily_intelligence_logs
  await db.query(`
    INSERT INTO daily_intelligence_logs
      (date, workspace_id, performance_tier, reply_rate, bounce_rate, warmup_pct,
       api_health, key_signals, correlated_patterns, intelligence_notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (date, workspace_id)
    DO UPDATE SET
      performance_tier    = EXCLUDED.performance_tier,
      reply_rate          = EXCLUDED.reply_rate,
      bounce_rate         = EXCLUDED.bounce_rate,
      warmup_pct          = EXCLUDED.warmup_pct,
      api_health          = EXCLUDED.api_health,
      key_signals         = EXCLUDED.key_signals,
      correlated_patterns = EXCLUDED.correlated_patterns,
      intelligence_notes  = EXCLUDED.intelligence_notes
  `, [
    date, 'global', tier,
    replyRate, bounceRate, warmup,
    apiLatency !== null ? Math.max(0, 1 - apiLatency / 2000) : null, // 0–1 health score
    JSON.stringify(signals),
    Object.values(signals).filter(v => typeof v === 'string').slice(0, 8),
    notes,
  ]);

  return { date, tier, replyRate, bounceRate, warmup, apiLatency, signals, notes };
}

// ── Pattern correlation update ─────────────────────────────────────────────
// Recalculates rolling avg_reply_rate + correlation_strength for each pattern
async function updatePerformancePatterns(db) {
  // Pull last 90 days of intelligence logs
  const logs = await db.query(`
    SELECT date, performance_tier, reply_rate, bounce_rate, key_signals
    FROM daily_intelligence_logs
    WHERE date > CURRENT_DATE - INTERVAL '90 days'
      AND reply_rate IS NOT NULL
    ORDER BY date
  `);

  if (logs.rows.length < 7) return; // not enough data yet

  // Collect all pattern keys and values seen
  const patternStats = {}; // key: `type:value` → { withRR: [], withoutRR: [], count: 0 }

  for (const row of logs.rows) {
    const signals = typeof row.key_signals === 'string'
      ? JSON.parse(row.key_signals)
      : (row.key_signals || {});
    const rr = parseFloat(row.reply_rate);
    if (isNaN(rr)) continue;

    for (const [k, v] of Object.entries(signals)) {
      if (typeof v !== 'string' && typeof v !== 'boolean') continue;
      const key = `${k}:${v}`;
      if (!patternStats[key]) patternStats[key] = { with: [], without: [], type: k, value: String(v) };
      patternStats[key].with.push(rr);
    }

    // Collect "without" by adding all days to every pattern's without list first
    for (const key of Object.keys(patternStats)) {
      const [k] = key.split(':');
      const val = signals[k];
      if (val === undefined || val === null) {
        patternStats[key].without.push(rr);
      }
    }
  }

  // Upsert each pattern
  for (const [, p] of Object.entries(patternStats)) {
    if (p.with.length < 3) continue; // not enough data
    const avgWith    = p.with.reduce((a, b) => a + b, 0) / p.with.length;
    const avgWithout = p.without.length >= 3
      ? p.without.reduce((a, b) => a + b, 0) / p.without.length
      : null;

    // Correlation strength: how much better (or worse) performance is with this pattern
    // Range -1 to +1, clamped. Positive = pattern correlates with higher RR.
    let strength = 0;
    if (avgWithout !== null && avgWithout > 0) {
      strength = Math.max(-1, Math.min(1, (avgWith - avgWithout) / avgWithout));
    }

    await db.query(`
      INSERT INTO performance_patterns
        (pattern_type, pattern_value, workspace_id, avg_reply_rate, sample_size, correlation_strength, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (workspace_id, pattern_type, pattern_value)
      DO UPDATE SET
        avg_reply_rate       = EXCLUDED.avg_reply_rate,
        sample_size          = EXCLUDED.sample_size,
        correlation_strength = EXCLUDED.correlation_strength,
        last_updated         = NOW()
    `, [p.type, p.value, 'global', Math.round(avgWith * 100) / 100, p.with.length, Math.round(strength * 100) / 100]);
  }
}

// ── Backfill ───────────────────────────────────────────────────────────────
// Seeds daily_intelligence_logs from perf_cache_daily — the EXACT same table
// the Stats page reads. Replicates /api/stats/summary logic: sum sent + replies
// across all workspaces per day, then reply_rate = sum(replies) / sum(sent).
async function backfillIntelligenceLogs(db) {
  const existing = await db.query(
    `SELECT COUNT(*) AS n FROM daily_intelligence_logs WHERE date > CURRENT_DATE - INTERVAL '90 days'`
  );
  if (parseInt(existing.rows[0].n) > 7) {
    console.log('[intelligence] backfill skipped — logs already present');
    return;
  }

  console.log('[intelligence] backfilling from perf_cache_daily (same source as Stats page)…');

  // Sum sent/replies/bounces across ALL workspaces per day, then divide.
  // This is identical to how /api/stats/summary aggregates totals.
  const rows = await db.query(`
    SELECT
      date,
      SUM(COALESCE((data->>'sent')::numeric, 0))    AS sends,
      SUM(COALESCE((data->>'replies')::numeric, 0)) AS replies,
      SUM(COALESCE((data->>'bounces')::numeric, 0)) AS bounces
    FROM perf_cache_daily
    WHERE date >= TO_CHAR(CURRENT_DATE - INTERVAL '90 days', 'YYYY-MM-DD')
    GROUP BY date
    HAVING SUM(COALESCE((data->>'sent')::numeric, 0)) >= 200
    ORDER BY date
  `);

  let inserted = 0;
  for (const r of rows.rows) {
    const sends   = parseInt(r.sends)   || 0;
    const replies = parseInt(r.replies) || 0;
    const bounces = parseInt(r.bounces) || 0;
    if (sends < MIN_SENDS_FOR_TIER) continue; // skip holidays / low-volume noise entirely
    const rr = Math.round((replies / sends) * 10000) / 100;
    const br = Math.round((bounces / sends) * 10000) / 100;
    const tier = classifyTier(rr, br, null, sends);
    const d = new Date(r.date + 'T12:00:00Z');
    const signals = identifySignals({ replyRate: rr, bounceRate: br, warmup: null, apiLatency: null, sends, externalFactors: [], dayOfWeek: d.getDay() });
    const notes = generateNotes({ tier, replyRate: rr, bounceRate: br, warmup: null, sends, externalFactors: [], signals });

    try {
      await db.query(`
        INSERT INTO daily_intelligence_logs
          (date, workspace_id, performance_tier, reply_rate, bounce_rate, key_signals, correlated_patterns, intelligence_notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (date, workspace_id)
        DO UPDATE SET
          performance_tier = EXCLUDED.performance_tier,
          reply_rate = EXCLUDED.reply_rate,
          bounce_rate = EXCLUDED.bounce_rate,
          key_signals = EXCLUDED.key_signals,
          correlated_patterns = EXCLUDED.correlated_patterns,
          intelligence_notes = EXCLUDED.intelligence_notes
      `, [r.date, 'global', tier, rr, br, JSON.stringify(signals),
          Object.values(signals).filter(v => typeof v === 'string').slice(0, 8), notes]);
      inserted++;
    } catch (e) { console.warn('[intelligence] insert failed:', e.message); }
  }

  console.log(`[intelligence] backfill complete — ${inserted} days seeded`);
  await updatePerformancePatterns(db);
}


// ── Notes generator ────────────────────────────────────────────────────────
function generateNotes({ tier, replyRate, bounceRate, warmup, sends, externalFactors, signals }) {
  const parts = [];

  if (externalFactors && externalFactors.length > 0) {
    parts.push(`External: ${externalFactors.map(f => f.description || f.factor_type).join(', ')}.`);
  }

  if (tier === 'excellent') parts.push(`Strong day — ${replyRate?.toFixed(1)}% reply rate.`);
  else if (tier === 'good')  parts.push(`Good day — ${replyRate?.toFixed(1)}% reply rate.`);
  else if (tier === 'fair')  parts.push(`Average day — ${replyRate?.toFixed(1)}% reply rate.`);
  else if (tier === 'poor')  parts.push(`Poor day — ${replyRate !== null ? replyRate.toFixed(1) + '%' : 'no data'} reply rate.`);

  if (bounceRate !== null && bounceRate > 6)  parts.push(`Bounce rate elevated at ${bounceRate.toFixed(1)}%.`);
  if (warmup     !== null && warmup     < 70) parts.push(`Warmup low at ${warmup.toFixed(0)}%.`);
  if (sends      !== null && sends      < 100) parts.push(`Low send volume (${Math.round(sends)} sends) — rates unreliable.`);

  const dow = signals?.day_of_week;
  if (dow === 'monday' || dow === 'friday') parts.push(`${dow.charAt(0).toUpperCase() + dow.slice(1)} — typically lower engagement.`);

  return parts.join(' ') || 'No notes.';
}

// ── Unique constraint helper ───────────────────────────────────────────────
// daily_intelligence_logs needs a unique constraint on (date, workspace_id) for ON CONFLICT
async function ensureUniqueConstraint(db) {
  try {
    await db.query(`
      ALTER TABLE daily_intelligence_logs
      ADD CONSTRAINT uq_dil_date_ws UNIQUE (date, workspace_id)
    `);
  } catch (_) {} // already exists
  try {
    await db.query(`
      ALTER TABLE performance_patterns
      ADD CONSTRAINT uq_pp_ws_type_val UNIQUE (workspace_id, pattern_type, pattern_value)
    `);
  } catch (_) {}
}

module.exports = { runDailyIntelligence, updatePerformancePatterns, backfillIntelligenceLogs, classifyTier, ensureUniqueConstraint };
