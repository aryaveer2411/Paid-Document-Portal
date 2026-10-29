import Stripe from "stripe";
import { prisma } from "../db.js";
import { stripe } from "../stripe.js";
import { fulfill, markFailed, type EventRef } from "./webhook.service.js";

// Younger purchases may still be in an open Checkout tab or mid-request; left alone
const MIN_AGE_MS = 10 * 60 * 1000;
// Per run, oldest first; the rest wait for the next run
const BATCH_SIZE = 100;

type Settled = "paid" | "failed" | "waiting";
export type ReconcileResult = Record<Settled | "errors", number>;

// Safety net for lost webhooks: asks Stripe what really happened to each old "pending" purchase.
// Paid → access granted exactly like the webhook would; expired → marked failed; anything else waits.
export async function reconcilePendingPurchases(): Promise<ReconcileResult> {
  const rows = await prisma.purchase.findMany({
    where: { status: "pending", createdAt: { lt: new Date(Date.now() - MIN_AGE_MS) } },
    select: { id: true, stripeCheckoutSessionId: true },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  const result: ReconcileResult = { paid: 0, failed: 0, waiting: 0, errors: 0 };
  for (const row of rows) {
    try {
      result[await reconcileOne(row.id, row.stripeCheckoutSessionId)]++;
    } catch (err) {
      // One bad row (or Stripe down) must not stop the others; it is retried next run
      result.errors++;
      console.error(`Reconcile failed for purchase ${row.id}`, err);
    }
  }
  return result;
}

async function reconcileOne(purchaseId: string, sessionId: string | null): Promise<Settled> {
  if (!sessionId) {
    // Checkout crashed before saving the session; the payment link is only returned after that save,
    // so the buyer never had a page to pay on
    await prisma.purchase.updateMany({
      where: { id: purchaseId, status: "pending", stripeCheckoutSessionId: null },
      data: { status: "failed" },
    });
    return "failed";
  }

  let session = await stripe.checkout.sessions.retrieve(sessionId);
  // Same id on every run for this session: stripe_events makes the action happen once
  const ref: EventRef = { id: `reconcile:${session.id}`, type: "reconcile.checkout_session" };

  if (session.payment_status === "paid") {
    const outcome = await fulfill(ref, session);
    // "ignored" = Stripe's data doesn't match our row (already logged); a human must look, so keep it pending
    return outcome === "ignored" ? "waiting" : "paid";
  }

  // Past its expiry but still open: close it, so a stale tab can't pay after we give up on it
  if (session.status === "open" && session.expires_at * 1000 <= Date.now()) {
    try {
      session = await stripe.checkout.sessions.expire(session.id);
    } catch (err) {
      // Most likely paid in the meantime; the next run re-reads it and acts on the fresh state
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
      return "waiting";
    }
  }

  if (session.status === "expired") {
    await markFailed(ref, session);
    return "failed";
  }
  // Open and not yet expired, or complete with a bank payment still processing
  return "waiting";
}
