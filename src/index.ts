import { app } from "./app.js";
import { env } from "./config/env.js";
import { reconcilePendingPurchases } from "./services/reconcile.service.js";

const RECONCILE_EVERY_MS = 10 * 60 * 1000;

app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT}`);
});

// Lost-webhook safety net. Runs never overlap; two servers running it at once is still safe
// (row locks + stripe_events dedupe), just wasted Stripe calls.
let reconciling = false;
setInterval(() => {
  if (reconciling) return;
  reconciling = true;
  reconcilePendingPurchases()
    .then((r) => {
      if (r.paid || r.failed || r.errors) console.log(`Reconcile: ${r.paid} paid, ${r.failed} failed, ${r.errors} errors`);
    })
    .catch((err) => console.error("Reconcile run failed", err))
    .finally(() => {
      reconciling = false;
    });
}, RECONCILE_EVERY_MS);
