import { Router, type Request, type Response } from "express";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { HttpError } from "../httpError.js";
import { requireAdmin } from "../middleware/requireAdmin.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";
import { createProductSchema } from "../schema/admin/request/admin.createProduct.js";
import { productIdSchema } from "../schema/admin/request/admin.productId.js";
import { updatePriceSchema } from "../schema/admin/request/admin.updatePrice.js";
import { toProduct, withActivePrice } from "../schema/admin/response/admin.product.js";
import { parse } from "../validate.js";

export const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);

// Row lock: price changes and archive on the same product run one after another, never interleaved
async function lockDocument(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ archived_at: Date | null }[]>`
    select archived_at from documents where id = ${id}::uuid for update`;
  const row = rows[0];
  if (!row) throw new HttpError(404, "Product not found");
  return row;
}

adminRouter.get("/products", async (_req: Request, res: Response) => {
  const docs = await prisma.document.findMany({ include: withActivePrice, orderBy: { createdAt: "desc" } });
  res.json({ products: docs.map(toProduct) });
});

adminRouter.post("/products", async (req: Request, res: Response) => {
  const body = parse(createProductSchema, req.body);
  const adminId = req.user!.id;

  try {
    // Nested create = document + first price in one transaction
    const doc = await prisma.document.create({
      data: {
        title: body.title,
        description: body.description ?? null,
        storagePath: body.storagePath,
        prices: {
          create: { amountCents: body.amountCents, currency: body.currency, createdById: adminId, updatedById: adminId },
        },
      },
      include: withActivePrice,
    });
    res.status(201).json({ product: toProduct(doc) });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(409, "storagePath already used by another product");
    }
    throw err;
  }
});

// Prices are immutable (DB trigger enforces it): deactivate current row, insert new one
adminRouter.put("/products/:id/price", async (req: Request, res: Response) => {
  const { id } = parse(productIdSchema, req.params);
  const body = parse(updatePriceSchema, req.body);
  const adminId = req.user!.id;

  const doc = await prisma.$transaction(async (tx) => {
    const locked = await lockDocument(tx, id);
    if (locked.archived_at) throw new HttpError(409, "Product is deleted; restore is not supported");

    const current = await tx.price.findFirst({ where: { documentId: id, active: true } });
    const unchanged = current?.amountCents === body.amountCents && current.currency === body.currency;
    if (!unchanged) {
      await tx.price.updateMany({ where: { documentId: id, active: true }, data: { active: false, updatedById: adminId } });
      await tx.price.create({
        data: { documentId: id, amountCents: body.amountCents, currency: body.currency, createdById: adminId, updatedById: adminId },
      });
    }
    return tx.document.findUniqueOrThrow({ where: { id }, include: withActivePrice });
  });

  res.json({ product: toProduct(doc) });
});

// Soft delete: hide from new purchases, keep rows so past purchases and entitlements stay valid
adminRouter.delete("/products/:id", async (req: Request, res: Response) => {
  const { id } = parse(productIdSchema, req.params);
  const adminId = req.user!.id;

  const doc = await prisma.$transaction(async (tx) => {
    const locked = await lockDocument(tx, id);
    // Repeat delete = no-op, same result
    if (!locked.archived_at) {
      await tx.document.update({ where: { id }, data: { archivedAt: new Date() } });
      await tx.price.updateMany({ where: { documentId: id, active: true }, data: { active: false, updatedById: adminId } });
    }
    return tx.document.findUniqueOrThrow({ where: { id }, include: withActivePrice });
  });

  res.json({ product: toProduct(doc) });
});
