# Paid Client Access

A client buys a sample PDF through Stripe test Checkout. A signed Stripe webhook marks the purchase paid,
grants the client access in Supabase, and moves the matching Zoho CRM Deal to **Closed Won**. The portal shows
each client their own payment, access and CRM sync status, and nothing belonging to anyone else.

Test data and test payments only.

## Contents

1. [Stack](#stack)
2. [How it works](#how-it-works)
3. [Guarantees and where they live](#guarantees-and-where-they-live)
4. [Setup](#setup)
5. [Sample data and demo](#sample-data-and-demo)
6. [Verifying each requirement](#verifying-each-requirement)
7. [Automated tests](#automated-tests)
8. [Retry and maintenance commands](#retry-and-maintenance-commands)
9. [API](#api)
10. [Environment variables](#environment-variables)
11. [Project layout](#project-layout)
12. [Edge cases handled](#edge-cases-handled)
13. [Known limits and what could break](#known-limits-and-what-could-break)
14. [Troubleshooting](#troubleshooting)

## Stack

| Part | Tech | Where |
|---|---|---|
| API server | Node 20+, Express 5, Prisma 7, Zod 4 | `src/` |
| Portal | React + Vite, `supabase-js` | `web/` |
| Identity, DB, files | Supabase Auth, Postgres (RLS), private Storage bucket | `prisma/migrations/` |
| Payments | Stripe Checkout (test mode / sandbox) | `src/services/checkout.service.ts`, `webhook.service.ts` |
| CRM | Zoho CRM Developer Edition, Deals module (API v8) | `src/services/zoho.service.ts`, `crmSync.service.ts` |

**Secret boundary:** Stripe and Zoho keys live only in the server's `.env`. The browser gets only the Supabase URL
and the **publishable** key (served by `GET /config.json`). The browser reads access status directly from Supabase;
Row Level Security limits every read to the signed-in client's own rows.

## How it works

```
Client (browser)            API server                        Stripe          Supabase DB         Zoho CRM
      | POST /api/checkout ---> create purchase row (pending) ------------------> purchases
      |                         create Checkout Session ---------> (metadata.purchase_id,
      |                                                            client_reference_id = user id)
      |                         upsert Deal "Qualification" (best effort) -------------------------> Deal
      | <-- checkoutUrl
      | pays with 4242... ----------------------------------------> Stripe
      |                                                             |
      |                         POST /api/webhooks/stripe <---------+ checkout.session.completed
      |                         1. verify signature (raw body + whsec)
      |                         2. ONE transaction, purchase row locked:
      |                              insert event id into stripe_events (dedupe)
      |                              cross-check user / amount / currency / session id
      |                              purchase -> paid, entitlement created, crm_sync_status = pending
      |                         3. reply 200 to Stripe
      |                         4. after commit: upsert Deal "Closed Won" --------------------------> Deal
      |                              success -> crm_sync_status = synced
      |                              failure -> stays pending + error saved (retry later)
      | reads purchases / entitlements via supabase-js (RLS: own rows only)
      | GET /api/documents/:id/download -> 60 s signed Storage URL (only if entitled)
```

### Stable IDs that tie the systems together

| ID | Created by | Carried in | Used for |
|---|---|---|---|
| `purchases.id` (UUID) | our DB, before Stripe is called | Stripe session `metadata.purchase_id` and PaymentIntent `metadata.purchase_id`; Zoho Deal field `Portal_Purchase_ID` | Finding the purchase from any webhook; Zoho upsert key (one Deal per purchase) |
| `users.id` (= Supabase Auth user id) | Supabase Auth | session `client_reference_id` | Cross-check: the payer must be the purchase owner |
| Stripe event id (`evt_...`) | Stripe | `stripe_events.id` (primary key) | Applying each event exactly once |
| Checkout Session id / PaymentIntent id | Stripe | `purchases.stripe_checkout_session_id` / `stripe_payment_intent_id` (unique) | Matching refunds and the reconciler back to the purchase |
| Zoho Deal id | Zoho | `purchases.zoho_deal_id` (unique) | Reference only; the upsert key is the purchase id |

Matching never relies on email or name: those can change or collide; the IDs above cannot.

## Guarantees and where they live

| Requirement | How | Code |
|---|---|---|
| Webhook is really from Stripe | `stripe.webhooks.constructEvent` HMAC check on the **raw** body. The webhook route is mounted before `express.json()`, so the bytes are untouched. Bad signature returns 400. | `src/app.ts`, `webhook.service.ts` `verifyStripeEvent` |
| Access only after successful payment | Granted only on `checkout.session.completed` / `async_payment_succeeded` with `payment_status === "paid"`, after the user/amount/currency/session cross-check. The success redirect URL grants nothing. | `webhook.service.ts` `fulfill` |
| Repeated webhook: no second entitlement | Event id insert into `stripe_events` with `skipDuplicates`. A second delivery inserts 0 rows, so the handler returns `duplicate` before touching anything. Backed by the `entitlements (user_id, document_id)` and `(purchase_id)` unique constraints and a `select ... for update` row lock. | `webhook.service.ts` `recordEvent`, `refund.service.ts` `lockPurchase` |
| Repeated webhook: no second Zoho update | Zoho is called only when the transaction returns `processed`. `syncPurchase` also exits if the row is not `crm_sync_status = 'pending'`. The Zoho call is an **upsert** on the unique purchase-id field, so even a retry after an unclear failure updates the same Deal instead of creating another. | `crmSync.service.ts`, `zoho.service.ts` `upsertDeal` |
| Zoho down: access still correct | Access and `crm_sync_status = 'pending'` commit in the same DB transaction, **before** Zoho is called. Zoho runs after the commit and its failure only writes `crm_sync_error` and `crm_sync_attempts`. | `webhook.service.ts`, `crmSync.service.ts` |
| Retry for pending CRM updates | `npm run zoho:retry`, or **Retry pending Zoho syncs** on the admin dashboard (`POST /api/admin/purchases/crm-sync`) | `src/scripts/zohoRetry.ts` |
| Portal shows access + CRM status | Orders page reads `purchases` and `entitlements` straight from Supabase with the user's session | `web/src/pages/Orders.tsx` |
| One client can't see another's data | RLS policies `purchases: read own`, `entitlements: read own`, `users: read own row`; column grants hide Stripe/Zoho ids, error text and storage paths. Download endpoint checks ownership and returns 404 (not 403) so IDs can't be probed. The signed URL is created **as the user**, so the Storage policy re-checks the entitlement on Supabase's side. | `prisma/migrations/1_*`, `4_*`, `5_*`, `document.service.ts` |

## Setup

### Prerequisites

- Node.js 20 or newer
- [Stripe CLI](https://docs.stripe.com/stripe-cli)
- Accounts: Supabase (free), Stripe (test mode / sandbox), Zoho CRM Developer Edition

### 1. Test environments (one-time)

**Supabase**
1. Create a project. Copy the pooler connection strings into `DATABASE_URL` (port 6543) and `DIRECT_URL` (port 5432).
2. Copy the project URL and the **publishable** key into `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`.
   Never use the secret / `service_role` key here.
3. Storage → New bucket → name `documents`, **Private**.
4. Authentication → Sign In / Providers → Email → turn **off** "Confirm email" (test only).

**Stripe (sandbox)**
1. Developers → API keys → copy the test secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.
2. Run `stripe login` with the Stripe CLI in the same sandbox.

**Zoho CRM (Developer Edition)**
1. Setup → Modules → Deals → Fields → add a single-line field `Portal Purchase ID` (API name `Portal_Purchase_ID`),
   and tick **Do not allow duplicate values**. The upsert relies on this field being unique.
2. In the Zoho API console for your data center (e.g. https://api-console.zoho.in) → Self Client → generate a code
   with scope `ZohoCRM.modules.deals.ALL`, then exchange it for a refresh token.
   Put the client id, client secret and refresh token in `.env`.
3. Use the `.in` / `.com` / `.eu` URLs that match your Zoho data center (`ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL`).
4. If your org's home currency is not INR, set `ZOHO_HOME_CURRENCY`. If Pipeline is mandatory on Deals,
   set `ZOHO_DEAL_PIPELINE`.

### 2. Install and migrate

```powershell
copy .env.example .env          # then fill in the values above
npm install                     # also runs prisma generate
npm --prefix web install
npm run db:deploy               # applies prisma/migrations to Supabase (tables, RLS, storage rules, triggers)
```

### 3. Run (3 terminals)

```powershell
# T1: forward Stripe test events to the local webhook (keep the quotes on Windows)
stripe listen --events "checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded" --forward-to localhost:3000/api/webhooks/stripe
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET in .env (first time only), then restart T2

# T2: API server on http://localhost:3000
npm run dev

# T3: portal on http://localhost:5173
npm run web:dev
```

Production-style single server: `npm run web:build && npm run build && npm start` serves the built portal from
`web/dist` on the API port.

## Sample data and demo

1. Open http://localhost:5173 → **Get started** → sign up `admin@example.com`, `client.a@example.com` and
   `client.b@example.com`.
2. In the Supabase SQL Editor: `update users set role = 'admin' where email = 'admin@example.com';`
   (Roles are set only by SQL, never from a request.)
3. Log in as admin → **Admin dashboard** → New product (title, price, any PDF up to 10 MB) → **Create**.
   Wait until Stripe sync shows `synced`.
4. Log in as client A → **Buy now** → card `4242 4242 4242 4242`, any future expiry, any CVC.
5. Back in the portal → **Orders**: status `paid`, access active, CRM `synced`. In Zoho, the Deal is **Closed Won**
   with `Portal Purchase ID` = the purchase id.

## Verifying each requirement

| Check | Steps | Expected |
|---|---|---|
| Signature verification | `curl -X POST localhost:3000/api/webhooks/stripe -H "stripe-signature: t=1,v1=bad" -H "Content-Type: application/json" -d "{}"` | 400, nothing written |
| Duplicate webhook | Copy the `evt_...` id from the `stripe listen` output, run `stripe events resend evt_...` | Response `outcome: "duplicate"`; still one row in `entitlements`, Deal not updated again (`crm_sync_attempts` unchanged) |
| Zoho unavailable | Set `ZOHO_API_URL=https://zoho-down.invalid` in `.env`, restart, buy as client B | Access active immediately; CRM shows `pending`; `crm_sync_error` says "Zoho unreachable" |
| Retry | Restore `ZOHO_API_URL`, restart, run `npm run zoho:retry` (or the admin button) | CRM `synced`, Deal **Closed Won** |
| Isolation (API) | Logged in as client B, call `GET /api/documents/<A-only document id>/download` with B's token | 404 |
| Isolation (DB) | In client B's browser console the Orders page query returns only B's rows; selecting `stripe_payment_intent_id` or `crm_sync_error` fails (no column grant) | Only own rows; hidden columns denied |
| Failed payment | Pay with `4000 0000 0000 0002` (declined) or let the session expire | No entitlement; purchase `failed` after expiry |

## Automated tests

```powershell
npm test              # run once (Vitest)
npm run test:watch    # re-run on file changes
npm run typecheck     # also type-checks the test files
```

The tests run fully offline: no `.env`, database, Stripe, Zoho or Supabase account needed. `vitest.config.ts` sets
fake environment values, Prisma is replaced by an in-memory fake (`src/tests/fakeDb.ts`) or mocks, `fetch` is
stubbed for Zoho, and Supabase Auth/Storage are mocked. Stripe signatures are real HMACs made with the fake
`whsec_` secret via `stripe.webhooks.generateTestHeaderString`.

| File | What it proves |
|---|---|
| `src/tests/webhook.service.test.ts` | Signature check (valid, wrong, tampered body, other secret); paid session → paid + one entitlement + CRM `pending` + one Zoho sync; repeated event → `duplicate`, no second entitlement or Zoho call; unpaid / async success; missing or unknown `purchase_id`; user, amount, currency or session mismatch grants nothing; refund-before-payment never grants; paid twice → auto-refund, no second entitlement; re-grant after refund; Zoho failure leaves access intact; expired/failed events; full vs partial `charge.refunded` |
| `src/tests/crmSync.service.test.ts` | Paid → Deal `Closed Won`, refunded → `Closed Lost`; already `synced` → Zoho not called; Zoho error → stays `pending` with error and attempt count; status change mid-call re-sends newer state; `zoho:retry` counts synced vs still pending |
| `src/tests/zoho.service.test.ts` | Upsert keyed on `Portal_Purchase_ID`; home currency omitted; token cached and shared by concurrent calls; 401 refreshes once (no loop); token error, network failure, record error and missing Deal id all raise `ZohoError` |
| `src/tests/app.routes.test.ts` | Through real Express routes: webhook 400 without/with bad signature, 200 on valid raw body, 500 on failure (so Stripe retries); download 401 without session, 404 for another client's document (no signed URL made), first-open stamp undone on storage failure; refund 404 for another client's purchase; `/config.json` leaks no secrets |

Not covered by automated tests: Postgres-level guarantees (RLS policies, unique constraints, `for update` row
locks) and live Stripe/Zoho calls. Check those with the manual steps in the table above.

## Retry and maintenance commands

| Command | What it does |
|---|---|
| `npm run zoho:retry` | Pushes every paid or refunded purchase whose CRM status is still `pending` to Zoho, oldest first |
| `npm run stripe:sync` | Pushes products/prices that failed to sync to Stripe |
| `npm run stripe:reconcile` | Settles purchases stuck in `pending` (webhook lost) by asking Stripe. Also runs inside the server every 10 min |
| `npm run refund:retry` | Finishes refunds whose Stripe call failed or was unconfirmed |
| `stripe events resend evt_...` | Re-delivers a Stripe event (safe: duplicates are ignored) |
| `npm test` | Runs the automated test suite (offline, see [Automated tests](#automated-tests)) |
| `npm run typecheck` | TypeScript check without emitting files (includes tests) |

The admin dashboard also has **Retry pending Zoho syncs** and **Retry Stripe** buttons.

## API

All routes are under `/api` except `/health` and `/config.json`. Authenticated routes need
`Authorization: Bearer <Supabase access token>`; the server validates it with Supabase Auth on every request.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness check |
| GET | `/config.json` | none | Supabase URL + publishable key for the browser |
| POST | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout` | none | Account session (rate limited) |
| GET | `/api/auth/me` | user | Current user and role |
| GET | `/api/products` | optional | Catalog; `owned` filled in when signed in |
| POST | `/api/checkout` | user | Create purchase + Stripe Checkout Session, returns `checkoutUrl` |
| GET | `/api/documents/:id/download` | user | 60-second signed download URL, only for an active entitlement |
| POST | `/api/purchases/:id/refund` | user | Self-refund, only own paid purchase not yet opened |
| POST | `/api/webhooks/stripe` | Stripe signature | Stripe events (raw body, not rate limited) |
| GET / POST | `/api/admin/products` | admin | List / create products |
| PUT | `/api/admin/products/:id/price` | admin | Change price |
| DELETE | `/api/admin/products/:id` | admin | Archive product (soft delete; owners keep access) |
| POST | `/api/admin/products/:id/stripe-sync` | admin | Retry Stripe product/price sync |
| POST | `/api/admin/uploads` | admin | Upload PDF (raw `application/pdf`, max 10 MB) |
| GET | `/api/admin/purchases` | admin | All purchases with sync status |
| POST | `/api/admin/purchases/crm-sync` | admin | Retry pending Zoho syncs |

Errors share one JSON shape built by the central error handler in `src/app.ts`; unknown errors return a generic 500
and are logged server-side only.

## Environment variables

Copy `.env.example` to `.env`. The server validates every variable with Zod at boot and exits with the variable name
(never its value) if one is missing or malformed. `.env` is git-ignored; never commit it.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3000` | |
| `NODE_ENV` | no | `development` | In development, Stripe may also redirect back to `http://localhost:5173` |
| `TRUST_PROXY` | no | `0` | Number of reverse proxies in front (1 behind one load balancer). Affects rate-limit IPs |
| `APP_URL` | no | `http://localhost:3000` | Stripe success/cancel redirect base |
| `DEFAULT_CURRENCY` | no | `inr` | Currency for new prices |
| `DATABASE_URL` | yes | | Supabase pooler (6543), used at runtime |
| `DIRECT_URL` | yes (migrations) | | Supabase direct (5432), used by `prisma migrate` |
| `SUPABASE_URL` | yes | | |
| `SUPABASE_PUBLISHABLE_KEY` | yes | | Browser-safe key; RLS protects the data |
| `STORAGE_BUCKET` | no | `documents` | Private bucket name |
| `STRIPE_SECRET_KEY` | yes | | Test key, `sk_test_...` (or restricted `rk_...`) |
| `STRIPE_WEBHOOK_SECRET` | yes | | `whsec_...` from `stripe listen` or the dashboard endpoint |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | yes | | Self Client OAuth |
| `ZOHO_ACCOUNTS_URL` | no | `https://accounts.zoho.in` | Must match your data center |
| `ZOHO_API_URL` | no | `https://www.zohoapis.in` | Must match your data center |
| `ZOHO_DEAL_PURCHASE_FIELD` | no | `Portal_Purchase_ID` | API name of the unique Deal field |
| `ZOHO_HOME_CURRENCY` | no | `INR` | Deals in this currency are sent without `Currency` |
| `ZOHO_DEAL_PIPELINE` | no | | Only if Pipeline is mandatory in your org |

## Project layout

```
src/
  index.ts              server start + 10-minute reconcile loop
  app.ts                middleware order (webhook raw body first), routes, error handler
  config/env.ts         Zod-validated environment
  routes/ controllers/  HTTP layer (thin)
  services/
    checkout.service.ts   purchase row + Stripe Checkout Session
    webhook.service.ts    signature check, fulfil / fail / refund events, dedupe
    crmSync.service.ts    purchase state -> Zoho Deal, pending/synced bookkeeping
    zoho.service.ts       Zoho OAuth token cache + Deal upsert (no DB access)
    document.service.ts   ownership check + signed download URL
    refund.service.ts     self-refund, auto-refund of double payments, row locking
    reconcile.service.ts  lost-webhook safety net
    stripeSync.service.ts / admin / upload / product / auth
  scripts/              CLI entry points for the retry commands
  schema/               Zod request/response schemas
  middleware/           requireUser, requireAdmin, rate limits
  tests/                Vitest suites + in-memory fake DB (excluded from the build)
prisma/
  schema.prisma         tables and enums
  migrations/           SQL: tables, RLS, column grants, storage policies, triggers
web/src/
  pages/                Home (catalog), Orders (status), Auth, Admin
  api.ts auth.tsx       server calls + Supabase session
```

## Edge cases handled

- **Duplicate or replayed event:** deduped by event id in `stripe_events`; a different event for an already-paid
  purchase also returns `duplicate`.
- **Out-of-order events:** a refund that arrives before the payment event leaves the purchase `refunded` and access
  is never granted; a late `expired`/`failed` event never downgrades a paid purchase.
- **Tampered or mismatched session:** user id, amount, currency or session id differ from our row → no access,
  logged for review.
- **Delayed payment methods:** `completed` with `payment_status: unpaid` is ignored until
  `async_payment_succeeded`.
- **Lost webhook / server down during payment:** the reconciler asks Stripe about purchases pending for over
  10 minutes and applies the same `fulfill` logic, deduped by a `reconcile:<session id>` event id.
- **Crash between DB commit and Zoho call:** the row is already `crm_sync_status = 'pending'`, so `zoho:retry`
  finds it.
- **Zoho token expiry:** access token cached, renewed 60 s early, refreshed once on 401; concurrent callers share
  one refresh to avoid Zoho's token rate limit. Each Zoho call times out after 10 s.
- **Refund racing a CRM sync:** the sync's final update filters on the status it sent; if the status changed
  mid-call it re-queues and sends the newer state, so Zoho ends on the correct stage.
- **Paid twice (two checkout tabs):** the second payment is detected inside the transaction and refunded
  automatically; no second entitlement, no second Closed Won.
- **Refunds:** from the portal (only before first download), the Stripe dashboard, or auto-refund all revoke access
  and move the Deal to **Closed Lost**. Stripe calls use idempotency keys so a retry can't refund twice.
- **Stale checkout tabs:** sessions expire after 30 minutes; old ones are expired by the reconciler.
- **Archived product:** no new purchases, existing owners keep access.
- **Open redirect:** Stripe return URLs are limited to an allowlist of origins.

## Known limits and what could break

- **`STRIPE_WEBHOOK_SECRET` changes** every time a different `stripe listen` session or endpoint is used. A wrong
  secret makes every webhook fail with 400; the reconciler still settles payments within about 10 minutes.
- **Zoho refresh token revoked**, or the `Portal_Purchase_ID` field deleted or made non-unique: CRM updates stay
  `pending` (or could duplicate Deals if uniqueness is lost). Access is unaffected. Fix the setup, then run
  `npm run zoho:retry`.
- **Zoho data center mismatch** (`.in` vs `.com`): token refresh fails with `invalid_client`.
- **Zoho API limits** in Developer Edition are low; a large backlog retried at once may hit them. The retry is
  sequential and can be re-run.
- **Multiple server instances:** safe (row locks + event dedupe), but each runs the reconcile loop, which wastes
  Stripe calls. Production would move it to one scheduled job.
- **No automatic Zoho retry schedule:** retries are manual (command or button). A cron job running
  `npm run zoho:retry` would close that gap.
- **Supabase free tier pauses** inactive projects; the server then fails DB calls until it is resumed.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits with `Invalid environment variables` | A variable in `.env` is missing or malformed; the message names it |
| Webhook returns 400 `INVALID_SIGNATURE` | `STRIPE_WEBHOOK_SECRET` doesn't match the running `stripe listen`; copy the new `whsec_...` and restart |
| Paid but no access | Check `stripe listen` output for the event and the server log for "does not match purchase"; run `npm run stripe:reconcile` |
| CRM stuck on `pending` | Read `crm_sync_error` in the admin dashboard; fix Zoho config, then `npm run zoho:retry` |
| Zoho `DUPLICATE_DATA` or `INVALID_DATA` on Currency | Unique field missing, or Deal currency differs from `ZOHO_HOME_CURRENCY` and multi-currency is off |
| Download returns 404 for the owner | File missing from the `documents` bucket, or storage policy migration not applied (`npm run db:deploy`) |
| Sign-up works but login says confirm email | "Confirm email" is still on in Supabase Auth settings |
