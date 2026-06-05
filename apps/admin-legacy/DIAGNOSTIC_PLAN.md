# Complete Diagnostic System Plan — 100% detailed

## Executive Summary

Build a root cause analyzer that answers: **"Why did performance drop on [date]?"** by correlating 6 signal categories (email health, infrastructure, API, campaign, external factors, workspace-specific). Output: decision tree + confidence score in <30s.

**Timeline:** Phase 1 (2–3 days), Phase 2 (1–2 days), Phase 3 (2–3 days) = ~1 week for MVP.

---

## Phase 1: Database & Signal Collection (Days 1–2)

### 1.1 Create diagnostic tables (no risk)

**Why:** baseline storage for all signals. Must be in place before any instrumentation.

**Tables to create:**
1. `diagnostic_signals` — atomic readings (timestamp, signal_type, workspace_id, metric_key, metric_value, unit, status, notes)
2. `diagnostic_correlation` — daily computed correlations (date, signal_category, correlated_metrics JSONB, severity, hypothesis, confidence)
3. `diagnostic_external_factors` — operator-logged external events (date, factor_type, description, regions, severity, expected_impact)
4. `diagnostic_checks` — reusable health checks (e.g., "warmup > 90%", "bounce < 5%") with thresholds

**Implementation approach:**
- Add to `db-postgres.js` `initDb()` function
- No migrations needed — idempotent CREATE IF NOT EXISTS
- Add indexes on (signal_type, timestamp), (workspace_id, timestamp), (date)

**Validation:** 
- ✅ Tables exist and have correct schema
- ✅ Indexes are present
- ✅ INSERT/SELECT work with sample data

---

### 1.2 Instrument PlusVibe API calls (medium risk)

**Why:** capture latency + error rates. These are early warning signs of delivery issues.

**What to measure:**
- Call latency (ms) per endpoint: `/campaigns`, `/account`, `/leads`
- HTTP status codes (200, 429, 500, etc.) per endpoint
- Response parse errors

**Implementation approach:**
```javascript
// Wrap PlusVibe API calls with timing + error capture
async function pvApiCall(method, endpoint, payload, workspaceId) {
  const start = Date.now();
  try {
    const response = await fetch(...);
    const elapsed = Date.now() - start;
    
    // Log success
    logSignal({
      type: 'api_health',
      metric_key: `pv_${endpoint}_latency_ms`,
      metric_value: elapsed,
      status: response.ok ? 'normal' : 'warning',
      workspace_id: workspaceId
    });
    
    if (!response.ok) {
      logSignal({
        type: 'api_health',
        metric_key: `pv_${endpoint}_http_${response.status}`,
        metric_value: 1,
        status: 'warning'
      });
    }
    return response;
  } catch (err) {
    logSignal({
      type: 'api_health',
      metric_key: `pv_${endpoint}_error`,
      metric_value: 1,
      status: 'critical',
      notes: err.message
    });
    throw err;
  }
}
```

**Where to implement:**
- Create `api-instrumentation.js` (new file) with `logSignal()` helper + wrapper factory
- Wrap calls in `api-contacts.js` (PlusVibe push) and server.js PV fetch methods
- **Risk:** performance impact if logging is synchronous — must be async/batched

**Validation:**
- ✅ 5 sample API calls logged to `diagnostic_signals`
- ✅ No latency regression on normal requests (<5ms overhead)
- ✅ Error responses logged with status codes

---

### 1.3 Capture email account warmup metrics (low risk)

**Why:** warmup % is a canary for account reputation. Sharp drops = inbox placement issues.

**What to measure:**
- Warmup inbox % per account (from PlusVibe)
- Warmup spam % per account
- Account status (active, suspended, bouncing)

**Implementation approach:**
- Daily cron job (6am, same as audience refresh)
- Fetch `/account` for all accounts via PlusVibe API
- Parse `warmup_inbox_pct`, `warmup_spam_pct`, `account_status`
- Log to `diagnostic_signals` with workspace correlation

**Code location:**
- Add to existing daily cron in server.js (search "6am cron")
- Function: `collectWarmupMetrics()`
- Store: per email account per workspace

**Validation:**
- ✅ Data collected for all accounts
- ✅ Values are plausible (0–100% range)
- ✅ Stored with correct timestamp + workspace_id

---

### 1.4 Aggregate bounce rates from email_events (low risk)

**Why:** bounce rate is the most reliable real-time signal of delivery health.

**What to measure:**
- Hard bounces (invalid email, domain reject) — count per day
- Soft bounces (mailbox full, temporary reject) — count per day
- Bounce rate as % of sent

