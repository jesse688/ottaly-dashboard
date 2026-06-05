-- Phase 1: Create diagnostic tables
-- Run this to initialize the diagnostic signal collection infrastructure

-- 1. Core signals table — atomic health checks, sampled every 1–5 min
CREATE TABLE IF NOT EXISTS diagnostic_signals (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  signal_type TEXT NOT NULL,
    -- email_account_health, infrastructure, api_health, campaign, external, bounce
  workspace_id TEXT,
  metric_key TEXT NOT NULL,
    -- e.g. "warmup_pct", "bounce_rate", "pv_api_latency_ms", "memory_used_mb"
  metric_value FLOAT NOT NULL,
  unit TEXT,
    -- %, ms, count, mb, etc.
  status TEXT,
    -- normal, warning, critical
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_signal_type_timestamp (signal_type, timestamp),
  INDEX idx_workspace_timestamp (workspace_id, timestamp),
  INDEX idx_signal_type (signal_type),
  UNIQUE KEY unique_signal (workspace_id, signal_type, metric_key, DATE(timestamp))
);

-- 2. Daily correlation — computed after all signals collected
CREATE TABLE IF NOT EXISTS diagnostic_correlation (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  workspace_id TEXT,
  signal_category TEXT NOT NULL,
    -- email_health, infrastructure, api_health, campaign_metrics, bounce_analysis, external
  correlated_metrics JSONB,
    -- {"send_rate": 1200, "reply_rate": 0.11, "bounce_rate": 0.03}
  severity TEXT,
    -- low, medium, high, critical
  root_cause_hypothesis TEXT,
    -- top hypothesis about what caused the metrics
  confidence FLOAT,
    -- 0–1 confidence score
  manual_notes TEXT,
    -- operator feedback
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE KEY unique_daily_correlation (workspace_id, date, signal_category),
  INDEX idx_date_workspace (date, workspace_id)
);

-- 3. External factors — operator-logged events
CREATE TABLE IF NOT EXISTS diagnostic_external_factors (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  workspace_id TEXT,
  factor_type TEXT NOT NULL,
    -- strike, isp_outage, filter_change, rate_limit_change, maintenance, other
  description TEXT,
  regions_affected TEXT[],
    -- ['UK', 'US-East'] etc.
  severity TEXT,
    -- low, medium, high, critical
  expected_impact TEXT,
    -- description of expected effect ("expect 30-40% RR decline")
  created_by TEXT,
    -- operator username
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_date (date),
  INDEX idx_workspace_date (workspace_id, date)
);

-- 4. Daily intelligence logs — performance classification + patterns
CREATE TABLE IF NOT EXISTS daily_intelligence_logs (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  workspace_id TEXT,
  performance_tier TEXT,
    -- excellent (>15% RR), good (10-15%), fair (5-10%), poor (<5%)
  reply_rate FLOAT,
  bounce_rate FLOAT,
  warmup_pct FLOAT,
  api_health FLOAT,
    -- 0–1, latency + error rate
  key_signals JSONB,
    -- {"campaign_type": "high-intent", "account_warmup": 85, "new_copy_age": 4}
  correlated_patterns TEXT[],
    -- ['high-intent-list', 'new-copy', 'warm-account']
  intelligence_notes TEXT,
    -- human-readable summary
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE KEY unique_daily_log (workspace_id, date),
  INDEX idx_date_workspace (date, workspace_id),
  INDEX idx_performance_tier (performance_tier)
);

-- 5. Pattern library — correlation strength for each pattern
CREATE TABLE IF NOT EXISTS performance_patterns (
  id BIGSERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL,
    -- campaign_type, account_cohort, external_factor, timing, copy_age, list_quality
  pattern_value TEXT NOT NULL,
    -- e.g. 'high-intent-list', 'warm-account-3mo', 'strike', 'tuesday', 'new-copy'
  workspace_id TEXT,
  avg_reply_rate FLOAT,
  avg_bounce_rate FLOAT,
  avg_opens FLOAT,
  sample_size INT,
    -- how many days with this pattern
  correlation_strength FLOAT,
    -- 0–1, how strongly this pattern predicts performance
  last_updated TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_pattern_type (pattern_type),
  INDEX idx_pattern_value (pattern_value),
  INDEX idx_workspace (workspace_id),
  UNIQUE KEY unique_pattern (workspace_id, pattern_type, pattern_value)
);

-- 6. Diagnostic checks configuration — thresholds for status levels
CREATE TABLE IF NOT EXISTS diagnostic_checks (
  id BIGSERIAL PRIMARY KEY,
  check_name TEXT NOT NULL,
    -- "warmup_health", "bounce_rate", "api_latency", "queue_depth"
  metric_key TEXT NOT NULL,
  normal_min FLOAT,
  normal_max FLOAT,
  warning_min FLOAT,
  warning_max FLOAT,
  critical_min FLOAT,
  critical_max FLOAT,
  unit TEXT,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE KEY unique_check (check_name)
);

-- Insert default check thresholds
INSERT IGNORE INTO diagnostic_checks
  (check_name, metric_key, normal_min, normal_max, warning_min, warning_max, critical_min, critical_max, unit, description)
VALUES
  ('warmup_health', 'warmup_pct', 80, 100, 60, 80, 0, 60, '%', 'Email account warmup percentage'),
  ('bounce_rate', 'bounce_rate_pct', 0, 5, 5, 10, 10, 100, '%', 'Hard + soft bounce rate'),
  ('api_latency', 'pv_api_latency_ms', 0, 500, 500, 1000, 1000, 30000, 'ms', 'PlusVibe API latency'),
  ('queue_depth', 'queue_pending', 0, 100, 100, 500, 500, 10000, 'count', 'Pending push requests in queue'),
  ('memory_usage', 'memory_used_pct', 0, 70, 70, 85, 85, 100, '%', 'Server memory usage'),
  ('event_loop_lag', 'event_loop_lag_ms', 0, 10, 10, 50, 50, 200, 'ms', 'Event loop lag'),
  ('reply_rate_daily', 'reply_rate_pct', 10, 100, 5, 10, 0, 5, '%', 'Daily reply rate baseline');

-- Verify tables created
SELECT
  table_name,
  (SELECT COUNT(*) FROM diagnostic_signals) as signal_count,
  (SELECT COUNT(*) FROM diagnostic_correlation) as correlation_count,
  (SELECT COUNT(*) FROM diagnostic_external_factors) as external_factor_count,
  (SELECT COUNT(*) FROM daily_intelligence_logs) as intelligence_log_count,
  (SELECT COUNT(*) FROM performance_patterns) as pattern_count,
  (SELECT COUNT(*) FROM diagnostic_checks) as check_count
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('diagnostic_signals', 'diagnostic_correlation', 'diagnostic_external_factors', 'daily_intelligence_logs', 'performance_patterns', 'diagnostic_checks')
GROUP BY table_name;
