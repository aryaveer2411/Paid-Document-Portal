import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import { Prisma } from "../generated/prisma/client.js";
import type { CreateProductInput } from "../schema/admin/request/admin.createProduct.js";
import type { UpdatePriceInput } from "../schema/admin/request/admin.updatePrice.js";
import { toProduct, withActivePrice, type ProductResponse } from "../schema/admin/response/admin.product.js";

// Row lock: price changes and archive on the same product run one after another, never interleaved
async function lockDocument(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ archived_at: Date | null }[]>`
    select archived_at from documents where id = ${id}::uuid for update`;
  const row = rows[0];
  if (!row) throw ApiError.notFound("Product not found");
  return row;
}

export async function listProducts(): Promise<ProductResponse[]> {
  const docs = await prisma.document.findMany({ include: withActivePrice, orderBy: { createdAt: "desc" } });
  return docs.map(toProduct);
}

export async function createProduct(input: CreateProductInput, adminId: string): Promise<ProductResponse> {
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
      include: withActivePrice,
    });
    return toProduct(doc);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict("storagePath already used by another product");
    }
    throw err;
  }
}

// Prices are immutable (DB trigger enforces it): deactivate current row, insert new one
export async function updatePrice(id: string, input: UpdatePriceInput, adminId: string): Promise<ProductResponse> {
  const doc = await prisma.$transaction(async (tx) => {
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
    return tx.document.findUniqueOrThrow({ where: { id }, include: withActivePrice });
  });
  return toProduct(doc);
}

// Soft delete: hide from new purchases, keep rows so past purchases and entitlements stay valid
export async function archiveProduct(id: string, adminId: string): Promise<ProductResponse> {
  const doc = await prisma.$transaction(async (tx) => {
    const locked = await lockDocument(tx, id);
    // Repeat delete = no-op, same result
    if (!locked.archived_at) {
      await tx.document.update({ where: { id }, data: { archivedAt: new Date() } });
      await tx.price.updateMany({ where: { documentId: id, active: true }, data: { active: false, updatedById: adminId } });
    }
    return tx.document.findUniqueOrThrow({ where: { id }, include: withActivePrice });
  });
  return toProduct(doc);
}
