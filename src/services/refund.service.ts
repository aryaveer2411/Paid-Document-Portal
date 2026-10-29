import Stripe from "stripe";
import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import type { Prisma } from "../generated/prisma/client.js";
import { refundResponseSchema, type RefundResponse } from "../schema/purchase/response/purchase.refund.js";
import { stripe } from "../stripe.js";
import { syncPurchase } from "./crmSync.service.js";

// Row lock: webhook, refund and retry touching the same purchase run one at a time.
// Lock order everywhere is purchase → entitlement, so they can't deadlock.
export async function lockPurchase(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`select id from purchases where id = ${id}::uuid for update`;
  return tx.purchase.findUnique({ where: { id } });
}

// Money is back with the client: purchase refunded, its access revoked, Zoho Deal queued for "Closed Lost"
export async function markRefunded(
  tx: Prisma.TransactionClient,
  purchaseId: string,
  ids: { refundId?: string | null; paymentIntentId?: string | null } = {},
) {
  const now = new Date();
  await tx.purchase.update({
    where: { id: purchaseId },
    data: {
      status: "refunded",
      refundedAt: now,
      ...(ids.refundId && { stripeRefundId: ids.refundId }),
      ...(ids.paymentIntentId && { stripePaymentIntentId: ids.paymentIntentId }),
      crmSyncStatus: "pending",
      crmSyncError: null,
    },
  });
  await tx.entitlement.updateMany({ where: { purchaseId, revokedAt: null }, data: { revokedAt: now } });
}

type EntitlementRow = { id: string; opened_at: Date | null; revoked_at: Date | null };

// Client self-refund: only their own paid purchase, and only while the document was never opened
export async function requestRefund(userId: string, purchaseId: string): Promise<RefundResponse> {
  await prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);
    // 404 for "not yours" too, like documents: a caller can't probe other clients' purchase ids
    if (!purchase || purchase.userId !== userId) throw ApiError.notFound("Purchase not found");
    if (purchase.status === "refunded") throw ApiError.conflict("This purchase is already refunded");
    if (purchase.status !== "paid" || !purchase.stripePaymentIntentId) {
      throw ApiError.conflict("Only paid purchases can be refunded");
    }
    // Earlier attempt hit an unclear Stripe error: access is already off, send the same refund again
    if (purchase.refundRequestedAt) return;

    // Locked so a download link can't be created between this check and the revoke below
    const [entitlement] = await tx.$queryRaw<EntitlementRow[]>`
      select id, opened_at, revoked_at from entitlements where purchase_id = ${purchase.id}::uuid for update`;
    if (!entitlement || entitlement.revoked_at) throw ApiError.conflict("This purchase has no active access to refund");
    if (entitlement.opened_at) throw ApiError.conflict("Document already opened; refunds are only available before opening");

    // Access off before money moves: the client can't open the file while the refund is in flight
    const now = new Date();
    await tx.entitlement.update({ where: { id: entitlement.id }, data: { revokedAt: now } });
    await tx.purchase.update({ where: { id: purchase.id }, data: { refundRequestedAt: now } });
  });

  const status = await issueRefund(purchaseId);
  if (status === "rejected") throw ApiError.upstream("Stripe declined the refund; your access was restored");
  return refundResponseSchema.parse({ purchaseId, status });
}

export type RefundResult = "refunded" | "pending" | "rejected";

// Asks Stripe to return the money for a purchase marked refund-requested. Safe to call again:
// the idempotency key makes Stripe return the same refund instead of refunding twice.
export async function issueRefund(purchaseId: string): Promise<RefundResult> {
  const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId } });
  if (purchase?.status === "refunded") return "refunded";
  if (!purchase || purchase.status !== "paid" || !purchase.refundRequestedAt || !purchase.stripePaymentIntentId) {
    return "rejected";
  }

  let refundId: string | null = null;
  try {
    const refund = await stripe.refunds.create(
      { payment_intent: purchase.stripePaymentIntentId, reason: "requested_by_customer", metadata: { purchase_id: purchase.id } },
      { idempotencyKey: `refund-${purchase.id}` },
    );
    if (refund.status === "failed" || refund.status === "canceled") {
      console.error(`Refund ${refund.id} for purchase ${purchase.id} ended as ${refund.status}`);
      await undoRefundRequest(purchase.id);
      return "rejected";
    }
    refundId = refund.id;
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeError)) throw err;
    // Refunded already (e.g. from the Stripe dashboard): our side just catches up
    if (err.code !== "charge_already_refunded") {
      // A clear "no" from Stripe: nothing was refunded, so give access back
      if (err instanceof Stripe.errors.StripeInvalidRequestError || err instanceof Stripe.errors.StripeCardError) {
        console.error(`Stripe refused refund for purchase ${purchase.id}: ${err.message}`);
        await undoRefundRequest(purchase.id);
        return "rejected";
      }
      // Network/5xx: Stripe may or may not have refunded. Stay requested; retry or charge.refunded settles it
      console.error(`Refund for purchase ${purchase.id} unconfirmed, will retry: ${err.message}`);
      return "pending";
    }
  }

  const changed = await prisma.$transaction(async (tx) => {
    const locked = await lockPurchase(tx, purchase.id);
    // The charge.refunded webhook may have finished it first
    if (locked?.status !== "paid") return false;
    await markRefunded(tx, purchase.id, { refundId });
    return true;
  });
  if (changed) void syncPurchase(purchase.id).catch((err) => console.error(`CRM sync failed for purchase ${purchase.id}`, err));
  return "refunded";
}

// Stripe refused: clear the request and re-grant the access this refund revoked (never one that was opened)
async function undoRefundRequest(purchaseId: string) {
  await prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, purchaseId);
    if (purchase?.status !== "paid") return;
    await tx.purchase.update({ where: { id: purchaseId }, data: { refundRequestedAt: null } });
    await tx.entitlement.updateMany({
      where: { purchaseId, revokedAt: { not: null }, openedAt: null },
      data: { revokedAt: null },
    });
  });
}

// Retry command: settle every refund Stripe has not confirmed yet, oldest first.
// Settled = refunded, or rejected by Stripe (access given back).
export async function retryPendingRefunds(): Promise<{ settled: number; stillPending: number }> {
  const rows = await prisma.purchase.findMany({
    where: { status: "paid", refundRequestedAt: { not: null } },
    select: { id: true },
    orderBy: { refundRequestedAt: "asc" },
  });
  let settled = 0;
  for (const row of rows) {
    if ((await issueRefund(row.id)) !== "pending") settled++;
  }
  return { settled, stillPending: rows.length - settled };
}