**Implementation approach:**
- Query `email_events` table (already indexed):
  ```sql
  SELECT 
    DATE(timestamp) as date,
    workspace_id,
    COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
    COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces,
    COUNT(*) FILTER (WHERE bounce_type = 'hard') as hard_bounces,
    COUNT(*) FILTER (WHERE bounce_type = 'soft') as soft_bounces
  FROM email_events
  GROUP BY DATE(timestamp), workspace_id
  ```
- Run daily (8am) or on-demand from diagnostics page
- Log results to `diagnostic_signals`

**Code location:**
- Add function `aggregateBounceRates()` to db-postgres.js
- Call from server.js daily cron
- Return per-workspace per-day metrics

**Validation:**
- ✅ Query returns correct counts (spot-check vs raw email_events)
- ✅ Bounce rate sensible (< 10% normal, > 20% critical)
- ✅ Metrics stored with correct date + workspace

---

### 1.5 Infrastructure health check endpoint (low risk)

**Why:** detect server-side bottlenecks (CPU, memory, event loop lag, queue depth).

**What to measure:**
- Memory usage (%)
- CPU usage (%)
- Event loop lag (ms) — time between scheduled check and execution
- Queue depth (pending PlusVibe push requests in memory)
- Request latency (p50, p95, p99)

**Implementation approach:**
```javascript
// GET /api/health/diagnostics — returns infrastructure metrics
app.get('/api/health/diagnostics', (req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  
  res.json({
    timestamp: new Date(),
    memory: {
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      heap_pct: Math.round((mem.heapUsed / mem.heapTotal) * 100)
    },
    // Add event loop lag measurement
    eventLoopLag: measureEventLoopLag(),
    // Queue metrics
    queue: {
      pending_pv_pushes: pushQueue.length,
      pending_reacher_checks: reacherQueue.length
    },
    uptime: uptime
  });
});
```

**Code location:**
- Add to server.js (new endpoint)
- Implement `measureEventLoopLag()` helper (track scheduled vs actual execution time)
- Queue depth tracked in global vars or memory store

**Validation:**
- ✅ Endpoint returns valid JSON
- ✅ Memory values realistic (< 500MB typical)
- ✅ Event loop lag < 10ms (normal), > 100ms (warning)

---

### 1.6 Campaign metric snapshots (low risk)

**Why:** isolate whether stats drop is campaign-specific or systemic.

**What to measure per workspace per day:**
- Send count (from email_events 'sent' events)
- Reply count (from email_events 'reply' events)
- OOO reply count (from email_events 'ooo_reply' events)
- Reply rate (replies / sends)
- Active campaigns count
- Template decay signals (>50% drop in subject line reply rate)

