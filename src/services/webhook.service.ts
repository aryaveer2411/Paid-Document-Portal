import Stripe from "stripe";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import type { Prisma } from "../generated/prisma/client.js";
import { stripe } from "../stripe.js";
import { syncPurchase } from "./crmSync.service.js";
import { issueRefund, lockPurchase, markRefunded } from "./refund.service.js";

// processed = we acted · duplicate = event id seen before · ignored = not ours / nothing to do
export type WebhookOutcome = "processed" | "duplicate" | "ignored";

// A Stripe event, or the reconciler acting in its place (id "reconcile:<session id>").
// Either way the id lands in stripe_events, so each one is applied once.
export type EventRef = { id: string; type: string };

// Proves the request came from Stripe: HMAC of the exact raw bytes with our webhook secret.
// Parsed-then-reserialized JSON would change the bytes and fail, hence the raw body.
export function verifyStripeEvent(rawBody: Buffer, signature: string): Stripe.Event {
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw ApiError.invalidSignature();
  }
}

export async function handleStripeEvent(event: Stripe.Event): Promise<WebhookOutcome> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      // Card payments are "paid" on completed; slower methods stay "unpaid" until async_payment_succeeded
      if (event.data.object.payment_status !== "paid") return "ignored";
      return fulfill(event, event.data.object);
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return markFailed(event, event.data.object);
    case "charge.refunded":
      // Refunds from our button, the Stripe dashboard, or the auto-refund of a double payment
      return refundFromStripe(event, event.data.object);
    default:
      return "ignored";
  }
}

// Our stable id travels in metadata; anything without a valid one is not from our checkout
function purchaseIdOf(session: Stripe.Checkout.Session): string | null {
  const parsed = z.uuid().safeParse(session.metadata?.purchase_id);
  return parsed.success ? parsed.data : null;
}

// Event id is the primary key: a second insert of the same id inserts nothing → duplicate
async function recordEvent(tx: Prisma.TransactionClient, event: EventRef, purchaseId: string) {
  const { count } = await tx.stripeEvent.createMany({
    data: [{ id: event.id, type: event.type, purchaseId }],
    skipDuplicates: true,
  });
  return count === 1;
}

