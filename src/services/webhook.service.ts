import Stripe from "stripe";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import type { Prisma } from "../generated/prisma/client.js";
import { stripe } from "../stripe.js";

// processed = we acted · duplicate = event id seen before · ignored = not ours / nothing to do
export type WebhookOutcome = "processed" | "duplicate" | "ignored";

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
    default:
      return "ignored";
  }
}

// Our stable id travels in metadata; anything without a valid one is not from our checkout
function purchaseIdOf(session: Stripe.Checkout.Session): string | null {
  const parsed = z.uuid().safeParse(session.metadata?.purchase_id);
  return parsed.success ? parsed.data : null;
}

// Row lock: two different events for the same purchase are handled one at a time
async function lockPurchase(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`select id from purchases where id = ${id}::uuid for update`;
  return tx.purchase.findUnique({ where: { id } });
}

// Event id is the primary key: a second insert of the same id inserts nothing → duplicate
async function recordEvent(tx: Prisma.TransactionClient, event: Stripe.Event, purchaseId: string) {
  const { count } = await tx.stripeEvent.createMany({
    data: [{ id: event.id, type: event.type, purchaseId }],
    skipDuplicates: true,
  });
  return count === 1;
}

async function fulfill(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<WebhookOutcome> {
  const purchaseId = purchaseIdOf(session);
  if (!purchaseId) {
    console.warn(`Stripe event ${event.id}: no purchase_id in metadata, ignored`);
    return "ignored";
  }

  // Event record + paid status + entitlement commit together or not at all
  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);
    if (!purchase) {
      console.warn(`Stripe event ${event.id}: purchase ${purchaseId} not found, ignored`);
      return "ignored";
    }
    if (!(await recordEvent(tx, event, purchase.id))) return "duplicate";

    // Cross-check Stripe's data against our row; a mismatch means tampering or a bug, so no access
    const mismatch =
      session.client_reference_id !== purchase.userId ||
      session.amount_total !== purchase.amountCents ||
      session.currency !== purchase.currency ||
      (purchase.stripeCheckoutSessionId !== null && purchase.stripeCheckoutSessionId !== session.id);
    if (mismatch) {
      console.error(`Stripe event ${event.id}: session ${session.id} does not match purchase ${purchase.id}, not granted`);
      return "ignored";
    }

    // A different event already completed this purchase
    if (purchase.status === "paid") return "duplicate";

    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        status: "paid",
        paidAt: new Date(),
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: paymentIntentId ?? null,
      },
    });

    // One entitlement per (user, document): DB unique constraint backs this check
    const existing = await tx.entitlement.findUnique({
      where: { userId_documentId: { userId: purchase.userId, documentId: purchase.documentId } },
    });
    if (!existing) {
      await tx.entitlement.create({
        data: { userId: purchase.userId, documentId: purchase.documentId, purchaseId: purchase.id },
      });
    } else if (existing.revokedAt) {
      // Bought again after access was revoked: re-grant, now backed by this purchase
      await tx.entitlement.update({
        where: { id: existing.id },
        data: { revokedAt: null, grantedAt: new Date(), purchaseId: purchase.id },
      });
    } else {
      // Paid twice (e.g. two checkout tabs). Access is already there; money needs a manual refund.
      console.warn(`Purchase ${purchase.id}: user already owns document ${purchase.documentId}, refund needed`);
    }
    return "processed";
  });
}

async function markFailed(event: Stripe.Event, session: Stripe.Checkout.Session): Promise<WebhookOutcome> {
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
