# Pre-Build Validation: Verify the diagnostic system will work

Before writing any code, validate that the data sources, queries, and logic are sound. This prevents guesswork.

---

## 1. Verify data already exists for all signals

### 1.1 email_events table — the authoritative source for sends/replies/bounces

**Question:** Does `email_events` have complete historical data to train on?

**Validation:**
```sql
-- Check 1: Table exists and has data
SELECT COUNT(*) as total_events, 
       MIN(timestamp) as earliest, 
       MAX(timestamp) as latest
FROM email_events;
```

**Expected result:** 
- `total_events` > 100,000 (3+ months of data)
- `latest` ≈ today
- `earliest` ≈ 3+ months ago

**Check 2: Event type distribution**
```sql
SELECT event_type, COUNT(*) 
FROM email_events 
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY event_type
ORDER BY COUNT(*) DESC;
```

**Expected result:**
- 'sent' events >> 'reply' events (10:1 or more)
- 'bounce' events present (hard + soft)
- 'ooo_reply' events present (subset of replies)
- No huge imbalances (e.g., 'sent' = 1,000,000 but 'bounce' = 0)

**Check 3: Workspace granularity**
```sql
SELECT workspace_id, COUNT(*) 
FROM email_events 
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY workspace_id
ORDER BY COUNT(*) DESC;
```

**Expected result:**
- All major clients present
- Event counts make sense per client (proportional to their campaign volume)
- No clients with zero events in last 7 days (they should all be active)

**Check 4: Bounce type detection**
```sql
SELECT bounce_type, COUNT(*) 
FROM email_events 
WHERE event_type = 'bounce' AND timestamp > NOW() - INTERVAL '7 days'
GROUP BY bounce_type;
```

**Expected result:**
- Both 'hard' and 'soft' bounces present
- Hard bounces > 0 (malformed email, domain reject)
- Soft bounces > 0 (temp fails)
- Hard bounces << total bounces (ratio ~1:3)

**If any check fails:** email_events is incomplete. Root cause: webhook coverage gaps. Need to investigate what percentage of PlusVibe events are being captured. If < 80%, the diagnostic system can't be trusted.

---

### 1.2 PlusVibe API — can we fetch account health + campaign data?

**Question:** Can we reliably fetch warmup %, account status, campaign metrics from PlusVibe for all clients?

**Validation:**
```javascript
// Test: Fetch one client's data via PlusVibe API
const workspaceId = '6912ddfef9582848982b9a62'; // Accrue
const response = await fetch('https://api.plusvibe.ai/campaigns?workspace_id=' + workspaceId, {
  headers: { 'Authorization': 'Bearer ' + process.env.PLUSVIBE_API_KEY }
});
const data = await response.json();
console.log('Status:', response.status);
console.log('Campaign count:', data.campaigns?.length);
console.log('Fields present:', Object.keys(data.campaigns?.[0] || {}));
```

**Expected result:**
- HTTP 200
- `data.campaigns` array with 5+ campaigns
- Each campaign has: `id`, `status`, `sends`, `replies`, `template_name`
- Response time < 500ms

**Check 2: Account health endpoint**
```javascript
// Test: Fetch account/warmup data
const response = await fetch('https://api.plusvibe.ai/account?workspace_id=' + workspaceId, {
  headers: { 'Authorization': 'Bearer ' + process.env.PLUSVIBE_API_KEY }
});
const data = await response.json();
console.log('Accounts:', data.accounts?.length);
console.log('Account fields:', Object.keys(data.accounts?.[0] || {}));
```

**Expected result:**
- HTTP 200
- `data.accounts` array (1–50 accounts per workspace)
- Each account has: `email`, `status`, `warmup_inbox_pct`, `warmup_spam_pct`
- Response time < 500ms

**If either check fails:** PlusVibe API is broken or has changed. Need to debug auth, check API docs, test with curl.

---

### 1.3 Existing stats endpoints — are they accurate?

**Question:** Do existing `/api/stats` endpoints return correct send/reply/bounce counts that match email_events?

**Validation:**
```javascript
// Fetch stats for last 7 days
const response = await fetch('/api/stats?workspace_id=6912ddfef9582848982b9a62&days=7');
const stats = await response.json();
console.log('Stats (API):', { sends: stats.sends, replies: stats.replies, bounces: stats.bounces });

// Fetch raw email_events for same period
const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const query = `
  SELECT 
    COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
    COUNT(*) FILTER (WHERE event_type = 'reply') as replies,
    COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces
  FROM email_events
  WHERE workspace_id = $1 AND timestamp >= $2
