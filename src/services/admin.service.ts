import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import { Prisma } from "../generated/prisma/client.js";
import type { CreateProductInput } from "../schema/admin/request/admin.createProduct.js";
import type { UpdatePriceInput } from "../schema/admin/request/admin.updatePrice.js";
import { toProduct, withPrices, type ProductResponse } from "../schema/admin/response/admin.product.js";
import { purchaseInclude, toAdminPurchase, type AdminPurchase } from "../schema/admin/response/admin.purchase.js";
import { syncAllPendingPurchases } from "./crmSync.service.js";
import { syncDocumentToStripe } from "./stripeSync.service.js";

// Row lock: price changes and archive on the same product run one after another, never interleaved
async function lockDocument(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ archived_at: Date | null }[]>`
    select archived_at from documents where id = ${id}::uuid for update`;
  const row = rows[0];
  if (!row) throw ApiError.notFound("Product not found");
  return row;
}

// Runs after the DB commit, never inside the transaction: a slow Stripe call must not hold row locks,
// and a Stripe outage must not undo the admin's change. Outcome is stored on the rows (synced/failed).
async function syncAndLoad(id: string): Promise<ProductResponse> {
  try {
    await syncDocumentToStripe(id);
  } catch (err) {
    // Non-Stripe failure (e.g. DB blip while saving ids): change is saved, row stays pending for retry
    console.error(`Stripe sync crashed for document ${id}`, err);
  }
  const doc = await prisma.document.findUniqueOrThrow({ where: { id }, include: withPrices });
  return toProduct(doc);
}

export async function listProducts(): Promise<ProductResponse[]> {
  const docs = await prisma.document.findMany({ include: withPrices, orderBy: { createdAt: "desc" } });
  return docs.map(toProduct);
}

export async function createProduct(input: CreateProductInput, adminId: string): Promise<ProductResponse> {
  let id: string;
  try {
    // Nested create = document + first price in one transaction
    const doc = await prisma.document.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        storagePath: input.storagePath,
        prices: {
          create: { amountCents: input.amountCents, currency: input.currency, createdById: adminId, updatedById: adminId },
        },
      },
      select: { id: true },
    });
    id = doc.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("storagePath already used by another product");
    }
    throw err;
  }
  return syncAndLoad(id);
}

// Prices are immutable (DB trigger enforces it): deactivate current row, insert new one
export async function updatePrice(id: string, input: UpdatePriceInput, adminId: string): Promise<ProductResponse> {
  await prisma.$transaction(async (tx) => {
    const locked = await lockDocument(tx, id);
    if (locked.archived_at) throw ApiError.conflict("Product is deleted; restore is not supported");

    const current = await tx.price.findFirst({ where: { documentId: id, active: true } });
    const unchanged = current?.amountCents === input.amountCents && current.currency === input.currency;
    if (!unchanged) {
      await tx.price.updateMany({ where: { documentId: id, active: true }, data: { active: false, updatedById: adminId } });
      await tx.price.create({
        data: { documentId: id, amountCents: input.amountCents, currency: input.currency, createdById: adminId, updatedById: adminId },
      });
    }
  });
  return syncAndLoad(id);
}

// Soft delete: hide from new purchases, keep rows so past purchases and entitlements stay valid
export async function archiveProduct(id: string, adminId: string): Promise<ProductResponse> {
  await prisma.$transaction(async (tx) => {
    const locked = await lockDocument(tx, id);
    // Repeat delete = no-op, same result
    if (!locked.archived_at) {
      await tx.document.update({ where: { id }, data: { archivedAt: new Date() } });
      await tx.price.updateMany({ where: { documentId: id, active: true }, data: { active: false, updatedById: adminId } });
    }
  });
  return syncAndLoad(id);
}

export async function listPurchases(): Promise<AdminPurchase[]> {
  const rows = await prisma.purchase.findMany({ include: purchaseInclude, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map(toAdminPurchase);
}

// Same work as `npm run zoho:retry`, from the admin page
export async function retryCrmSync() {
  return syncAllPendingPurchases();
}

// Manual retry for a product whose Stripe sync is pending or failed
export async function retryStripeSync(id: string): Promise<ProductResponse> {
  const exists = await prisma.document.count({ where: { id } });
  if (!exists) throw ApiError.notFound("Product not found");
  return syncAndLoad(id);
}
