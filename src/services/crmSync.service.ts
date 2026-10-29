import { prisma } from "../db.js";
import { upsertDeal, ZohoError, type DealStage } from "./zoho.service.js";

function errorMessage(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

// Loads what a Deal needs from our DB; Zoho never decides amounts or names
async function loadPurchase(purchaseId: string) {
  return prisma.purchase.findUnique({
    where: { id: purchaseId },
    include: { user: { select: { email: true, fullName: true } }, document: { select: { title: true } } },
  });
}

type LoadedPurchase = NonNullable<Awaited<ReturnType<typeof loadPurchase>>>;

function dealFields(purchase: LoadedPurchase, stage: DealStage) {
  const refunded = stage === "Closed Lost";
  const refundDate = (purchase.refundedAt ?? new Date()).toISOString().slice(0, 10);
  return {
    purchaseId: purchase.id,
    // Refund shows in Deal lists without opening the record
    name: `${purchase.document.title} - ${purchase.user.fullName}${refunded ? " [Refunded]" : ""}`,
    stage,
    amount: purchase.amountCents / 100,
    currency: purchase.currency.toUpperCase(),
    closingDate: (refunded ? purchase.refundedAt : purchase.paidAt) ?? new Date(),
    description: `Portal purchase by ${purchase.user.email}${refunded ? `. Refunded on ${refundDate}` : ""}`,
  };
}

// At checkout: open Deal so sales sees the attempt. Best effort; payment does not depend on it.
export async function openDealForCheckout(purchaseId: string): Promise<void> {
  const purchase = await loadPurchase(purchaseId);
  if (!purchase) return;
  try {
    const dealId = await upsertDeal(dealFields(purchase, "Qualification"));
    await prisma.purchase.update({ where: { id: purchaseId }, data: { zohoDealId: dealId } });
  } catch (err) {
    // Paid sync creates the Deal anyway (upsert), so nothing is lost here
    console.warn(`Zoho Deal not opened for purchase ${purchaseId}: ${errorMessage(err)}`);
  }
}

export type CrmSyncResult = "synced" | "pending" | "skipped";

const STAGE_BY_STATUS = { paid: "Closed Won", refunded: "Closed Lost" } as const;

// After payment or refund: push the purchase's current state to its Deal. Only rows marked 'pending'
// are touched, so a repeated call after success does nothing (no second Zoho update).
export async function syncPurchase(purchaseId: string): Promise<CrmSyncResult> {
  const purchase = await loadPurchase(purchaseId);
  if (!purchase || purchase.crmSyncStatus !== "pending") return "skipped";
  if (purchase.status !== "paid" && purchase.status !== "refunded") return "skipped";

  try {
    const dealId = await upsertDeal(dealFields(purchase, STAGE_BY_STATUS[purchase.status]));
    // Status in the filter: if a refund landed while this call was in flight, the row stays
    // 'pending' and the refund's own sync (or the retry) sends the newer state
    const { count } = await prisma.purchase.updateMany({
      where: { id: purchaseId, crmSyncStatus: "pending", status: purchase.status },
      data: {
        zohoDealId: dealId,
        crmSyncStatus: "synced",
        crmSyncedAt: new Date(),
        crmSyncError: null,
        crmSyncAttempts: { increment: 1 },
      },
    });
    if (count === 1) return "synced";
    // Status changed mid-call; the newer state's sync may already be done, and our stale write may
    // have landed after it. Re-queue and send the current state once more so Zoho ends up correct.
    await prisma.purchase.update({ where: { id: purchaseId }, data: { crmSyncStatus: "pending" } });
    return syncPurchase(purchaseId);
  } catch (err) {
    // Access is already correct; CRM stays 'pending' with the reason, for the retry command/button
    if (!(err instanceof ZohoError)) console.error(`CRM sync crashed for purchase ${purchaseId}`, err);
    await prisma.purchase.update({
      where: { id: purchaseId },
      data: { crmSyncError: errorMessage(err), crmSyncAttempts: { increment: 1 } },
    });
    return "pending";
  }
}

// Retry every paid or refunded purchase still waiting for Zoho, oldest first
export async function syncAllPendingPurchases(): Promise<{ synced: number; stillPending: number }> {
  const rows = await prisma.purchase.findMany({
    where: { status: { in: ["paid", "refunded"] }, crmSyncStatus: "pending" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  let synced = 0;
  for (const row of rows) {
    if ((await syncPurchase(row.id)) === "synced") synced++;
  }
  return { synced, stillPending: rows.length - synced };
}
