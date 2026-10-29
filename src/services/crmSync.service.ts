import { prisma } from "../db.js";
import { upsertDeal, ZohoError } from "./zoho.service.js";

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

function dealFields(purchase: LoadedPurchase, stage: "Qualification" | "Closed Won") {
  return {
    purchaseId: purchase.id,
    name: `${purchase.document.title} - ${purchase.user.fullName}`,
    stage,
    amount: purchase.amountCents / 100,
    currency: purchase.currency.toUpperCase(),
    closingDate: purchase.paidAt ?? new Date(),
    description: `Portal purchase by ${purchase.user.email}`,
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

// After payment: mark the Deal "Closed Won". Only rows the webhook marked 'pending' are touched,
// so a repeated call after success does nothing (no second Zoho update).
export async function syncPaidPurchase(purchaseId: string): Promise<CrmSyncResult> {
  const purchase = await loadPurchase(purchaseId);
  if (!purchase || purchase.status !== "paid" || purchase.crmSyncStatus !== "pending") return "skipped";

  try {
    const dealId = await upsertDeal(dealFields(purchase, "Closed Won"));
    await prisma.purchase.updateMany({
      where: { id: purchaseId, crmSyncStatus: "pending" },
      data: {
        zohoDealId: dealId,
        crmSyncStatus: "synced",
        crmSyncedAt: new Date(),
        crmSyncError: null,
        crmSyncAttempts: { increment: 1 },
      },
    });
    return "synced";
  } catch (err) {
    // Access is already granted; CRM stays 'pending' with the reason, for the retry command/button
    if (!(err instanceof ZohoError)) console.error(`CRM sync crashed for purchase ${purchaseId}`, err);
    await prisma.purchase.update({
      where: { id: purchaseId },
      data: { crmSyncError: errorMessage(err), crmSyncAttempts: { increment: 1 } },
    });
    return "pending";
  }
}

// Retry every paid purchase still waiting for Zoho, oldest first
export async function syncAllPendingPurchases(): Promise<{ synced: number; stillPending: number }> {
  const rows = await prisma.purchase.findMany({
    where: { status: "paid", crmSyncStatus: "pending" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  let synced = 0;
  for (const row of rows) {
    if ((await syncPaidPurchase(row.id)) === "synced") synced++;
  }
  return { synced, stillPending: rows.length - synced };
}
