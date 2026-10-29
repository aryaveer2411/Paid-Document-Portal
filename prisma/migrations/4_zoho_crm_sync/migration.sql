-- ============================================================
-- Zoho CRM sync per purchase.
-- crm_sync_status is null until the purchase is paid; the webhook sets 'pending' in the same
-- transaction that grants access, so a crash or Zoho outage can never lose the update.
-- ============================================================

create type crm_sync_status as enum ('pending', 'synced');

alter table purchases
  add column zoho_deal_id      text unique,
  add column crm_sync_status   crm_sync_status,
  add column crm_sync_error    text,
  add column crm_sync_attempts integer not null default 0,
  add column crm_synced_at     timestamptz;

-- Retry command scans only rows still waiting for Zoho
create index purchases_crm_pending_idx on purchases (created_at) where crm_sync_status = 'pending';

-- Browser reads its own purchases from Supabase (RLS "purchases: read own").
-- Column grants replace the table grant so Stripe/Zoho ids and raw error text stay server-side.
revoke select on purchases from authenticated;
grant select (id, user_id, document_id, amount_cents, currency, status, paid_at, created_at, crm_sync_status, crm_synced_at)
  on purchases to authenticated;
