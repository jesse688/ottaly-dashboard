-- Sending ramp-up: capacity must use what a mailbox may send TODAY, not its
-- final configured daily_limit.
--
-- PlusVibe has TWO independent ramps per account:
--   payload.warmup_rampup  — warmup email volume (already synced as warmup_limit)
--   payload.sending_rampup — COLD send volume  <- this one, previously unsynced
--
-- When sending_rampup.is_slow_rampup is true, PV starts the account at
-- rampup_daily_limit and adds rampup_daily_inc per day until it reaches
-- daily_limit. Until then daily_limit is a FUTURE ceiling the box cannot hit,
-- so counting it as today's capacity invents "wasted" capacity that was never
-- available. 611 of 1,259 active mailboxes (49%) have this flag set.
--
-- rampup_started_at is the ramp clock. PV does not expose it, so we stamp it
-- ourselves the first time we see the account in slow rampup and keep it
-- stable afterwards (see lib/mailbox-sync.ts). warmup_enb_dt is NOT usable as
-- the clock: it is when WARMUP was switched on, which for most accounts is
-- months before cold sending started.

ALTER TABLE mailbox_full
  ADD COLUMN IF NOT EXISTS sending_rampup      JSONB,
  ADD COLUMN IF NOT EXISTS rampup_started_at   DATE;
