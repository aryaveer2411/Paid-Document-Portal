-- ============================================================
-- Stripe catalog sync (local DB = source of truth, reconciler pushes to Stripe)
-- ============================================================

create type stripe_sync_status as enum ('pending', 'synced', 'failed');

alter table documents
  add column stripe_product_id   text unique,
  add column stripe_sync_status  stripe_sync_status not null default 'pending',
  add column stripe_sync_version integer not null default 1,
  add column stripe_sync_error   text,
  add column stripe_synced_at    timestamptz;

alter table prices
  add column stripe_price_id     text unique,
  add column stripe_sync_status  stripe_sync_status not null default 'pending',
  add column stripe_sync_version integer not null default 1,
  add column stripe_sync_error   text,
  add column stripe_synced_at    timestamptz;

-- A change Stripe must mirror bumps the version and marks the row pending.
-- Reconciler marks 'synced' only "where stripe_sync_version = <version it read>",
-- so an edit made mid-sync is never overwritten as synced.
create function documents_mark_stripe_pending() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.title is distinct from old.title or new.description is distinct from old.description then
    new.stripe_sync_status  := 'pending';
    new.stripe_sync_version := old.stripe_sync_version + 1;
  end if;
  return new;
end;
$$;

create trigger documents_mark_stripe_pending
  before update on documents
  for each row execute function documents_mark_stripe_pending();

-- Stripe Prices are immutable, so ours are too: new amount = insert new row, deactivate old one
create function prices_guard_and_mark_stripe_pending() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.amount_cents <> old.amount_cents
     or new.currency <> old.currency
     or new.document_id <> old.document_id then
    raise exception 'prices are immutable: insert a new price and deactivate the old one';
  end if;
  if new.active is distinct from old.active then
    new.stripe_sync_status  := 'pending';
    new.stripe_sync_version := old.stripe_sync_version + 1;
  end if;
  return new;
end;
$$;

create trigger prices_guard_and_mark_stripe_pending
  before update on prices
  for each row execute function prices_guard_and_mark_stripe_pending();

-- ============================================================
-- Row Level Security (browser uses Supabase anon key + user JWT)
-- Server uses Prisma as the table owner, which bypasses RLS.
-- ============================================================

alter table users         enable row level security;
alter table documents     enable row level security;
alter table prices        enable row level security;
alter table purchases     enable row level security;
alter table entitlements  enable row level security;
alter table stripe_events enable row level security;

-- Start from zero: browser roles get only what is granted below (read-only, signed-in only)
revoke all on users, documents, prices, purchases, entitlements, stripe_events from anon, authenticated;

grant select on users, purchases, entitlements to authenticated;
-- Column grants hide storage paths and Stripe sync internals from the browser
grant select (id, title, description, created_at) on documents to authenticated;
grant select (id, document_id, amount_cents, currency, active) on prices to authenticated;

-- (select auth.uid()) is evaluated once per query instead of once per row
create policy "users: read own row" on users
  for select to authenticated using (id = (select auth.uid()));

create policy "documents: catalog readable" on documents
  for select to authenticated using (true);

create policy "prices: active readable" on prices
  for select to authenticated using (active);

create policy "purchases: read own" on purchases
  for select to authenticated using (user_id = (select auth.uid()));

create policy "entitlements: read own" on entitlements
  for select to authenticated using (user_id = (select auth.uid()));

-- stripe_events: RLS on, no grant, no policy → server only
