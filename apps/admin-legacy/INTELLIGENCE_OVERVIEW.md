# Complete Intelligence System — Root Cause Analyzer + Performance Learning

## Two systems, one data foundation

### System 1: Root Cause Analyzer (Reactive)
**When:** Something goes wrong  
**What:** Diagnose why performance dropped on a specific date  
**Output:** Ranked hypotheses with confidence scores  
**User:** "Stats dropped 35% on June 3. What happened?"  
**Answer:** "UK strike (95% confidence) + PlusVibe API latency spike (85%)"

**Scope:** Phases 1–3 = ~1 week

---

### System 2: Performance Intelligence (Proactive)
**When:** Daily, to learn patterns  
**What:** Track good days + bad days, build pattern library, predict performance, recommend actions  
**Output:** "Here are 5 actions to take this week to improve performance"  
**User:** "How do we go from 8% to 15% reply rate?"  
**Answer:** "High-intent lists do 16.8% (233% lift). Rotate copy every 3 weeks. Enable 3-day spacing. Prioritize warmup >80%."

**Scope:** Phases 3b–4c = ~5 days additional

---

## Why both systems?

They complement each other:
- **Root cause analyzer** answers "what went wrong?" (defensive)
- **Intelligence system** answers "how do we get better?" (offensive)

