-- ============================================================
-- Refunds.
-- A client may refund their own purchase only while the document was never opened:
-- entitlements.opened_at is stamped on the first download link and ends that window.
-- refund_requested_at is set (and access revoked) before Stripe is called, so a crash or
-- Stripe outage mid-refund leaves a row the retry command can finish.
-- ============================================================

alter table entitlements
  add column opened_at timestamptz;

alter table purchases
  add column refund_requested_at timestamptz,
  add column refunded_at         timestamptz,
  add column stripe_refund_id    text unique;

-- Refund retry command scans only refunds Stripe has not confirmed yet
create index purchases_refund_pending_idx on purchases (refund_requested_at)
  where refund_requested_at is not null and status = 'paid';

-- Browser shows refund state on the orders page (column grants, see migration 4).
-- entitlements has a table-wide select grant, so opened_at is readable already.
grant select (refund_requested_at, refunded_at) on purchases to authenticated;