`;
const raw = await db.query(query, ['6912ddfef9582848982b9a62', from]);
console.log('Counts (raw):', raw.rows[0]);
```

**Expected result:**
- API stats == raw counts (or differ by < 5%)
- If they differ > 5%, the discrepancy has a documented reason (e.g., "API uses campaignCache which is 1–2h delayed")

**If they don't match:** stats endpoints are unreliable. Debug: check if campaignCache is stale, or if email_events is missing recent data.

---

### 1.4 Existing health data — what's already tracked?

**Question:** What health/diagnostic data is already being collected?

**Validation:**
```sql
-- Check 1: What's in domain_health?
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM domain_health;

-- Check 2: What fields does it have?
SELECT * FROM domain_health LIMIT 1;

-- Check 3: mailbox_meta — what data is stored?
SELECT * FROM mailbox_meta LIMIT 1;

-- Check 4: client_health_snapshots — daily data?
SELECT DATE(created_at), COUNT(*) 
FROM client_health_snapshots 
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE(created_at)
ORDER BY DATE(created_at);
```

**Expected result:**
- `domain_health`: records for dmarc/spf/dkim status per domain, updated regularly
- `mailbox_meta`: per-account reputation scores, warmup %, inbox placement %
- `client_health_snapshots`: daily snapshots of health per client, complete for last 30 days

**If data is sparse:** backfill is needed before diagnostic system can work accurately.

---

## 2. Verify the decision logic will work

### 2.1 Test scenario: "All stats down, one client OK"

**Hypothesis:** workspace-specific or account-assignment issue

**Can we distinguish this?**
```sql
-- Do we have per-client, per-account granularity?
SELECT DISTINCT workspace_id FROM email_events LIMIT 1;
SELECT DISTINCT assigned_to_account_ids FROM campaign_templates LIMIT 1;
```

**Expected:** Yes, we can segment by workspace + account. If not, logic can't distinguish client-specific from global issues.

---

### 2.2 Test scenario: "Sends down, replies normal"

**Hypothesis:** Email delivery issue (not campaign quality)

**Can we distinguish?**
```sql
-- Do we have bounce rate per account?
SELECT 
  assigned_email_account,
  COUNT(*) FILTER (WHERE event_type = 'sent') as sends,
  COUNT(*) FILTER (WHERE event_type = 'bounce') as bounces,
  ROUND(100.0 * COUNT(*) FILTER (WHERE event_type = 'bounce') / 
        NULLIF(COUNT(*) FILTER (WHERE event_type = 'sent'), 0), 2) as bounce_pct
FROM email_events
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY assigned_email_account
HAVING COUNT(*) > 100;
```

**Expected:** Yes, we can see which accounts have high bounce %. If not, logic can't pinpoint delivery issues.

---

### 2.3 Test scenario: "External factor (strike)"

**Question:** Can operators log it? Does it affect the decision tree?

**Answer:** Yes, if we build the form (Phase 3). But the form needs to be **easy enough that operators will actually use it**. 

**Validation:**
- Form should require: date, description, expected_impact_pct
- Form submission should take < 30 seconds
- After submission, should re-run diagnostics for that date

---

## 3. Verify we can capture metrics in real-time

### 3.1 Can we instrument PlusVibe API calls without impacting performance?

**Test:** Wrap 1 API call with timing + logging, measure overhead
```javascript
const start = Date.now();
// Make real API call
const response = await fetch('https://api.plusvibe.ai/campaigns?workspace_id=...');
const elapsed = Date.now() - start;
console.log('Request latency:', elapsed, 'ms');

// Log to database (async, batched)
queueSignalLog({type: 'api_health', endpoint: '/campaigns', latency_ms: elapsed});
```

**Expected:** 
- API call takes 50–200ms (network dependent)
- Logging adds < 5ms (batched async)
- Throughput unchanged

**If overhead > 10ms:** need to sample (log 1 in 10 calls) or batch differently.

---

### 3.2 Can we capture warmup data daily without breaking the cron?

**Test:** Run the warmup collection logic once on real data
```javascript
// Simulate the daily cron
const workspaces = await getAllWorkspaces();
for (const ws of workspaces) {
  const accounts = await fetchPlusVieAccounts(ws.id);
  for (const acc of accounts) {
    await logSignal({
      type: 'email_account_health',
      workspace_id: ws.id,
      metric_key: 'warmup_inbox_pct',
      metric_value: acc.warmup_inbox_pct,
      timestamp: new Date()
    });
  }
}
// Measure: time taken, error rate
```

