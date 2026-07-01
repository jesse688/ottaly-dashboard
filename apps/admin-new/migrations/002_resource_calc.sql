-- Resource Calc: persist the per-client monthly lead target.
-- The target is the only calc input that isn't derivable from live data
-- (capacity, sends, replies, leads all come from existing tables).
-- Editable inline on the /resource-calc page; saved per client.

ALTER TABLE portal_clients
  ADD COLUMN IF NOT EXISTS monthly_lead_target INT;
