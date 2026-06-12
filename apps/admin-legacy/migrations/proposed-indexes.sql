-- PROPOSED INDEXES — NOT YET APPLIED. Requires Jesse's review & approval before running (CLAUDE.md: never modify DB schema without asking). Run during low-traffic window; CONCURRENTLY avoids table locks.

-- =========================================================================
-- HIGH PRIORITY
-- =========================================================================

-- email_events (workspace_id, event_type, event_at DESC)
-- Reason: The single hottest pattern across the analytics/gateway/health code is
--   WHERE workspace_id=$1 AND event_type='sent' (and 'bounce'/'reply') — server.js
--   lines 4008, 8314, 8388, 8531, 9282, 9293, 9301, 9428, plus the all-events
--   GROUP BY at 8688/8926. Neither existing index serves it:
--   idx_ee_ws_event_at(workspace_id,event_at) ignores event_type so Postgres scans
--   every event for the workspace then filters; idx_ee_event_type(event_type,event_at)
--   ignores workspace_id so it scans every workspace's sends. A composite leading
--   workspace_id+event_type turns each into a tight index range. Including event_at DESC
--   also supports the very common per-window FILTER (WHERE event_at > NOW() - INTERVAL ...)
--   at lines 4007-4022 and time-bounded GROUP BYs.
-- Query evidence: server.js:4008 WHERE workspace_id=$1 AND event_type='sent'; 8314,8388,
--   8531,9301,9428 same; 7174/7377 event_type filters; GROUP BY event_type at 4359,8926
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ee_ws_type_at ON email_events (workspace_id, event_type, event_at DESC);

-- email_events (recipient_domain) WHERE recipient_domain IS NOT NULL
-- Reason: The provider_bucket enrichment background job (server.js 11139-11184) repeatedly
--   runs SELECT DISTINCT recipient_domain ... WHERE provider_bucket IS NULL/='workspace'
--   AND recipient_domain IS NOT NULL, then fans out
--   UPDATE email_events SET provider_bucket=$1 WHERE recipient_domain=$2. recipient_domain
--   has no index at all, so every one of these per-domain UPDATEs is a full-table seq scan
--   over the entire (large, append-only webhook) event log. With many distinct domains per
--   batch this is O(domains x table). A btree on recipient_domain makes each UPDATE an index
--   range. Partial on NOT NULL keeps it small since unmatched/seeded rows are NULL.
-- Query evidence: server.js:11140,11154,11165,11177,11184 SELECT/UPDATE ... WHERE recipient_domain=$2
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ee_recipient_domain ON email_events (recipient_domain) WHERE recipient_domain IS NOT NULL;

-- =========================================================================
-- MEDIUM PRIORITY
-- =========================================================================

-- email_events (workspace_id, content_hash) WHERE content_hash IS NOT NULL
-- Reason: Per-template health/decay queries group within a workspace by content_hash:
--   server.js 4620 (WHERE workspace_id=$1 AND content_hash IS NOT NULL GROUP BY content_hash),
--   4707-4719 (LEFT JOIN campaign_templates on content_hash, WHERE workspace_id=$1
--   AND content_hash IS NOT NULL GROUP BY content_hash), 6042 exemplars JOIN templates on
--   content_hash WHERE workspace_id=$1. The existing idx_ee_template(content_hash, event_at)
--   is GLOBAL — not workspace-scoped — so a single-workspace template rollup still touches
--   every workspace sharing a hash and cannot use workspace_id to prune. A workspace-leading
--   composite lets these prune to one client first.
-- Query evidence: server.js:4620, 4707-4719, 6042 GROUP BY content_hash scoped by workspace_id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ee_ws_content_hash ON email_events (workspace_id, content_hash) WHERE content_hash IS NOT NULL;

-- =========================================================================
-- LOW PRIORITY
-- =========================================================================