Example workflow:
1. Stats drop on June 3 → Root cause analyzer says: "UK strike" (external, can't control)
2. Intelligence dashboard says: "Even without strikes, our trend is declining 5%/week"
3. Action: "Warmup has been declining. Check DMARC alignment. Priority: fix warmup."
4. Two weeks later: "Warmup recovered. RR back to 12%."
5. Intelligence system learns: "Warmup decline correlates with -55% RR. Implement weekly warmup monitoring."

---

## Data model

### Core signals (collected real-time)
1. **Email account health** — warmup %, bounce rate, SMTP success %
2. **Infrastructure health** — memory, CPU, queue depth, event loop lag
3. **API health** — PlusVibe latency, error rates
4. **Campaign metrics** — sends, replies per client/workspace
5. **Bounce analysis** — hard vs soft, per account
6. **External factors** — strikes, ISP outages (operator-logged)

**Storage:** `diagnostic_signals` table (atomic readings, indexed for speed)

---

### Daily aggregates (computed at 11:30pm)

**For root cause analyzer:**
- `diagnostic_correlation` — signals + hypotheses + confidence scores per date

**For intelligence system:**
- `daily_intelligence_logs` — performance tier + signals present + correlated patterns + insights
- `performance_patterns` — pattern library with correlation strength scores

**Storage:** 3 tables, normalized for efficient querying

---

## Intelligence pipeline (daily, 11:30pm)

```
Day N, 11:30pm:

1. Aggregate signals for day (email_events, PlusVibe API, infrastructure)
2. Compute metrics: reply rate, bounce rate, warmup, API health
3. Classify performance tier: 🟢 Excellent, 🟡 Good, 🟠 Fair, 🔴 Poor
4. Identify signals present: what campaigns, accounts, external factors were involved
5. Look up historical pattern correlations
6. Generate insights: "This day was like May 22 (high-intent list, 3-day spacing)"
7. Store in daily_intelligence_logs
8. Update performance_patterns rolling averages

8am next day:

9. Dashboard displays:
   - Performance tier prediction
   - Top 5 actions to take
   - Trend analysis (improving? declining?)
```

---

## Four dashboard pages

### 1. Diagnostics page (`/diagnostics.html`)
**Purpose:** Root cause analysis  
**Sections:**
- 30-day timeline (6 signals)
- Metrics snapshot (for selected date)
- Root cause tree (top 3 hypotheses with confidence)
- External factors log (operator-logged events)

**User:** "Stats dropped June 3. Why?"  
**Time:** < 1 second to answer

---

### 2. Intelligence page (`/intelligence.html`)
**Purpose:** Pattern learning + performance prediction  
**Sections:**
- Performance tier distribution pie chart (last 90 days)
- Top performance drivers (correlation scores > +50% lift)
- Patterns to avoid (correlation scores < -30%)
- Today's prediction (expected performance tier + confidence)
- Actionable recommendations (top 5 things to do this week)
- Trend analysis (reply rate, bounce, warmup over 12 weeks)

**User:** "How do we improve?"  
**Time:** 2 minutes to read, act on recommendations

---

### 3. Client Health page (existing, enhanced)
**Integration:** Links to diagnostics for that client  
**New:** Intelligence predictions for that client  
**Example:** "Accrue is trending down 5% week-over-week. See root causes: warmup health. See recommendations: rotate copy."

---

### 4. Daily email digest (optional)
**Frequency:** Daily if anomaly detected, weekly digest otherwise  
**Contents:**
- Performance score for the day
- Top hypothesis if anomaly (with confidence)
- Top 1–2 actionable recommendations
- Link to full diagnostics page

---

## Intelligence examples

### Example 1: Pattern discovery
**Query:** "What makes days with 15%+ reply rate?"
**Data:**
- 12 excellent days (>15% RR) identified
- Common signals: high-intent lists (9 days), new copy <14 days (11 days), warmup >80% (10 days), 3-day spacing (8 days)
**Output:** "High-intent lists appear in 75% of excellent days (233% lift). Fresh copy in 92% of excellent days (156% lift)."

### Example 2: Seasonal/weekly pattern
**Query:** "Do Mondays underperform?"
**Data:**
- Monday avg reply rate: 7.8%
- Tue–Fri avg: 12.3%
**Output:** "Mondays: -37% below average. Stop Monday sends. Shift to Tue–Wed. Estimated lift: +20%."

### Example 3: Trend detection
**Query:** "Is warmup declining?"
**Data:**
- 90-day trend: 85% → 72% (declining)
- Correlation: warmup drop correlates with -55% RR decline
**Output:** "Warmup declining 2%/week. Critical: check DMARC alignment, enable more warmup sends."

### Example 4: Account cohort comparison
**Query:** "Do warm accounts outperform cold accounts?"
**Data:**
- Warm (>3mo): avg 11.2% RR
- Medium (1–3mo): avg 8.4% RR
- Cold (<1mo): avg 5.1% RR
**Output:** "Account age matters. Warm accounts: 219% better than cold. Implication: build warm account pool first."

### Example 5: Campaign rotation recommendation
**Query:** "How long before copy decays?"
**Data:**
- New copy (0–7 days): avg 14.1% RR
- Middle (8–21 days): avg 11.2% RR
- Aging (22–35 days): avg 6.8% RR
- Old (>35 days): avg 2.1% RR
**Output:** "Copy decays fast. Rotate every 3 weeks. After 3 weeks, RR drops 40%."

---

## What operators will love

✅ **No more guessing.** When stats drop, see diagnosis in 30 seconds.  
✅ **No more firefighting.** Proactive alerts: "Warmup declining. Act now before RR follows."  
✅ **Better decisions.** "High-intent lists work 3x better than Apollo." Prioritize list sourcing.  
✅ **Learnings compound.** Each month adds confidence to pattern scores. System gets smarter.  
✅ **Visible trends.** "We're improving. Warmup up 5% month-over-month, RR stable despite headwinds."

---

## Implementation notes

### High-confidence items (we know these will work)
- Signal collection (already have the data)
- Daily aggregation (straightforward SQL)
- Pattern library (correlation math is simple)
- Diagnostics dashboard (UI is straightforward)

### High-risk items (need validation)
- Decision tree rules (might have false positives initially)
- Confidence scoring (calibration takes feedback)
- Predictive model (needs 3–6 months of data before 80%+ accuracy)

### Success criteria
1. **Root cause analyzer:** Operator confirms top hypothesis is correct 75%+ of the time
2. **Intelligence system:** Recommended actions improve metrics 60%+ of the time (measured 2 weeks later)
3. **Adoption:** Operators use intelligence page daily, act on recommendations

---

## Build order

### MVP (1.5 weeks)
1. Phase 0: Validation gates ✓ (0.25 days)
2. Phase 1: Signal collection (2–3 days)
3. Phase 2: Diagnostics dashboard (1–2 days)
4. Phase 3: Decision rules + correlation (2–3 days)
5. Phase 3b: Intelligence collection (1 day)
6. Phase 3c: Pattern correlation queries (1 day)

**Output:** Rootcause analyzer + basic intelligence collection. Can manually query patterns, but no dashboard yet.

### Phase 2 (add 5–7 days)
7. Phase 4: Intelligence dashboard (1.5 days)
8. Phase 4b: Predictive model (2 days, optional)
9. Phase 4c: Client Health integration + email (1 day)

**Output:** Full proactive system. Predictive intelligence + daily recommendations.

---

## Files created

| File | Size | Content |
|------|------|---------|
| DIAGNOSTIC_SYSTEM.md | 7.4K | Root cause analyzer architecture |
| DIAGNOSTIC_PLAN.md | 19K | Detailed phase-by-phase implementation |
| DIAGNOSTIC_INTELLIGENCE.md | 12K | Pattern learning + intelligence system |
| DIAGNOSTIC_VALIDATION.md | 13K | Data validation approach + gates |
| PRE_IMPLEMENTATION_CHECKLIST.md | 11K | Gates + recovery steps |
| PLAN_SUMMARY.txt | 7.7K | TL;DR |
| INTELLIGENCE_OVERVIEW.md | This file | Comprehensive overview |

---

## Next action

1. Run Phase 0 validation gates (7 SQL queries)
2. Post results
3. If all pass: start Phase 1 implementation
4. If any fail: debug, fix, re-validate

Once Phase 1 complete, data flows in. Phase 2–4 builds on top.

---

## Questions?

**Q: Can we start Phase 1 before we finish Phase 4?**  
A: Yes. Phase 1–3 gives you root cause analyzer. You can run diagnostics manually while Phase 4 UI is being built. Phase 3b–3c adds intelligence collection in background.

**Q: What if a pattern turns out to be wrong?**  
A: Operator provides feedback. Confidence score for that pattern is lowered. After enough feedback, it gets deprioritized. System learns.

**Q: How long before intelligence is useful?**  
A: After ~30 days, you have enough data to spot patterns. After ~90 days, confidence is high (80%+). After 6+ months, patterns are very reliable.

**Q: Will this replace human judgment?**  
A: No. It's a tool to surface data-driven insights. Operators still decide what to do with recommendations. Feedback loop: operator confirms/refutes, system learns.

