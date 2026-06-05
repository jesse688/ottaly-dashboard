# Diagnostic System — Root Cause Analysis for Performance Dips

## Goal
When stats drop across the board, instantly identify **what category** the issue falls into (infrastructure, email health, external API, campaign quality, external factors), not just that something is wrong.

---

## Architecture

### 1. Signal Collection (new tables)

**Table: `diagnostic_signals`** — atomic health checks, sampled every 1–5 min
```
id | timestamp | signal_type | workspace_id | metric_key | metric_value | unit | status | notes
```

Signal types:
- `email_account_health` — per account: warmup %, bounce rate, SMTP success %
- `infrastructure_health` — queue depth, response latency, error rate, disk/mem
- `external_api_health` — PlusVibe API availability, latency, error rate
- `campaign_metric` — sends/replies/bounces per client (snapshot)
- `external_factor` — UK strike, ISP outage, Gmail reputation, Outlook filter changes (manual)

**Table: `diagnostic_correlation`** — computed daily
```
date | signal_category | correlated_metrics | severity | root_cause_hypothesis | confidence (0-1)
```

---

### 2. Dashboard (new page: `diagnostics.html`)

**Left panel — Timeline**
- Date range picker (last 7/14/30 days)
- Mini sparklines for each signal category
- Click to drill into a day

**Center — Root cause tree**
When you select a date with a dip:
```
📉 Stats dropped 35% on 2026-06-03

Ruling out:
  ✅ Campaign quality — reply rates normal, copy unchanged
  ✅ Client-specific — all 12 clients affected equally
  ✅ Email account issues — warmup %, SMTP success %, bounce rates all normal

Likely culprits:
  🔴 PlusVibe API latency spiked 40% (9:00–11:30 UTC)
  🔴 UK Royal Mail strike (announced 2026-06-02, delivered 40% fewer items)
  ⚠️  Google reputation score dropped 15 points (inferred from Postmaster Tools)

Verdict: External API degradation + mail strike = compound effect
```

**Right panel — Metrics snapshot**
For selected date, show:
- Reply rate (7d baseline vs selected date)
- Email send rate (throughput, success %)
- Bounce rate (soft + hard)
- Queue depth (PlusVibe push lag)
- Warmup metrics per account
- PlusVibe API health (latency, error %)
- External factors (strikes, ISP outages)

---

### 3. Data sources & integrations

| Signal | Source | Frequency | Cost | Who captures it |
|--------|--------|-----------|------|-----------------|
| **Sends/replies/bounces** | `email_events` + PlusVibe API | Real-time webhook | Free | Webhook handler |
| **Account warmup %** | PlusVibe API `/account` or manual cron | Daily 6am | Free | Cron job |
| **Bounce rate / SMTP errors** | Reacher logs + bounce events | Real-time | Free | Webhook handler |
| **Queue depth** | PlusVibe push endpoint response time | Per request | Free | API caller |
| **PlusVibe API latency** | Instrument each PV call | Real-time | Free | Server.js HTTP layer |
| **Infrastructure** | Node process (memory, CPU, event loop lag) | Every 30s | Free | Health check endpoint |
| **External factors** | Manual + calendar (UK strikes, ISP alerts) | As-reported | Free | Operator |

---

### 4. Diagnostic rules (decision tree)

**IF all metrics normal → campaign quality issue**
- Check: reply rate changed? Subject line decay? New/paused campaigns?
- Action: pull `campaign_variant_stats` for last 7 days, compare to 30d baseline

**IF reply rate normal, sends down → email delivery issue**
- Check: warmup %, bounce rate, SMTP errors, queue depth, PV API errors
- Action: drill into per-account bounce rates, check Postmaster Tools, verify DMARC

**IF reply rate down but sends normal → inbox placement or engagement issue**
- Check: Gmail/Outlook reputation scores (from Postmaster Tools), account warmup %
- Action: check `domain_health` table, look for recent mailbox changes

**IF all external APIs normal, one client OK, others down → workspace/account issue**
- Check: per-client bounce rates, per-account warmup, assigned email accounts health
- Action: isolate which accounts are assigned to affected clients

**IF everything down except one region/vertical → external factors**
- Check: strike calendars, ISP alerts, Gmail filter changes, rate limit changes
- Action: manual audit + log as `external_factor` signal

---

## Implementation Phases

### Phase 1: Signal collection (baseline)
1. Create `diagnostic_signals` table
2. Instrument PlusVibe API calls (latency, error rate)
3. Capture warmup metrics from PlusVibe daily
4. Add bounce rate aggregation from `email_events`
5. Create health check endpoint returning infrastructure metrics

### Phase 2: Dashboard
1. Create `diagnostics.html` + basic layout
2. Charts: timeline of all signals over 30 days
3. Drill-down: select a date → show all metrics for that date
4. Manual correlation UI: operator can log external factors (strikes, ISP alerts)

### Phase 3: Decision tree automation
1. Implement correlation logic (daily job)
2. Auto-generate hypothesis + confidence score
3. Surface top-3 root cause candidates
4. Alert operator when confidence > 80% on a new issue type

### Phase 4: Integration with Client Health & Alerts
1. Client Health page surfaces diagnostics findings
2. Daily email to account manager includes root cause hypothesis for any dips

---

## Key tables

### diagnostic_signals
```sql
CREATE TABLE diagnostic_signals (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  signal_type TEXT NOT NULL, -- email_account_health, infrastructure, api_health, campaign, external
  workspace_id TEXT,
  metric_key TEXT NOT NULL, -- e.g. "warmup_pct", "bounce_rate", "pv_api_latency_ms"
  metric_value FLOAT NOT NULL,
  unit TEXT, -- %, ms, count, etc.
  status TEXT, -- normal, warning, critical
  notes TEXT,
  INDEX idx_signal_type_timestamp (signal_type, timestamp),
  INDEX idx_workspace_timestamp (workspace_id, timestamp)
);
```

### diagnostic_correlation
```sql
CREATE TABLE diagnostic_correlation (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  signal_category TEXT NOT NULL,
  correlated_metrics JSONB, -- {"metric1": change%, "metric2": change%}
  severity TEXT, -- low, medium, high, critical
  root_cause_hypothesis TEXT,
  confidence FLOAT, -- 0–1
  manual_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### diagnostic_external_factors
```sql
CREATE TABLE diagnostic_external_factors (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  factor_type TEXT, -- strike, isp_outage, filter_change, rate_limit_change
  description TEXT,
  regions_affected TEXT[], -- ['UK', 'US-East'] etc.
  severity TEXT, -- low, medium, high
  expected_impact TEXT, -- % decline expected
  created_by TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Success criteria

1. **When stats drop:** operator runs diagnostics page → within 30 seconds sees root cause in top-3 candidates
2. **Correlation accuracy:** by month 2, 80%+ of auto-generated hypotheses are correct (validated by operator feedback)
3. **External factors logged:** operator logs strike/ISP outages as they happen → system accounts for them in correlation
4. **Decision tree working:** rules correctly isolate campaign issues from infrastructure issues 95%+ of the time

---

## Future: ML-based anomaly detection

Once 3–6 months of signal data accumulated:
- Train an anomaly detector on normal baselines (per workspace, per day-of-week, per season)
- Flag anomalies in real-time
- Learn common correlated patterns (e.g., "PV API spike + queue depth spike = 80% chance of 4-hour delivery lag")