-- email_events (workspace_id, step) WHERE step IS NOT NULL
-- Reason: The per-step funnel query at server.js:8688 runs
--   WHERE workspace_id=$1 AND step IS NOT NULL GROUP BY step. No index covers
--   (workspace_id, step); idx_ee_ws_event_at would scan the whole workspace and filter
--   step in memory. Lower-volume than the sent/type pattern, hence medium-low, but it is a
--   real GROUP BY on an unindexed column pair on a growing table.
-- Query evidence: server.js:8688 WHERE workspace_id=$1 AND step IS NOT NULL GROUP BY step
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ee_ws_step ON email_events (workspace_id, step) WHERE step IS NOT NULL;


-- =========================================================================
-- SLOW QUERY PATTERNS TO ADDRESS IN CODE (not fixable by indexes alone)
-- These require code changes, not just DDL. Listed for the same review pass.
-- =========================================================================
--
-- server.js:3501 — SELECT DISTINCT ON (lower(email)) ... FROM contacts WHERE mx_provider IS NOT NULL
--   ORDER BY lower(email): full pass over the contacts table (hundreds of thousands of rows) with a
--   DISTINCT ON + sort on a non-indexed expression, materialised inside a larger CTE on every
--   gateway-analysis request. No workspace_id filter and no LIMIT, so it builds a recipient-provider
--   map for the entire DB each call. Heavy even with caching; consider materialising this lookup
--   (e.g. a domain->provider table, which domain_mx_cache already partly is) instead of re-deriving
--   per request.
--   Suggestion: Drive recipient provider from domain_mx_cache (already indexed by domain) or
--   precompute a per-workspace recipient_type rollup; at minimum scope the CTE to the workspace(s)
--   under analysis and avoid sorting all contacts by lower(email).
--
-- server.js:11154 — N+1 UPDATE loop: for each distinct recipient_domain returned (up to 8000 per
--   pass) the job issues a separate UPDATE email_events SET provider_bucket=$1 WHERE
--   recipient_domain=$2. Without an index on recipient_domain each iteration is a full seq scan of
--   email_events — thousands of full scans per enrichment run.
--   Suggestion: Add idx_ee_recipient_domain (proposed above) AND batch the updates: classify domains
--   into a VALUES list / temp table and do one UPDATE ... FROM (VALUES ...) join, instead of
--   per-domain round-trips.
--
-- server.js:3278 — FROM email_events, jsonb_object_keys(raw) AS key: a lateral cross join that
--   expands every key of the raw JSONB payload for matching rows. On a wide append-only event log
--   this fans out each row into many and forces a scan/expansion of large JSONB blobs; expensive if
--   not tightly bounded by workspace_id/event_at.
--   Suggestion: Ensure these raw-key-introspection queries are bounded by workspace_id + event_at
--   range (and are debug/inspection-only, not on hot paths). If they back a UI endpoint, precompute
--   the key set rather than expanding JSONB at query time.
--
-- server.js:3501 (wide projections) — SELECT * FROM ... patterns on wide tables: server.js:4719
--   'SELECT * FROM per_template' and 8313 'SELECT DISTINCT ON (ee.id) ee.* ...' pull every column
--   (including large raw JSONB on email_events) when only a handful are used downstream.
--   Suggestion: Project only the needed columns; never select raw JSONB unless required. This cuts
--   I/O and TOAST detoasting substantially on the event log.
--
-- server.js:9256 — GROUP BY campaign_id, campaign_name over WHERE workspace_id=$1 AND campaign_id
--   IS NOT NULL AND campaign_name IS NOT NULL with ORDER BY event_count DESC and no LIMIT — unbounded
--   result and a full workspace scan (idx_ee_ws_event_at can't help the grouping). Fine if campaign
--   count is small, but returns every campaign with no cap.
--   Suggestion: Add a LIMIT and rely on the proposed (workspace_id, event_type/...) indexing; if this
--   feeds a dropdown, cap rows and order server-side.
--
-- server.js:7377 — Global GROUP BY campaign_id over WHERE event_type='bounce' AND campaign_id IS NOT
--   NULL with no workspace filter and no time bound — scans all 'bounce' events across all
--   workspaces for all time. idx_ee_event_type helps the filter but the grouping still touches the
--   full bounce history.
--   Suggestion: Bound by event_at window (e.g. last 90 days) where the caller allows, and/or scope
--   by workspace when the consumer is per-client.
