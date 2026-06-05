# Diagnostic Intelligence — Track good + bad days to learn patterns

## Vision

**Current:** Root cause analyzer answers "Why did performance drop on 2026-06-03?"

**New:** Performance intelligence system learns from history — tracks good days + bad days, identifies patterns, suggests actions to replicate good days and avoid bad days.

Example intelligence output:
```
📊 Performance Pattern Analysis (last 30 days)

Excellent days (reply rate >15%):
  2026-05-28: 18.2% RR — New prospect campaign launched (high-intent list)
  2026-05-22: 17.1% RR — Warmed account batch, 3-day spacing
  2026-05-15: 16.8% RR — Client X refreshed copy + targeting

Bad days (reply rate <5%):
  2026-06-02: 2.1% RR — UK strike (external), PlusVibe API latency spike
  2026-05-30: 4.2% RR — Email account warmup dropped 40% (reputation hit)
  2026-05-10: 3.8% RR — Old campaign, 5th+ touch, diminishing returns

Actionable insights:
  ✅ Prospect list quality matters more than volume (high-intent = 3x higher RR)
  ✅ Account warmup is critical — drops >30% correlate with 50% RR decline
  ✅ Campaign age matters — copy decays after 3–4 weeks, restart with fresh angle
  ✅ Spacing helps — 3-day spacing between sends = 20% higher open rate vs 1-day
  ✅ External factors (strikes) can't be controlled, but PlusVibe API latency can

Recommendations:
  1. Audit warmup health weekly — monitor for reputation drops
  2. Rotate copy every 3 weeks (even if subject line is still performing)
  3. Prioritize high-intent lists over volume (Accrue outperforms Apollo 3:1)
  4. Enable 3-day spacing on new campaigns
```

---

## Architecture changes

### New signal: **Performance quality tier**

Instead of just tracking "up/down," classify each day as:
- 🟢 **Excellent:** Reply rate >15%, bounce <3%, warmup >80%
- 🟡 **Good:** Reply rate 10–15%, bounce <5%, warmup >70%
- 🟠 **Fair:** Reply rate 5–10%, bounce 5–8%, warmup >60%
- 🔴 **Poor:** Reply rate <5%, bounce >8%, warmup <60%

Metadata per tier:
- What was different that day? (campaigns, accounts, external factors)
- What signals correlate with this tier?
- Historical frequency (how often do we hit each tier?)

### New table: `performance_patterns`

```sql
CREATE TABLE performance_patterns (
  id SERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL, -- 'campaign_type', 'account_cohort', 'external_factor', 'timing', 'copy_age'
  pattern_value TEXT NOT NULL, -- e.g., 'high-intent-list', 'warm-account-3mo', 'strike', 'tuesday', 'new-copy'
  workspace_id TEXT,
  avg_reply_rate FLOAT,
  avg_bounce_rate FLOAT,
  avg_opens FLOAT,
  sample_size INT, -- how many days with this pattern
  correlation_strength FLOAT, -- 0–1, how strongly this pattern predicts performance
  created_at TIMESTAMP DEFAULT NOW(),
  last_updated TIMESTAMP DEFAULT NOW()
);
```

### New table: `daily_intelligence_logs`

```sql
CREATE TABLE daily_intelligence_logs (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  workspace_id TEXT,
  performance_tier TEXT, -- 'excellent', 'good', 'fair', 'poor'
  reply_rate FLOAT,
  bounce_rate FLOAT,
  warmup_pct FLOAT,
  api_health FLOAT, -- 0–1, latency + error rate
  key_signals JSONB, -- {"campaign_type": "high-intent", "account_warmup_dropped": true}
  correlated_patterns TEXT[], -- patterns present today
  intelligence_notes TEXT, -- human-readable: what was special about this day
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Intelligence queries (what to generate daily)

### 1. Pattern discovery — what makes good days good?

**Query:**
```sql
-- For days with reply_rate > 15%, what patterns are present?
SELECT 
  key_signals,
  COUNT(*) as frequency,
  ROUND(AVG(reply_rate)::numeric, 2) as avg_reply_rate,
  ROUND(AVG(bounce_rate)::numeric, 2) as avg_bounce_rate
