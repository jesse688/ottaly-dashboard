# Pre-Implementation Checklist

## Purpose

Before building the diagnostic system, we need to confirm the data foundations are solid. This checklist prevents wasted work and ensures we're not building on guesswork.

---

## Phase 0: Data validation (do this first)

Run these queries against your production Postgres database. Copy the results and confirm all gates pass.

### Gate 1: email_events table is complete

**Run in psql:**
```sql
SELECT 
  COUNT(*) as total_events,
  COUNT(DISTINCT workspace_id) as workspaces,
  COUNT(DISTINCT DATE(event_at)) as days_with_data,
  MIN(event_at)::date as earliest_date,
  MAX(event_at)::date as latest_date,
  COUNT(*) FILTER (WHERE event_type = 'bounce') as bounce_events,
  COUNT(*) FILTER (WHERE event_type = 'sent') as send_events,
  COUNT(*) FILTER (WHERE event_type = 'reply') as reply_events
FROM email_events;
```

**Must pass:**
- `total_events` ≥ 100,000 (indicates 3+ months of data)
- `workspaces` ≥ 5 (all major clients present)
- `days_with_data` ≥ 90 (continuous coverage)
- `bounce_events` > 0 (bounces are being captured)
- `send_events` > 0

**If fails:** Stop here. email_events has gaps. Debug webhook coverage before proceeding.

---

### Gate 2: Bounce events have type breakdown

**Run in psql:**
```sql
SELECT 
  event_type,
  COUNT(*) as count
FROM email_events 
WHERE event_at > NOW() - INTERVAL '7 days'
GROUP BY event_type 
ORDER BY COUNT(*) DESC;
```

**Must pass:**
- Row with `event_type='bounce'` and `count > 0`

**And:**
```sql
SELECT 
  bounce_type,
  COUNT(*) as count
FROM email_events 
WHERE event_type = 'bounce' AND event_at > NOW() - INTERVAL '7 days'
GROUP BY bounce_type;
```

**Must pass:**
- Both `'hard'` and `'soft'` bounce_type values present
- `COUNT(*)` > 100 in last 7 days

**If fails:** bounce_type field is missing or not populated. Need to add event type classification.

---

### Gate 3: Query performance is acceptable

**Run in psql:**
```sql
EXPLAIN ANALYZE
SELECT 
  DATE(event_at) as date,
  workspace_id,
  COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
  COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces,
  COUNT(*) FILTER (WHERE event_type = 'reply') as replies
FROM email_events
WHERE event_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(event_at), workspace_id
ORDER BY date DESC;
```

**Must pass:**
- Total time < 500ms
- Query plan shows index use on (workspace_id, event_at)
- No sequential scans on full table

**If fails:** indexes are missing. Add:
```sql
CREATE INDEX IF NOT EXISTS idx_ee_ws_event_at ON email_events (workspace_id, event_at DESC);
```

---

### Gate 4: Health tables exist and have data

**Run in psql:**
```sql
SELECT 
  table_name,
  (SELECT COUNT(*) FROM domain_health) as domain_health_count,
  (SELECT COUNT(*) FROM mailbox_meta) as mailbox_meta_count,
  (SELECT COUNT(*) FROM client_health_snapshots) as health_snapshots_count;
```

**Must pass:**
- All three tables exist
- `domain_health_count` > 0
- `mailbox_meta_count` > 0
- `health_snapshots_count` > 30 (ideally one per day for last month)

**If any is 0:** That table is not being populated. Debug why, or back-fill from PlusVibe API.

---

### Gate 5: workspace_stats or perf_cache exists

**Run in psql:**
```sql
SELECT 
  table_name,
  (SELECT COUNT(*) FROM workspace_stats) as workspace_stats_count,
  (SELECT COUNT(*) FROM perf_cache_daily) as perf_cache_daily_count
FROM information_schema.tables
WHERE table_name IN ('workspace_stats', 'perf_cache_daily');
```

**Must pass:**
- At least one table exists
- Recent entries (last 7 days)

**Context:** These tables drive the Stats dashboard. We'll use them as source-of-truth for campaign metrics.

---

### Gate 6: PlusVibe API is accessible

**Run in Node (from project root):**
```javascript
const https = require('https');

const PLUSVIBE_KEY = process.env.PLUSVIBE_KEY || '6425e882-f33fb46a-2837ff5a-eb535a60';
const testWorkspace = '6912ddfef9582848982b9a62'; // Accrue

https.get({
  hostname: 'api.plusvibe.ai',
  path: `/campaigns?workspace_id=${testWorkspace}`,
  headers: {
    'Authorization': `Bearer ${PLUSVIBE_KEY}`
  }
}, (res) => {
  console.log('Status:', res.statusCode);
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      const json = JSON.parse(data);
      console.log('✅ Campaigns:', json.campaigns?.length || 0);
      console.log('✅ Response time: OK');
    } else {
      console.log('❌ Error status:', res.statusCode);
      console.log('Response:', data);
    }
  });
}).on('error', (err) => {
  console.log('❌ API unreachable:', err.message);
});
```

**Must pass:**
- HTTP 200
- Response contains `campaigns` array with 5+ items
- Response time < 500ms

**If fails:** PlusVibe API is broken or auth is invalid. Contact PlusVibe support.

---

### Gate 7: Existing stats endpoints are accurate

**Run in browser or curl:**
```bash
curl 'http://localhost:3000/api/stats?workspace_id=6912ddfef9582848982b9a62&days=7'
```

**Expected response:**
```json
{
  "sends": 5000,
  "replies": 450,
  "bounces": 150,
  "oooReplies": 20,
  ...
}
```