**Expected:**
- Completes in < 30 seconds
- No errors (auth works, API doesn't rate-limit)
- Logs 1–2 signals per account per workspace

---

## 4. Verify the dashboard won't be slow

### 4.1 Query performance: can we fetch 30 days of signals in < 500ms?

**Test:**
```sql
-- Simulate the diagnostics endpoint query
EXPLAIN ANALYZE
SELECT 
  DATE(timestamp) as date,
  signal_type,
  metric_key,
  AVG(metric_value) as avg_value,
  MAX(metric_value) as max_value,
  MIN(metric_value) as min_value
FROM diagnostic_signals
WHERE workspace_id = '6912ddfef9582848982b9a62'
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp), signal_type, metric_key
ORDER BY date, signal_type;
```

**Expected:**
- Query plan shows index on (workspace_id, timestamp)
- Total execution time < 500ms (with indexes)
- Result set < 10,000 rows

**If query is slow:** add indexes on (workspace_id, timestamp), (signal_type, timestamp).

---

### 4.2 Chart rendering: can we render 6 sparklines × 30 days without lag?

**Test:** Build a prototype chart with 180 data points
```javascript
// Use Chart.js or canvas to render 6 sparklines, 30 days each
// Measure: render time, frame rate
const start = performance.now();
renderChart(data, canvas);
const elapsed = performance.now() - start;
console.log('Render time:', elapsed, 'ms');
```

**Expected:**
- Render time < 500ms on modern browser
- Frame rate 60fps when interacting with chart

**If slow:** use sampling (1 point per 6 hours) or SVG canvas instead of DOM.

---

## 5. Red flags to catch

### Red flag 1: email_events is incomplete
**How to detect:** bounce count < 2% of sends, or bounce count is 0 for days when we know bounces happened.
**Action:** investigate webhook coverage. Don't proceed until email_events is > 90% complete.

### Red flag 2: PlusVibe API is flaky
**How to detect:** API calls fail intermittently, rate limits are hit, auth errors.
**Action:** test with PlusVibe team. Set up retry logic + fallback to cached data.

### Red flag 3: stats endpoints are wildly inaccurate
**How to detect:** API stats != email_events counts by > 10%.
**Action:** debug campaignCache staleness. Document the difference.

### Red flag 4: existing health data is sparse
**How to detect:** domain_health, mailbox_meta, client_health_snapshots have < 30 days of complete data.
**Action:** backfill from PlusVibe API before launching diagnostics.

---

## Gating criteria: proceed to Phase 1 only if all of these pass

- [ ] email_events has > 100k events, > 30 days of history, all major clients present
- [ ] Bounce events are captured with hard/soft types
- [ ] PlusVibe API is accessible and returns data in < 500ms
- [ ] Existing stats endpoints match email_events counts (within 5%)
- [ ] Domain health + mailbox metadata is available and up-to-date
- [ ] API instrumentation overhead tested and < 5ms
- [ ] Query performance on diagnostic data will be < 500ms (with indexes)

---

## Data validation queries (run these first)

Copy-paste these into psql before proceeding:

```sql
-- 1. Email events summary
SELECT 
  COUNT(*) as total_events,
  COUNT(DISTINCT workspace_id) as workspaces,
  COUNT(DISTINCT DATE(timestamp)) as days_with_data,
  MIN(timestamp)::date as earliest_date,
  MAX(timestamp)::date as latest_date,
  COUNT(*) FILTER (WHERE event_type = 'bounce') as bounce_events,
  COUNT(*) FILTER (WHERE event_type = 'sent') as send_events,
  COUNT(*) FILTER (WHERE event_type = 'reply') as reply_events
FROM email_events;

-- 2. Event type distribution (last 7 days)
SELECT event_type, COUNT(*) FROM email_events 
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY event_type ORDER BY COUNT(*) DESC;

-- 3. Bounces have type field?
SELECT bounce_type, COUNT(*) FROM email_events 
WHERE event_type = 'bounce' AND timestamp > NOW() - INTERVAL '7 days'
GROUP BY bounce_type;

-- 4. Workspace granularity check
SELECT COUNT(DISTINCT workspace_id) as workspace_count FROM email_events;

-- 5. Health tables exist and have data?
SELECT 'domain_health' as table_name, COUNT(*) FROM domain_health
UNION ALL
SELECT 'mailbox_meta', COUNT(*) FROM mailbox_meta
UNION ALL
SELECT 'client_health_snapshots', COUNT(*) FROM client_health_snapshots;
```

**Run these NOW. Post the results. We'll validate the data before writing any code.**

