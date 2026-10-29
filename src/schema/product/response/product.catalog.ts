import { z } from "zod";
import type { Prisma } from "../../../generated/prisma/client.js";

// Buyable = not deleted, exists in Stripe, and has an active price that exists in Stripe.
// Shared by the catalog and checkout, so the page never shows something checkout would refuse.
export const purchasableWhere = {
  archivedAt: null,
  stripeProductId: { not: null },
  prices: { some: { active: true, stripePriceId: { not: null } } },
} satisfies Prisma.DocumentWhereInput;

// Client-facing product: no storage path, no Stripe internals
export const catalogItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  price: z.object({ amountCents: z.int(), currency: z.string() }),
  owned: z.boolean(),
});

export type CatalogItem = z.infer<typeof catalogItemSchema>;