**Validation:** Compare against email_events:
```sql
SELECT 
  COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
  COUNT(*) FILTER (WHERE event_type = 'reply') as replies,
  COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces
FROM email_events
WHERE workspace_id = '6912ddfef9582848982b9a62'
  AND event_at > NOW() - INTERVAL '7 days';
```

**Must pass:**
- Counts match (within 5%)
- If they don't, log the discrepancy and document it

**If very different:** stats cache is stale. Debug campaignCache update logic.

---

## Phase 0 completion

You'll know Phase 0 is complete when:
- [ ] All 7 gates pass
- [ ] Any gaps identified and documented
- [ ] No "show-stoppers" (e.g., email_events is 30% complete, or API is unreachable)

**If a gate fails:** 
- Note which one and why
- Fix the underlying issue
- Re-run the gate
- Don't proceed to Phase 1 until all gates pass

---

## Phase 1 start criteria

You can start Phase 1 (build diagnostic tables) **only after ALL gates pass**.

---

## Post-Phase 1: Additional validations

After Phase 1 (signal collection) is built, run these:

### Validation 1a: Signal collection is working

```javascript
// After first 24h of diagnostic system running:
const signals = await db.query(`
  SELECT 
    signal_type,
    COUNT(*) as count
  FROM diagnostic_signals
  WHERE timestamp > NOW() - INTERVAL '24 hours'
  GROUP BY signal_type;
`);
console.log('Signals collected:', signals.rows);
```

**Must pass:**
- At least 5 signal types present
- Each signal type has > 100 data points (per hour sampling)

---

### Validation 1b: Query performance on diagnostic data

```javascript
const start = Date.now();
const result = await db.query(`
  SELECT 
    DATE(timestamp) as date,
    signal_type,
    ROUND(AVG(metric_value)::numeric, 2) as avg_value
  FROM diagnostic_signals
  WHERE timestamp > NOW() - INTERVAL '30 days'
  GROUP BY DATE(timestamp), signal_type;
`);
const elapsed = Date.now() - start;
console.log('Query time:', elapsed, 'ms');
console.log('Row count:', result.rows.length);
```

**Must pass:**
- Query time < 500ms
- Row count = 30 days × 6 signal types = ~180 rows

---

### Validation 1c: Dashboard page loads and renders

1. Navigate to `/diagnostics.html`
2. Page should load without JS errors
3. Date picker should work
4. Charts should render (even if empty initially)

**If any fails:** debug JavaScript or chart library.

---

### Validation 2a: Decision rules are correct

After Phase 2 (dashboard) is built:

```javascript
// Test the decision tree on synthetic data
const testCases = [
  {
    name: 'All metrics normal',
    data: {sends: 1000, replies: 100, bounceRate: 0.02, warmup: 95, apiLatency: 50},
    expectedHypothesis: 'Campaign quality',
    expectedConfidence: 0.85
  },
  {
    name: 'Send drop, reply normal, warmup down',
    data: {sends: 500, replies: 45, bounceRate: 0.02, warmup: 30, apiLatency: 50},
    expectedHypothesis: 'Email account reputation',
    expectedConfidence: 0.80
  },
  // ... more test cases
];

for (const testCase of testCases) {
  const result = runDiagnosticRules(testCase.data);
  const topHypothesis = result[0];
  if (topHypothesis.label.includes(testCase.expectedHypothesis)) {
    console.log(`✅ ${testCase.name}: PASSED`);
  } else {
    console.log(`❌ ${testCase.name}: FAILED`);
    console.log(`   Expected: ${testCase.expectedHypothesis}`);
    console.log(`   Got: ${topHypothesis.label}`);
  }
}
```

**Must pass:**
- 8+ out of 10 test cases correct
- Confidence scores in range 0.5–0.95 (no absurd 0.01 or 0.99)

---

## Summary of gates

| Gate | Resource | Check | Pass criteria |
|------|----------|-------|---------------|
| 1 | email_events | Data completeness | 100k+ events, 90+ days, all clients |
| 2 | email_events | Bounce type coverage | hard + soft bounces present |
| 3 | email_events | Query performance | < 500ms for 30-day aggregate |
| 4 | Health tables | Table existence | domain_health, mailbox_meta, health_snapshots populated |
| 5 | Stats cache | Table existence | workspace_stats or perf_cache with recent data |
| 6 | PlusVibe API | Endpoint health | HTTP 200, <500ms response |
| 7 | Stats endpoint | Accuracy | Matches email_events counts (±5%) |

**Gating rule:** Proceed only if all 7 gates pass.

---

## What happens if a gate fails?

| Failure | Impact | Recovery |
|---------|--------|----------|
| email_events incomplete | Decision tree will have false negatives (miss real issues) | Debug webhook handler, backfill from PlusVibe API |
| Bounce types missing | Can't distinguish hard/soft bounces, diagnosis less precise | Add bounce type classification to webhook handler |
| Query performance bad | Dashboard will be unusably slow | Add indexes on (workspace_id, event_at) |
| Health tables empty | Can't surface domain/mailbox health signals | Backfill from PlusVibe API daily |
| Stats cache missing | Can't aggregate campaign metrics | Ensure stats endpoint is populating workspace_stats |
| PlusVibe API broken | Can't collect account health, API latency metrics | Contact PlusVibe, check API key, verify network access |
| Stats inaccurate | Decision tree will misdiagnose (e.g., think campaign issue when it's delivery) | Debug campaignCache staleness, check email_events completeness |

---

## Who should run Phase 0?

**Jesse** (you) — you have:
- Access to production Postgres
- Access to PlusVibe API key
- Knowledge of which workspaces are active

You can run the gates in 15–20 minutes and confirm readiness.

---

## Next action

1. Run the 7 gates from Phase 0
2. Post the results (just paste the query output)
3. I'll review for show-stoppers
4. If all clear, we proceed to Phase 1 implementation

