create type user_role       as enum ('client', 'admin');
create type purchase_status as enum ('pending', 'paid', 'failed', 'refunded');

create table users (
  id                 uuid primary key references auth.users (id) on delete cascade,
  email              text not null unique,
  full_name          text,
  role               user_role not null default 'client',
  stripe_customer_id text unique,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table documents (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  storage_path text not null unique,
  created_at   timestamptz not null default now()
);

create table prices (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents (id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  currency     text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  active       boolean not null default true,
  created_by   uuid references users (id),
  updated_by   uuid references users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index prices_one_active_per_document on prices (document_id) where active;

create table purchases (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references users (id) on delete restrict,
  document_id                uuid not null references documents (id) on delete restrict,
  price_id                   uuid not null references prices (id) on delete restrict,
  amount_cents               integer not null check (amount_cents > 0),
  currency                   text not null,
  status                     purchase_status not null default 'pending',
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text unique,
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now()
);

create index purchases_user_idx on purchases (user_id);

create table entitlements (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  document_id uuid not null references documents (id) on delete restrict,
  purchase_id uuid not null unique references purchases (id) on delete restrict,
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (user_id, document_id)
);

create table stripe_events (
  id          text primary key,
  type        text not null,
  purchase_id uuid references purchases (id) on delete restrict,
  received_at timestamptz not null default now()
);
