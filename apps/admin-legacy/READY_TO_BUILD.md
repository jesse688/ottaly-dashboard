# Ready to Build — Phase 1 Signal Collection

## TL;DR

You now have:
- 134k+ email events (99 days)
- 6 diagnostic tables initialized
- Complete Phase 1 implementation guide with code examples
- All validation gates passing

**Start building Task 1.1 now.** Timeline: 2–3 days to complete Phase 1.

---

## What the system will do

### After Phase 1 (2–3 days)
Real-time signals flowing into database. You can manually query patterns:
```sql
SELECT signal_type, metric_key, AVG(metric_value), COUNT(*)
FROM diagnostic_signals
WHERE DATE(timestamp) = CURRENT_DATE
GROUP BY signal_type, metric_key;
```

### After Phase 2 (1–2 days)
Dashboard shows last 30 days of signals with timeline + metrics snapshot. Operator can drill down.

### After Phase 3 (2–3 days)
Auto-diagnosis: when stats drop, decision tree identifies root cause in seconds.

### After Phase 4 (1–2 days)
Intelligence dashboard shows "Here's how to improve: high-intent lists do 233% better, rotate copy every 3 weeks."

---

## Phase 1: 6 tasks

| Task | What | Time | Code |
|------|------|------|------|
| 1.1 | Instrument PlusVibe API calls | 0.5 days | In PHASE1_IMPLEMENTATION.md |
| 1.2 | Collect warmup metrics (6am cron) | 0.5 days | In PHASE1_IMPLEMENTATION.md |
| 1.3 | Aggregate bounce rates (SQL query) | 0.5 days | In PHASE1_IMPLEMENTATION.md |
| 1.4 | Infrastructure health endpoint | 0.5 days | In PHASE1_IMPLEMENTATION.md |
| 1.5 | Campaign metric snapshots | 0.5 days | In PHASE1_IMPLEMENTATION.md |
| 1.6 | logSignal() helper + queue | 0.5 days | In PHASE1_IMPLEMENTATION.md |

**Total: 2–3 days. All tasks independent — can be done in parallel or sequence.**

---

## Current state

**Database:**
- `diagnostic_signals` — ready to receive signals
- `diagnostic_correlation` — ready for Phase 3
- `diagnostic_external_factors` — ready for operator input
- `daily_intelligence_logs` — ready for Phase 3b
- `performance_patterns` — ready for Phase 3c
- `diagnostic_checks` — thresholds configured

**Data:**
- 134,375 email_events
- 99 days of history
- 11% average reply rate (realistic)
- 3% bounce rate
- Trends: good days, bad days, variance

**Documentation:**
- PHASE1_IMPLEMENTATION.md — task-by-task breakdown with code
- DIAGNOSTIC_PLAN.md — reference during build
- DIAGNOSTIC_INTELLIGENCE.md — what patterns look like
- START_HERE.md — quick orientation

---

## Success criteria

### Phase 1 complete when:
1. ✅ `diagnostic_signals` has >10k signals
2. ✅ All 6 signal types present (api, email, infrastructure, campaign, bounce, external)
3. ✅ Daily signals logged for 24h straight
4. ✅ Query performance < 100ms on 1 month of signals
5. ✅ No errors in logs from signal collection

### Test query (Phase 1 complete):
```sql
SELECT 
  signal_type,
  COUNT(*) as count,
  AVG(metric_value) as avg_value,
  MIN(timestamp) as earliest,
  MAX(timestamp) as latest
FROM diagnostic_signals
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY signal_type;
```

Should return 6 rows, hundreds of signals per type.

---

## How to start

1. **Open:** PHASE1_IMPLEMENTATION.md
2. **Read:** Task 1.1 section completely
3. **Create:** New file `api-diagnostics.js` with logSignal() helper
4. **Create:** New file `api-instrumentation.js` to wrap PlusVibe calls
5. **Test:** Log 100 signals manually, verify they appear in diagnostic_signals
6. **Move to:** Task 1.2

---

## Timeline

| Phase | Days | When |
|-------|------|------|
| 1 (signal collection) | 2–3 | Now |
| 2 (diagnostics dashboard) | 1–2 | Week 1 |
| 3 (decision rules) | 2–3 | Week 1–2 |
| 3b–3c (intelligence) | 2 | Week 2 |
| 4 (intelligence dashboard) | 1–2 | Week 2 |
| **Total** | **10–14** | **~3 weeks** |

---

## Why this works

**Reactive (Phases 1–3):** When stats drop, diagnose why in 30 seconds.
- "UK strike (95% confidence) + API latency (85%)"

**Proactive (Phases 3b–4):** Daily learning from patterns.
- "High-intent lists do 233% better"
- "Account warmup declining → likely -55% RR in 2 weeks, fix now"

**Both together:** Instant diagnosis + trend spotting + prevention.

---

## Files you'll touch

- `api-diagnostics.js` — NEW, logSignal() + queue
- `api-instrumentation.js` — NEW, wrap PV API calls
- `db-postgres.js` — MODIFY, add helper functions
- `server.js` — MODIFY, add daily cron + health endpoint

---

## Questions?

Refer to:
1. **How do I implement X?** → PHASE1_IMPLEMENTATION.md (code examples)
2. **What should I test?** → Success criteria above + task testing checklist
3. **What comes after?** → DIAGNOSTIC_PLAN.md (full roadmap)
4. **How does this help?** → START_HERE.md (use cases + examples)

---

## Go build

You're ready. All the pieces are in place. Start Task 1.1.

The system will be incredibly useful once Phase 1 is live — operators will immediately see signals feeding in, and by Phase 2 they'll have a timeline view showing 30 days of patterns.

Good luck.

