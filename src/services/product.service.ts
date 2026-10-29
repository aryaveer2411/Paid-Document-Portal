import { prisma } from "../db.js";
import { catalogItemSchema, purchasableWhere, type CatalogItem } from "../schema/product/response/product.catalog.js";

// Prisma skips RLS, so "owned" must be filtered by this user's id here
export async function listCatalog(userId: string): Promise<CatalogItem[]> {
  const docs = await prisma.document.findMany({
    where: purchasableWhere,
    include: {
      prices: { where: { active: true }, take: 1, select: { amountCents: true, currency: true } },
      entitlements: { where: { userId, revokedAt: null }, select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return docs.map((doc) =>
    catalogItemSchema.parse({ ...doc, price: doc.prices[0], owned: doc.entitlements.length > 0 }),
  );
}