FROM daily_intelligence_logs
WHERE workspace_id = $1 
  AND date > NOW() - INTERVAL '90 days'
  AND performance_tier = 'excellent'
GROUP BY key_signals
ORDER BY frequency DESC
LIMIT 10;
```

**Output:** "High-intent lists appear in 12 excellent days (15.2% avg RR), Apollo lists in 3 excellent days (8.1% avg RR)"

### 2. Correlation scoring — which patterns predict success?

**For each pattern (e.g., "high-intent-list", "account-warmup-ok", "new-copy"):**
```sql
SELECT 
  'high-intent-list' as pattern,
  ROUND(AVG(reply_rate) FILTER (WHERE pattern_present) ::numeric, 2) as with_pattern,
  ROUND(AVG(reply_rate) FILTER (WHERE NOT pattern_present)::numeric, 2) as without_pattern,
  ROUND(100.0 * (
    AVG(reply_rate) FILTER (WHERE pattern_present) / 
    NULLIF(AVG(reply_rate) FILTER (WHERE NOT pattern_present), 0)
  )::numeric, 0) as performance_lift_pct
FROM (
  SELECT 
    reply_rate,
    key_signals ? 'high-intent-list' as pattern_present
  FROM daily_intelligence_logs
  WHERE workspace_id = $1 AND date > NOW() - INTERVAL '90 days'
) subq;
```

**Output:** "High-intent lists: 16.8% with, 7.2% without = 233% lift"

### 3. External factor filtering

**Query:**
```sql
-- On days without external factors (strikes, API issues), what's the baseline?
SELECT 
  performance_tier,
  COUNT(*) as days,
  ROUND(AVG(reply_rate)::numeric, 2) as avg_reply_rate,
  ROUND(AVG(bounce_rate)::numeric, 2) as avg_bounce_rate
FROM daily_intelligence_logs
WHERE workspace_id = $1 
  AND date > NOW() - INTERVAL '90 days'
  AND NOT (key_signals ? 'external_factor')
GROUP BY performance_tier
ORDER BY days DESC;
```

**Output:** "Baseline (no external factors): Excellent 35 days (14.2% RR), Good 28 days (11.8% RR), Fair 12 days (6.5% RR)"

### 4. Trend over time

**Query:**
```sql
-- Are we trending up or down?
SELECT 
  DATE_TRUNC('week', date)::date as week,
  ROUND(AVG(reply_rate)::numeric, 2) as avg_rr,
  ROUND(AVG(bounce_rate)::numeric, 2) as avg_br,
  ROUND(AVG(warmup_pct)::numeric, 2) as avg_warmup,
  COUNT(*) as days