**Implementation approach:**
- Query `email_events` + `campaign_templates` to compute daily snapshots
- Already have this logic in server.js (stats endpoints) — extract into `captureWorkspaceSnapshot()`
- Run daily 11pm (after day's sends are complete) or on-demand

**Code location:**
- Create function in db-postgres.js
- Call from daily cron
- Store in new `diagnostic_signals` table with signal_type='campaign_metrics'

**Validation:**
- ✅ Snapshot counts match `/api/stats` page for same date
- ✅ Reply rates sensible (0–30% typical)
- ✅ Metrics stored per workspace per date

---

## Phase 2: Dashboard (Days 3–4)

### 2.1 Create `diagnostics.html` base page (low risk)

**What to build:**
- New page at `/diagnostics.html` (auth-required like others)
- Three-column layout: timeline (left), metrics (center), root cause tree (right)
- Date range picker (last 7/14/30 days, custom)
- Responsive grid

**Implementation approach:**
- Copy from existing page template (e.g., `stats.html`)
- Use same nav.js, splash.js, design tokens
- Stub out sections with placeholder content

**Code location:**
- New file: `public/diagnostics.html`
- New API endpoint: `GET /api/diagnostics/data?date=2026-06-03&workspace_id=...` (returns all signals for that date)

**Validation:**
- ✅ Page loads without JS errors
- ✅ Date picker works
- ✅ Responsive on mobile

---

### 2.2 Timeline chart (medium risk)

**What to build:**
- 7-row sparkline chart (one per signal category):
  - Email account health
  - Infrastructure health
  - API health
  - Campaign metrics
  - Bounce rate
  - External factors
- Each row shows last 30 days, color-coded (green=normal, yellow=warning, red=critical)
- Click on day → detail view

**Implementation approach:**
- Use Chart.js or canvas (existing stats.html uses Chart.js)
- Data source: `GET /api/diagnostics/timeline?days=30` → returns daily aggregates
- Aggregate logic: for each signal_type, compute min/max/avg per day, assign status

**Validation:**
- ✅ All 30 days display
- ✅ Colors correspond to severity
- ✅ Click functionality works

---

### 2.3 Metrics snapshot panel (low risk)

**What to build:**
- Show metrics for selected date in key-value format:
  - Reply rate (% + trend vs 7d baseline)
  - Send rate (per hour)
  - Bounce rate (% + hard/soft breakdown)
  - Warmup % per account (top 5 accounts)
  - PlusVibe API latency (p50, p95)
  - Infrastructure health (memory %, CPU %)
  - Queue depth (pending pushes)

**Implementation approach:**
- Data from `/api/diagnostics/data?date=...` endpoint
- Compute derived metrics (deltas, percentiles) server-side
- Display as grid or cards

**Validation:**
- ✅ Numbers match corresponding pages (stats, mailboxes, etc.)
- ✅ Deltas calculated correctly
- ✅ All accounts represented

---

### 2.4 Root cause decision tree (high risk — logic heavy)

**What to build:**
- Interactive tree showing decision path
- Leaf nodes: ranked list of hypotheses with confidence scores
- Each hypothesis links to drill-down data (e.g., "Account warmup collapsed → show per-account details")

**Implementation approach:**
- JavaScript decision tree on client (stateless)
- Inputs: metrics snapshot from `/api/diagnostics/data`
- Logic: implement rules from diagnostic plan section 4
- Example:
  ```javascript
  if (allMetricsNormal(snapshot)) {
    return {hypothesis: 'Campaign quality issue', confidence: 0.9, drill_into: 'campaign_variants'};
  } else if (sendsDown && repliesNormal) {
    return {hypothesis: 'Email delivery issue', confidence: 0.85, drill_into: 'bounce_rate'};
  }
  // ... more rules
  ```

**Validation:**
- ✅ Logic passes 10 synthetic test cases (scenarios with known root causes)
- ✅ Confidence scores between 0–1
- ✅ At least 3 hypotheses ranked in each scenario

---

## Phase 3: Decision Tree & Correlation Logic (Days 5–7)

### 3.1 Implement diagnostic rules (high risk)

**What to build:**
- Complete decision tree (7–10 rules, each with 2–3 conditions)
- Rules map to: root cause hypothesis + suggested drill-down
- Each rule tested against synthetic data

**Rules to implement:**

| ID | Condition | Hypothesis | Confidence | Drill-down |
|----|-----------|-----------|-----------|-----------|
| R1 | All metrics normal, reply rate down | Campaign quality | 0.9 | campaign_variant_stats |
| R2 | Sends down, replies normal, warmup OK, bounce normal | Infrastructure / queue | 0.8 | queue_depth + api_latency |
| R3 | Sends down, replies down, warmup ↓ | Email account reputation | 0.85 | per_account_warmup |
| R4 | Sends down, 1 client OK, others down | Workspace-specific | 0.75 | per_workspace_metrics |
| R5 | All metrics down equally across all workspaces | External factor | 0.7 | external_factors table |
| R6 | API latency spiked, queue depth spiked | PlusVibe API issue | 0.95 | pv_api_status |
| R7 | Bounce rate spiked hard, warmup OK | Reputation drop / ISP | 0.8 | postmaster_data + domain_health |

**Implementation approach:**
- Create `diagnostic-rules.js` (new file)
- Each rule is a pure function: `rule(snapshot) → {hypothesis, confidence, evidence, drill_into}`
- Rank rules by confidence, return top 3
- Test each rule on 3–5 synthetic test cases

**Validation:**
- ✅ 7+ rules implemented
- ✅ Each rule tested on synthetic data
- ✅ Confidence scores realistic (no 0.99+ unless rule has 2+ independent signals)

---

### 3.2 Daily correlation job (medium risk)

**What to build:**
- Nightly job (11:30pm) that runs after all signals collected
- For each workspace + date combo, run all diagnostic rules
- Store top 3 hypotheses + confidence in `diagnostic_correlation` table
- Surface "anomaly detected" alerts if any hypothesis confidence > 80%

**Implementation approach:**
- New function `runDailyCorrelation()` in server.js
- Call from existing cron system
- For each workspace:
  1. Fetch all signals for yesterday
  2. Aggregate into snapshot
  3. Run diagnostic rules
  4. Store results
  5. If anomaly detected, log alert (console + table)

**Validation:**
- ✅ Job runs daily without errors
- ✅ Correlation table populated
- ✅ Can query `SELECT * FROM diagnostic_correlation WHERE date='2026-06-02'`

---

### 3.3 External factors UI (low risk)

**What to build:**
- Operator form to log external events (strikes, ISP outages, rate limit changes)
- Form fields: date, factor_type (select), description, regions, severity, expected_impact_pct
- Stored in `diagnostic_external_factors` table
- Displayed on timeline + used in correlation logic

**Implementation approach:**
- New form on diagnostics page
- `POST /api/diagnostics/log-external-factor` endpoint
- Validator: date must be valid, description > 10 chars, impact % 0–100
- After submission, correlation rules re-run for that date

**Validation:**
- ✅ Form submits without errors
- ✅ Data stored in table
- ✅ Appears on timeline
- ✅ Affects correlation results (e.g., if strike logged, it increases confidence of "external factor" hypothesis)

---

## Phase 4: Integration (Days 7–8, optional for MVP)

### 4.1 Wire to Client Health page (low risk)

**What to do:**
- Client Health page shows recent diagnostics findings for that client
- Link: "See full diagnostics" → `/diagnostics.html?date=2026-06-03&client=...`

**Validation:**
- ✅ Links work
- ✅ Client filter applied on diagnostics page

---

### 4.2 Daily digest email (medium risk)

**What to do:**
- Account manager receives email if anomaly detected (confidence > 80%)
- Email: date, top hypothesis, confidence, link to full diagnostics page

**Validation:**
- ✅ Email sent to correct recipients
- ✅ Link works
- ✅ HTML formatting correct

---

## Risk Mitigation

### High-risk items

| Item | Risk | Mitigation |
|------|------|-----------|
| **Decision tree logic** | False positives misdiagnose root causes | Test on 10+ synthetic scenarios before shipping. Log all diagnoses for operator validation. Adjust confidence thresholds based on feedback. |
| **API instrumentation overhead** | Logging every PV call = performance regression | Batch logs asynchronously. Log a sample (1 in 10 calls) if overhead detected. Monitor response times before/after. |
| **Correlation accuracy** | Rules may miss real issues or hallucinate false causes | Start with conservative thresholds (confidence > 85%). Operator can manually override + log feedback. After 3 months, retrain thresholds. |

### Medium-risk items

| Item | Risk | Mitigation |
|------|------|-----------|
| **Timeline chart rendering** | 30 days × 6 signals = 180 data points, slow chart | Use sampling (1 point per 6 hours) or canvas instead of SVG. Test on older browser. |
| **Database query performance** | Diagnostic queries across 500k email_events = slow | Add indexes on (workspace_id, timestamp, event_type). Test query performance with EXPLAIN. Cache 30-day summaries. |
| **External factors bleeding into training data** | Rules trained on normal data, but data includes strike days | After logging external factors, re-train thresholds on "clean" days only. Or flag days as "anomalous" and exclude. |

---

## Validation plan (before shipping each phase)

### Phase 1 validation checklist
- [ ] All tables created, indexes present
- [ ] Sample INSERT/SELECT works on all tables
- [ ] 5+ API calls instrumented, latency captured
- [ ] Warmup metrics captured for all accounts
- [ ] Bounce rate aggregation query tested on real email_events
- [ ] Infrastructure health endpoint returns valid JSON
- [ ] All metrics values in sensible ranges

### Phase 2 validation checklist
- [ ] diagnostics.html loads without JS errors
- [ ] Date picker works (can select any date in last 30 days)
- [ ] Timeline chart renders all 6 signal categories
- [ ] Metrics snapshot panel displays correct numbers (spot-check vs stats page)
- [ ] Root cause tree shows at least 3 hypotheses

### Phase 3 validation checklist
- [ ] Each rule tested on 3–5 synthetic scenarios
- [ ] Daily correlation job runs without errors
- [ ] Correlation table populated with results
- [ ] Top 3 hypotheses ranked by confidence
- [ ] External factors form works + affects correlation results
- [ ] Operator can toggle hypotheses "doesn't match my experience" and see impact

### Phase 4 validation checklist
- [ ] Client Health page links to diagnostics
- [ ] Diagnostics page respects client filter
- [ ] Email digest sent to correct recipients
- [ ] Links in email work

---

## Success criteria (MVP)

1. **Speed:** operator selects a date with a performance dip → root cause tree appears in < 1s (no page reloads)
2. **Accuracy:** by month 2, operator confirms top hypothesis is correct 75%+ of the time
3. **Coverage:** decision rules can isolate: campaign quality vs infrastructure vs email health vs external factors
4. **Usability:** operator can drill down from "hypothesis" to raw data in 2–3 clicks

---

## Known unknowns (to validate during build)

1. **API instrumentation overhead** — unclear until measured. Target: < 5ms per call.
2. **Chart rendering performance** — unclear if 6 sparklines over 30 days will be smooth. May need sampling.
3. **Correlation accuracy** — rules are hypothetical. May need 2–3 iterations to get confidence thresholds right.
4. **External factor coverage** — UK strikes are one type. What other external factors matter? (ISP outages, Gmail filter changes, Outlook reputation shifts, rate limit changes). Scope this during Phase 3.

---

## Decision gate before Phase 2

After Phase 1 complete, verify:
- [ ] All signal tables populated with real data (not just schema)
- [ ] Instrumentation adds < 5ms latency per request
- [ ] Can query 30 days of signal data in < 500ms
- [ ] Sample correlations make intuitive sense

If any of these fail, iterate Phase 1 before moving to Phase 2.

