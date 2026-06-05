# Phase 1 Implementation — Signal Collection Infrastructure

## Status: READY TO BUILD

✅ Data foundation complete (134k+ events)  
✅ Validation gates all pass  
✅ Database tables initialized  
✅ Plan 100% documented  

## Phase 1: What we're building

**Goal:** Collect 6 independent signal categories in real-time + daily aggregation

**Output:** `diagnostic_signals` table continuously populated with metrics  
**Timeline:** 2–3 days

## Tasks

### Task 1.1: Instrument PlusVibe API calls (0.5 days)

**What:** Add timing + error rate capture to every PlusVibe API call

**Where:** Wrap existing API calls in `api-instrumentation.js`

**What to log:**
```javascript
logSignal({
  signal_type: 'api_health',
  metric_key: 'pv_/campaigns_latency_ms',
  metric_value: elapsed, // milliseconds
  status: response.ok ? 'normal' : 'warning',
  workspace_id: workspaceId
});

if (!response.ok) {
  logSignal({
    signal_type: 'api_health',
    metric_key: `pv_/campaigns_http_${response.status}`,
    metric_value: 1,
    status: 'warning'
  });
}
```

**Implementation notes:**
- Batch logs asynchronously (don't block requests)
- Log a sample (1 in 10 calls) if overhead > 5ms
- Log all errors regardless
- Use workspace_id from params/auth context

**Testing:**
- Make 10 API calls, verify 10–20 signals logged
- Measure latency impact: should be < 5ms per call
- Verify sampling: should see ~1 per 10 or all if errors

---

### Task 1.2: Collect warmup metrics daily (0.5 days)

**What:** Fetch warmup % for all email accounts daily (6am, same as audience refresh)

**Where:** Add to existing daily cron in server.js (search "6am cron")

**What to fetch:**
```javascript
async function collectWarmupMetrics() {
  for (const workspace of allWorkspaces) {
    const accounts = await pvFetch(`/account?workspace_id=${workspace.id}`);
    
    for (const account of accounts.accounts) {
      logSignal({
        signal_type: 'email_account_health',
        metric_key: `warmup_${account.email}_inbox_pct`,
        metric_value: account.warmup_inbox_pct, // 0–100
        unit: '%',
        workspace_id: workspace.id
      });

      logSignal({
        signal_type: 'email_account_health',
        metric_key: `warmup_${account.email}_spam_pct`,
        metric_value: account.warmup_spam_pct,
        unit: '%',
        workspace_id: workspace.id
      });
    }
  }
}
```

**Testing:**
- Run manually, verify signals for all accounts
- Values should be 0–100 range
- All accounts should be present
- Verify account names match reality

---

### Task 1.3: Aggregate bounce rates from email_events (0.5 days)

**What:** Daily query to compute bounce rate per workspace

**Where:** New function `aggregateBounceRates()` in db-postgres.js, called from daily cron

**What to log:**
```javascript
async function aggregateBounceRates() {
  const result = await db.query(`
    SELECT 
      workspace_id,
      DATE(event_at) as date,
      COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
      COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces,
      ROUND(100.0 * COUNT(*) FILTER (WHERE event_type = 'bounce') / 
            NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2) as bounce_pct
    FROM email_events
    WHERE event_at = CURRENT_DATE - INTERVAL '1 day'
    GROUP BY workspace_id, DATE(event_at)
  `);

  for (const row of result.rows) {
    logSignal({
      signal_type: 'bounce_analysis',
      metric_key: `bounce_rate_pct`,
      metric_value: row.bounce_pct,
      unit: '%',
      workspace_id: row.workspace_id
    });
  }
}
```

**Testing:**
- Run query manually, spot-check counts
- Bounce rate should be 0–10% (if higher, investigate webhook)
- Verify workspace_id is present
- Values should match `/api/stats` endpoint

---

### Task 1.4: Infrastructure health endpoint (0.5 days)

**What:** New `GET /api/diagnostics/health` endpoint returning server metrics

**Where:** New endpoint in server.js

**What to return:**
```javascript
app.get('/api/diagnostics/health', requireAuth, async (req, res) => {
  const mem = process.memoryUsage();
  const now = Date.now();
  const uptime = process.uptime();

  // Log infrastructure signals
  logSignal({
    signal_type: 'infrastructure',
    metric_key: 'memory_heap_used_mb',
    metric_value: Math.round(mem.heapUsed / 1024 / 1024),
    unit: 'MB'
  });

  logSignal({
    signal_type: 'infrastructure',
    metric_key: 'memory_heap_used_pct',
    metric_value: Math.round((mem.heapUsed / mem.heapTotal) * 100),
    unit: '%'
  });

  // Event loop lag (measure time between scheduled and actual execution)
  const measured = now - scheduledTime;
  logSignal({
    signal_type: 'infrastructure',
    metric_key: 'event_loop_lag_ms',
    metric_value: measured,
    unit: 'ms'
  });

  res.json({
    timestamp: new Date(),
    memory: {
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      heap_pct: Math.round((mem.heapUsed / mem.heapTotal) * 100)
    },
    event_loop_lag_ms: measured,
    uptime: uptime,
    status: 'ok'
  });
});
```

**Testing:**
- Hit endpoint, verify JSON response
- Memory values should be realistic (< 500MB)
- Event loop lag should be < 10ms
- Verify signals logged to database

---

### Task 1.5: Campaign metric snapshots (0.5 days)

**What:** Daily aggregation of sends, replies, bounces per workspace

**Where:** New function in db-postgres.js, called from daily cron at 11:30pm

**What to log:**
```javascript
async function captureWorkspaceSnapshots() {
  const result = await db.query(`
    SELECT 
      workspace_id,
      COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
      COUNT(*) FILTER (WHERE event_type = 'reply') as replies,
      COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces,
      ROUND(100.0 * COUNT(*) FILTER (WHERE event_type = 'reply') / 
            NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2) as reply_rate
    FROM email_events
    WHERE event_at > NOW() - INTERVAL '1 day'
    GROUP BY workspace_id
  `);

  for (const row of result.rows) {
    logSignal({
      signal_type: 'campaign_metrics',
      metric_key: 'daily_sends',
      metric_value: row.sends,
      unit: 'count',
      workspace_id: row.workspace_id
    });

    logSignal({
      signal_type: 'campaign_metrics',
      metric_key: 'daily_reply_rate_pct',
      metric_value: row.reply_rate,
      unit: '%',
      workspace_id: row.workspace_id
    });
  }
}
```

**Testing:**
- Run query, verify counts match email_events
- Reply rates should be 5–20%
- All workspaces should be present
- Spot-check against Stats page

---

### Task 1.6: Create `logSignal()` helper (0.5 days)

**What:** Core function that inserts signals into diagnostic_signals table

**Where:** New file `api-diagnostics.js`

**Implementation:**
```javascript
const signalQueue = [];
let queueTimer = null;

async function logSignal(signal) {
  signal.timestamp = signal.timestamp || new Date();
  signalQueue.push(signal);

  // Batch and flush every 50 signals or 5 seconds
  if (signalQueue.length >= 50) {
    await flushSignalQueue();
  } else if (!queueTimer) {
    queueTimer = setTimeout(flushSignalQueue, 5000);
  }
}

async function flushSignalQueue() {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = null;

  if (signalQueue.length === 0) return;

  const signals = signalQueue.splice(0, Infinity); // drain queue
  const placeholders = signals.map((_, i) => {
    const base = i * 8;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  }).join(', ');

  const values = [];
  signals.forEach(s => {
    values.push(
      s.timestamp,
      s.signal_type,
      s.workspace_id || null,
      s.metric_key,
      s.metric_value,
      s.unit || null,
      s.status || 'normal',
      s.notes || null
    );
  });

  try {
    await db.query(`
      INSERT INTO diagnostic_signals
      (timestamp, signal_type, workspace_id, metric_key, metric_value, unit, status, notes)
      VALUES ${placeholders}
    `, values);
  } catch (err) {
    console.error('Error logging signals:', err.message);
  }
}

// Flush on shutdown
process.on('exit', flushSignalQueue);
process.on('SIGTERM', () => {
  flushSignalQueue().then(() => process.exit(0));
});

module.exports = { logSignal };
```

**Testing:**
- Log 100 signals, verify <50 queued (batched)
- Verify all signals in DB after flush
- No performance regression on request handlers

---

## Daily cron schedule (after Phase 1)

### 6:00 AM
```javascript
collectWarmupMetrics()  // Task 1.2
aggregateBounceRates() // Task 1.3
```

### 8:00 AM
```javascript
// Existing audience refresh, health snapshots, etc.
```

### Every 1 hour (optional)
```javascript
// Call /api/diagnostics/health endpoint to log infrastructure metrics
```

### 11:30 PM
```javascript
captureWorkspaceSnapshots() // Task 1.5
// Phase 3: runDailyCorrelation() — decision tree + intelligence
```

---

## Files to create/modify

| File | Type | What |
|------|------|------|
| api-diagnostics.js | New | logSignal() + queue + flush |
| api-instrumentation.js | New | Wrap PlusVibe calls with timing |
| db-postgres.js | Modify | Add diagnostic tables + helper functions |
| server.js | Modify | Add daily cron tasks + /api/diagnostics/health endpoint |

---

## Testing checklist

After each task, verify:

- [ ] Signals are in diagnostic_signals table
- [ ] Correct signal_type and metric_key
- [ ] Values are realistic and in expected range
- [ ] workspace_id is present
- [ ] Timestamps are recent
- [ ] No performance regression (< 5ms overhead per request)
- [ ] Database query performance < 100ms

---

## Success criteria (Phase 1 complete)

1. ✅ diagnostic_signals table has >10k signals after 24 hours
2. ✅ All 6 signal types represented
3. ✅ Queries on diagnostic_signals complete in <100ms
4. ✅ No errors in logs from signal collection
5. ✅ Can query: `SELECT * FROM diagnostic_signals WHERE DATE(timestamp) = CURRENT_DATE`

---

## Next phase (Phase 2)

Once Phase 1 complete and signals flowing:
- Build diagnostics.html dashboard
- Create timeline chart (6 signals × 30 days)
- Build metrics snapshot panel
- Implement root cause tree UI

---

## Start now

Pick Task 1.1 and begin. Each task is independent — can be built in parallel or sequence.

Estimated timeline: 2–3 days for all tasks.