FROM daily_intelligence_logs
WHERE workspace_id = $1 AND date > NOW() - INTERVAL '90 days'
GROUP BY week
ORDER BY week DESC;
```

**Output:** Weekly trend chart showing if RR, bounce, warmup are improving/declining.

---

## Daily intelligence job (runs at 11:30pm)

```javascript
async function generateDailyIntelligence(workspaceId, date) {
  // 1. Fetch that day's metrics
  const metrics = await getWorkspaceMetrics(workspaceId, date);
  const { reply_rate, bounce_rate, warmup_pct, api_health } = metrics;

  // 2. Classify tier
  const tier = classifyPerformanceTier(metrics);

  // 3. Identify signals present that day
  const signals = await identifySignalsForDay(workspaceId, date);
  // Returns: {campaign_types: ['high-intent'], account_warmup_declined: false, ...}

  // 4. Look up pattern correlations
  const patterns = await findCorrelatedPatterns(signals);
  // For each signal present, query how it usually performs

  // 5. Generate insights
  const insights = generateInsights(metrics, signals, patterns);
  // Compare today against similar days, identify outliers

  // 6. Store
  await db.query(`
    INSERT INTO daily_intelligence_logs 
    (date, workspace_id, performance_tier, reply_rate, bounce_rate, 
     warmup_pct, api_health, key_signals, correlated_patterns, intelligence_notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [date, workspaceId, tier, reply_rate, bounce_rate, warmup_pct, 
      api_health, JSON.stringify(signals), patterns, insights]);

  // 7. Update pattern correlations (rolling averages)
  await updatePatternCorrelations(workspaceId);
}
```

---

## Intelligence dashboard (new page: `intelligence.html`)

### Section 1: Performance tiers (pie chart)
```
Last 90 days:
🟢 Excellent (35 days, 39%) — avg 14.2% RR
🟡 Good (28 days, 31%) — avg 11.8% RR
🟠 Fair (15 days, 17%) — avg 6.5% RR
🔴 Poor (11 days, 13%) — avg 2.9% RR
```

### Section 2: Top performance drivers (correlation scores)
```
Patterns that predict excellent days:

1. High-intent list (233% lift) — appears in 12 excellent days
2. Account warmup >80% (185% lift) — appears in 18 excellent days
3. New copy <14 days old (156% lift) — appears in 22 excellent days
4. 3-day spacing enabled (142% lift) — appears in 14 excellent days
5. Tuesday/Wednesday send (118% lift) — appears in 17 excellent days
```

### Section 3: Patterns to avoid (negative correlation)
```
Patterns that predict poor days:

1. Campaign age >28 days (-68% from baseline) — 11 poor days
2. Warmup <60% (-87% from baseline) — 8 poor days
3. External factor present (-75% from baseline) — strike, API issue, etc.
4. Hard bounce >10% (-92% from baseline) — domain reputation issue
5. Friday/Monday send (-45% from baseline) — lower engagement
```

### Section 4: Today's prediction
```
Today (2026-06-03):
Based on current signals:
- Warmup: 82% (✅ good)
- New campaign: 4 days old (✅ good)
- No external factors (✅ good)
- Tuesday send (✅ good)

Expected performance: 🟡 Good (11–15% RR) with 85% confidence
Actual: 2.1% RR 🔴 (Poor)

What went wrong: UK strike (not predicted, external factor)
```

### Section 5: Actionable recommendations
```
To improve next week:

1. ✅ Account warmup is critical
   Your warmup: 82% (good)
   Target: >85% to avoid decline
   Action: Check Postmaster Tools, ensure 50+ daily warmup sends

2. ✅ List quality beats volume
   High-intent lists: 16.8% RR
   Apollo lists: 7.2% RR
   Action: Prioritize prospect/high-intent sources in push
   Impact: Could lift overall RR by 15–25%

3. ✅ Copy rotation every 3 weeks
   Your campaigns:
   - Campaign A: 22 days old, 6.2% RR (age showing)
   - Campaign B: 8 days old, 14.1% RR (fresh)
   Action: Pause A, launch new angle

4. ⚠️  External factors
   UK strike impact (last 48h): ~40% RR decline estimated
   When strike ends: expect recovery to baseline
   Action: Monitor strike end date, don't panic

5. 📈 Trending analysis
   Week 1 (May 26–Jun 1): 11.2% avg RR ✅
   Week 2 (Jun 2–8): 8.1% avg RR (incomplete, strike impact)
   Trend: Normal variation, not decline
```

---

## How intelligence guides decisions

### Example 1: "Should we pause this campaign?"
**Old way:** Check reply rate manually. If <5%, maybe pause.
**New way:** 
- Reply rate 4.8% (poor)
- But campaign is 22 days old (past peak)
- Remove copy age pattern: expected would be 6.2% (normal for old copy)
- Verdict: **Not a bad campaign, just needs rotation.** Pause, launch fresh angle.

### Example 2: "Why are Mondays always worse?"
**Old way:** No visibility.
**New way:**
- Query: replies on Monday vs Tuesday–Friday
- Monday avg: 7.8% RR
- Tue–Fri avg: 12.3% RR
- Correlation: -37% on Mondays
- Verdict: **Stop sending Mondays.** Shift to Tue–Wed. Estimated lift: +20%.

### Example 3: "Is our warmup degrading?"
**Old way:** Check warmup % once a week manually.
**New way:**
- Daily warmup tracked
- 90-day trend: 85% → 72% (declining)
- Correlation: warmup drop correlates with -55% RR (strong)
- Alert: **Warmup declining. Likely cause: soft bounce increase.** Check DMARC alignment.

### Example 4: "New client launch — what's realistic?"
**Old way:** Guess based on gut.
**New way:**
- Historical: high-intent lists → 16.8% RR
- Apollo lists → 7.2% RR
- This client: 70% Apollo, 30% high-intent
- Blended prediction: 9.4% RR
- Verdict: **Set target to 10–12% for Year 1.** Optimize list quality first, then copy.

---

## Implementation roadmap (add to phases)

### Phase 3b: Intelligence collection (1 day)
- Add `performance_patterns` and `daily_intelligence_logs` tables
- Daily cron: `generateDailyIntelligence()` (runs at 11:30pm after diagnostics)
- Logic: classify tier, identify signals, compute correlations

### Phase 3c: Pattern mining (1 day)
- Implement correlation queries (4 queries above)
- Weekly job: recalculate pattern strength scores
- Store in `performance_patterns` table

### Phase 4b: Intelligence dashboard (1.5 days)
- Create `intelligence.html` page
- Sections: tiers pie chart, top drivers, patterns to avoid, today's prediction, recommendations
- Charts: tier distribution, correlation scores, trend lines

### Phase 4c: Predictive model (2 days, optional)
- Logistic regression: given today's signals, predict performance tier
- ML model trained on 90+ days of data
- Output: "Based on signals, expect 80% chance of Good/Excellent day"
- Update prediction daily at 8am (before sends start)

---

## Data flow

```
Day N, 11:30pm:
  ↓
collectDailyMetrics(workspace, date)
  ↓
classifyPerformanceTier()
  ↓
identifySignalsForDay()
  ↓
findCorrelatedPatterns()
  ↓
generateInsights()
  ↓
INSERT daily_intelligence_logs
  ↓
UPDATE performance_patterns (rolling avg)
  ↓
8:00am next day:
  ↓
Display on intelligence.html:
  - "Today's prediction: 85% chance of Good day"
  - "Top 5 actions to take today"
  - "Trends: warmup declining 5% week-over-week"
```

---

## Success metrics

1. **Accuracy:** Can we predict performance tier with 80%+ accuracy? (Test: hold out last 7 days, predict)
2. **Actionability:** Do recommended actions actually move metrics? (After 4 weeks: did high-intent list push increase? Did copy rotation help?)
3. **Speed:** Can you go from "stats dropped" to "here's what to do" in 2 minutes?

---

## Known unknowns

1. **Signal causality vs correlation:** "High-intent lists correlate with 233% lift" — is it the list, or the client who uses high-intent lists is just better at follow-up? (Answer: track per-client, control for client quality)
2. **Pattern interaction:** Do patterns combine? (e.g., high-intent + new copy + warm account = even better?) (Answer: Multi-variate analysis, 4+ months of data)
3. **Seasonal factors:** Does Q3 perform differently from Q4? (Answer: Track year-over-year, flag seasonal patterns)

---

## Why this matters

**Right now:** You react to bad days (troubleshoot why stats dropped).
**With intelligence:** You proactively optimize for good days (know what makes them good, systematically replicate).

The system shifts from **reactive** (what went wrong?) to **proactive** (how do we improve?).