export async function fulfill(event: EventRef, session: Stripe.Checkout.Session): Promise<WebhookOutcome> {
  const purchaseId = purchaseIdOf(session);
  if (!purchaseId) {
    console.warn(`Stripe event ${event.id}: no purchase_id in metadata, ignored`);
    return "ignored";
  }

  // Event record + paid status + entitlement + "CRM pending" commit together or not at all
  const { outcome, duplicatePayment } = await prisma.$transaction(async (tx) => {
    const result = (outcome: WebhookOutcome, duplicatePayment = false) => ({ outcome, duplicatePayment });
    const purchase = await lockPurchase(tx, purchaseId);
    if (!purchase) {
      console.warn(`Stripe event ${event.id}: purchase ${purchaseId} not found, ignored`);
      return result("ignored");
    }
    if (!(await recordEvent(tx, event, purchase.id))) return result("duplicate");

    // Cross-check Stripe's data against our row; a mismatch means tampering or a bug, so no access
    const mismatch =
      session.client_reference_id !== purchase.userId ||
      session.amount_total !== purchase.amountCents ||
      session.currency !== purchase.currency ||
      (purchase.stripeCheckoutSessionId !== null && purchase.stripeCheckoutSessionId !== session.id);
    if (mismatch) {
      console.error(`Stripe event ${event.id}: session ${session.id} does not match purchase ${purchase.id}, not granted`);
      return result("ignored");
    }

    // A different event already completed this purchase
    if (purchase.status === "paid") return result("duplicate");
    // Out of order: the refund event arrived before this one, so access must never be granted
    if (purchase.status === "refunded") return result("ignored");

    // One entitlement per (user, document): DB unique constraint backs this check
    const existing = await tx.entitlement.findUnique({
      where: { userId_documentId: { userId: purchase.userId, documentId: purchase.documentId } },
    });
    // Paid twice (e.g. two checkout tabs): access already exists, so this payment goes back automatically
    const paidTwice = existing !== null && existing.revokedAt === null;

    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        status: "paid",
        paidAt: new Date(),
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: paymentIntentId ?? null,
        // Recorded with the access grant: even if we crash before calling Zoho, retry will find it.
        // A double payment skips "Closed Won"; its refund marks the Deal "Closed Lost" instead.
        // Refund request saved here too, so a crash before Stripe is called is caught by refund:retry.
        ...(paidTwice ? { refundRequestedAt: new Date() } : { crmSyncStatus: "pending" as const }),
      },
    });

    if (paidTwice) {
      console.warn(`Purchase ${purchase.id}: user already owns document ${purchase.documentId}, refunding`);
      return result("processed", true);
    }
    if (!existing) {
      await tx.entitlement.create({
        data: { userId: purchase.userId, documentId: purchase.documentId, purchaseId: purchase.id },
      });
    } else {
      // Bought again after access was revoked (e.g. refunded): re-grant, now backed by this purchase
      await tx.entitlement.update({
        where: { id: existing.id },
        data: { revokedAt: null, openedAt: null, grantedAt: new Date(), purchaseId: purchase.id },
      });
    }
    return result("processed");
  });

  // After commit and without awaiting: Stripe gets its 200 fast, and a slow or down Zoho/Stripe can't
  // undo access. Duplicates never reach here, so a repeated webhook makes no second Zoho update or refund.
  if (duplicatePayment) {
    void issueRefund(purchaseId).catch((err) => console.error(`Auto-refund failed for purchase ${purchaseId}`, err));
  } else if (outcome === "processed") {
    void syncPurchase(purchaseId).catch((err) => console.error(`CRM sync failed for purchase ${purchaseId}`, err));
  }
  return outcome;
}

// charge.refunded carries the PaymentIntent, not our metadata. Normally we stored that id when paid;
// if the refund event beats the payment event, the PaymentIntent's own metadata has our purchase id.
async function purchaseIdForPaymentIntent(paymentIntentId: string): Promise<string | null> {
  const known = await prisma.purchase.findUnique({ where: { stripePaymentIntentId: paymentIntentId }, select: { id: true } });
  if (known) return known.id;
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const parsed = z.uuid().safeParse(intent.metadata?.purchase_id);
  return parsed.success ? parsed.data : null;
}

async function refundFromStripe(event: Stripe.Event, charge: Stripe.Charge): Promise<WebhookOutcome> {
  // Partial refunds keep access; only money fully returned removes it
  if (!charge.refunded) return "ignored";
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntentId) return "ignored";
  const purchaseId = await purchaseIdForPaymentIntent(paymentIntentId);
  if (!purchaseId) return "ignored";

  const outcome = await prisma.$transaction(async (tx): Promise<WebhookOutcome> => {
    const purchase = await lockPurchase(tx, purchaseId);
    if (!purchase) return "ignored";
    if (!(await recordEvent(tx, event, purchase.id))) return "duplicate";
    // Our refund button already recorded it
    if (purchase.status === "refunded") return "duplicate";
    await markRefunded(tx, purchase.id, { paymentIntentId });
    return "processed";
  });

  if (outcome === "processed") {
    void syncPurchase(purchaseId).catch((err) => console.error(`CRM sync failed for purchase ${purchaseId}`, err));
  }
  return outcome;
}

export async function markFailed(event: EventRef, session: Stripe.Checkout.Session): Promise<WebhookOutcome> {
  const purchaseId = purchaseIdOf(session);
  if (!purchaseId) return "ignored";

  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);
    if (!purchase) return "ignored";
    if (!(await recordEvent(tx, event, purchase.id))) return "duplicate";
    // Only pending → failed; a paid purchase is never downgraded by a late event
    await tx.purchase.updateMany({ where: { id: purchase.id, status: "pending" }, data: { status: "failed" } });
    return "processed";
  });
}
