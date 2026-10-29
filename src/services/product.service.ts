import { prisma } from "../db.js";
import { catalogItemSchema, purchasableWhere, type CatalogItem } from "../schema/product/response/product.catalog.js";

// Prisma skips RLS, so "owned" must be filtered by this user's id here.
// Guests (userId null) never load entitlements: a `userId: undefined` filter would match everyone's.
export async function listCatalog(userId: string | null): Promise<CatalogItem[]> {
  const docs = await prisma.document.findMany({
    where: purchasableWhere,
    include: {
      prices: { where: { active: true }, take: 1, select: { amountCents: true, currency: true } },
      entitlements: { where: { userId: userId ?? undefined, revokedAt: null }, take: userId ? undefined : 0, select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return docs.map((doc) =>
    catalogItemSchema.parse({ ...doc, price: doc.prices[0], owned: userId !== null && doc.entitlements.length > 0 }),
  );
}
