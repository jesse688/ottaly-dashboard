# Diagnostic System — Plan Summary

## What we're building

A **root cause analyzer** that answers: **"Why did performance drop on [date]?"**

Input: select a date on the dashboard → Output: ranked list of root causes with confidence scores (<30s).

Example output:
```
📉 Stats dropped 35% on 2026-06-03

Likely causes (confidence):
1. UK Royal Mail strike announced (95% — external logs confirm)
2. PlusVibe API latency spiked 2x (85% — API logs show 40ms → 120ms avg)
3. Campaign quality decline (40% — reply rates normal, unlikely)

Actions:
- Verify with PlusVibe status page
- Check Postmaster Tools for Gmail reputation
- Monitor recovery as strike ends
```

---

## How it works

### Data layer
6 signal categories collected in real-time + daily aggregation:
1. **Email account health** — warmup %, bounce rate per account
2. **Infrastructure** — memory, CPU, event loop lag, queue depth
3. **API health** — PlusVibe latency, error rates, availability
4. **Campaign metrics** — sends, replies, bounce rate per client/workspace
5. **Bounce analysis** — hard vs soft, per account, per domain
6. **External factors** — operator-logged strikes, ISP outages, policy changes

### Logic layer
Decision tree (7–10 rules) that takes a snapshot of all signals for a given date and returns:
- Top 3 hypotheses (campaign quality, delivery, reputation, external factor, infrastructure)
- Confidence score (0–1) for each
- Evidence supporting each hypothesis
- Drill-down links (e.g., "See per-account bounce rates")

### UI layer
Three-column dashboard:
- **Left:** 30-day timeline, 6 signal sparklines, color-coded by severity
- **Center:** metrics snapshot for selected date
- **Right:** root cause tree, hypotheses ranked by confidence

---

## Three concerns we're addressing

### 1. "Everything is down — whose fault is it?"
**Ruled out by decision tree:**
- ✅ Client-specific? (all clients affected equally → global issue)
- ✅ Campaign issue? (reply rates normal → not copy decay)
- ✅ Email account issue? (warmup %, bounce rate normal → not reputation)
- ✅ Infrastructure issue? (memory, CPU, queue normal → not server bottleneck)

→ Conclusion: **External factor** (strike, ISP outage, Gmail filter change, rate limit)

### 2. "Sends are down but replies are normal"
**Hypothesis:** Email delivery issue (not campaign quality)

**Evidence:**
- Bounce rate spiked? → hard bounce issue, check DMARC/SPF
- Warmup % dropped? → account reputation hit
- Queue depth spiked? → infrastructure bottleneck

### 3. "One client is fine, others are down"
**Hypothesis:** Client-specific or account-specific issue

**Evidence:**
- Same email accounts assigned to all clients? → shared account issue
- Different accounts per client? → one account's reputation dropped
- Client-specific campaigns paused? → campaign configuration issue

---

## What you'll get

### Immediately (Phase 1–2, ~3–4 days)
- Raw diagnostic dashboard with 6 signals on timeline
- Metrics snapshot for any selected date
- Manual drill-down to find the issue

### Within a week (Phase 3)
- Automated decision tree ranking hypotheses by confidence
- External factors form (so you can log strikes, rate limits, policy changes)
- Daily correlation job that runs at night and surfaces anomalies

### Optional, future (Phase 4)
- Client Health page integration (shows diagnostics for that client)
- Daily email digest ("Anomaly detected: X% confidence in hypothesis Y")

---

## Implementation roadmap

| Phase | What | Days | Risk | Validation |
|-------|------|------|------|-----------|
| 1 | Create signal tables, instrument API calls, collect warmup/bounce/infra metrics | 2 | Low | All signals populated with real data |
| 2 | Build dashboard: timeline, metrics snapshot, drill-down | 1–2 | Low | Page loads, charts render, no JS errors |
| 3 | Implement decision rules, daily correlation, external factors form | 2–3 | High | Rules tested on 10+ synthetic scenarios, confidence > 85% |
| 4 | Integration: Client Health, email digest | 1–2 | Low | Optional for MVP |

**MVP = Phase 1 + 2 + 3 = 1 week**

---

## Before we start: validation

We need to run data validation queries to ensure:
1. `email_events` table is complete (>100k events, all bounce types present)
2. PlusVibe API is accessible and reliable
3. Existing stats endpoints are accurate
4. Query performance will be acceptable

**Action:** Run the queries in `DIAGNOSTIC_VALIDATION.md` (section 5). Post the results here. We'll validate before writing Phase 1 code.

**Critical gates:** 
- email_events must have >100k events and >30 days of history
- Bounce events must include hard/soft types
- Query performance on 30 days of signals must be <500ms

If any gate fails, we debug first before proceeding.

---

## Why this approach works

1. **Atomic signals** — each signal is independent, so we can reason about them individually and in combination
2. **Decision tree** — captures human intuition ("if everything is normal except bounce rate, then it's a delivery issue") in code
3. **Confidence scores** — we're honest about uncertainty. A rule only fires at >85% confidence, and operator can override
4. **External factors** — acknowledges that not everything is in your control (strikes, ISP outages, Gmail policy changes)
5. **Incremental** — Phase 1 gives you a dashboard to drill into manually. Phase 2 adds automation. You can deploy Phase 1 and see value immediately.

---

## Questions to answer before Phase 1

1. **Q:** Can we access Postmaster Tools data (Gmail reputation score) programmatically?
   **A:** (Need to check) Postmaster Tools has an API, but it's not exposed in server.js yet. For MVP, we'll note "Check Postmaster Tools manually" as a drill-down action.

2. **Q:** Do we track DMARC/SPF/DKIM per domain?
   **A:** Yes, `domain_health` table has this. Phase 1 will include this in the metrics snapshot.

3. **Q:** Should we log every API call or sample?
   **A:** Start with sampling (1 in 10 calls) to measure overhead. If <5ms, log all. If >10ms, keep sampling.

4. **Q:** How do operators know to log external factors?
   **A:** Operator sees anomaly alert → "Confidence 85% in hypothesis X. Are you aware of any external factors?" → clicks "Log external factor" button → form opens.

5. **Q:** What if the diagnosis is wrong?
   **A:** Operator logs feedback ("Nope, actually was campaign issue") → confidence score is lowered for that rule in future. After 3 months, we retrain thresholds.

---

## Next step

1. **Run validation queries** (DIAGNOSTIC_VALIDATION.md section 5)
2. **Post results** 
3. **Review gating criteria** — do we pass all 6?
4. **If yes:** Start Phase 1
5. **If no:** Debug, then restart validation

