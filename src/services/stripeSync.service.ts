import Stripe from "stripe";
import { prisma } from "../db.js";
import type { Document, Price } from "../generated/prisma/client.js";
import { stripe } from "../stripe.js";

// Local DB is the source of truth; this pushes one document and its unsynced prices to Stripe.
// A row is marked 'synced' only if its stripe_sync_version is unchanged since we read it,
// so an admin edit made mid-sync stays 'pending' and is picked up by the next sync.

function errorMessage(err: unknown) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function syncProduct(doc: Document): Promise<string> {
  let productId = doc.stripeProductId;
  if (productId && doc.stripeSyncStatus === "synced") return productId;

  const active = doc.archivedAt === null;
  if (!productId) {
    // Key includes version: same edit retried = same Stripe product, never a duplicate
    const product = await stripe.products.create(
      { name: doc.title, description: doc.description ?? undefined, active, metadata: { document_id: doc.id } },
      { idempotencyKey: `document-${doc.id}-v${doc.stripeSyncVersion}` },
    );
    productId = product.id;
    // Saved before marking synced: even if a later step fails, we never create this product again
    await prisma.document.update({ where: { id: doc.id }, data: { stripeProductId: productId } });
  } else {
    // "" clears the description in Stripe
    await stripe.products.update(productId, { name: doc.title, description: doc.description ?? "", active });
  }

  await prisma.document.updateMany({
    where: { id: doc.id, stripeSyncVersion: doc.stripeSyncVersion },
    data: { stripeSyncStatus: "synced", stripeSyncError: null, stripeSyncedAt: new Date() },
  });
  return productId;
}

async function syncPrice(price: Price, productId: string) {
  if (price.stripePriceId) {
    // Stripe Prices are immutable too; only active can change
    await stripe.prices.update(price.stripePriceId, { active: price.active });
  } else if (price.active) {
    // Price rows never change amount, so one key per row is safe forever
    const created = await stripe.prices.create(
      {
        product: productId,
        currency: price.currency,
        unit_amount: price.amountCents,
        metadata: { price_id: price.id, document_id: price.documentId },
      },
      { idempotencyKey: `price-${price.id}` },
    );
    await prisma.price.update({ where: { id: price.id }, data: { stripePriceId: created.id } });
  }
  // Inactive and never pushed: nothing for Stripe to mirror

  await prisma.price.updateMany({
    where: { id: price.id, stripeSyncVersion: price.stripeSyncVersion },
    data: { stripeSyncStatus: "synced", stripeSyncError: null, stripeSyncedAt: new Date() },
  });
}

// Stripe failures are recorded on the row (status 'failed' + message), not thrown: the admin's
// DB change already committed, and retry (button or `npm run stripe:sync`) finishes the job.
export async function syncDocumentToStripe(documentId: string): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: { prices: { where: { stripeSyncStatus: { not: "synced" } }, orderBy: { createdAt: "asc" } } },
  });
  if (!doc) return;

  let productId: string;
  try {
    productId = await syncProduct(doc);
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeError)) throw err;
    await prisma.document.update({
      where: { id: doc.id },
      data: { stripeSyncStatus: "failed", stripeSyncError: errorMessage(err) },
    });
    return; // prices need the product id
  }

  // Oldest first: the old price is deactivated in Stripe before or alongside the new one going live
  for (const price of doc.prices) {
    try {
      await syncPrice(price, productId);
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeError)) throw err;
      await prisma.price.update({
        where: { id: price.id },
        data: { stripeSyncStatus: "failed", stripeSyncError: errorMessage(err) },
      });
    }
  }
}

// Every document with anything not yet in Stripe; used by the retry command
export async function syncAllPending(): Promise<{ attempted: number }> {
  const docs = await prisma.document.findMany({
    where: {
      OR: [{ stripeSyncStatus: { not: "synced" } }, { prices: { some: { stripeSyncStatus: { not: "synced" } } } }],
    },
    select: { id: true },
  });
  for (const doc of docs) await syncDocumentToStripe(doc.id);
  return { attempted: docs.length };
}
