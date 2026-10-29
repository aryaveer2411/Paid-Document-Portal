import { z } from "zod";
import type { Prisma } from "../../../generated/prisma/client.js";

// Query shape that every admin product response is built from. All prices (not just active):
// a deactivated price can still be waiting to be archived in Stripe, and its sync status must show.
export const withPrices = {
  prices: {
    select: {
      id: true,
      amountCents: true,
      currency: true,
      active: true,
      stripePriceId: true,
      stripeSyncStatus: true,
      stripeSyncError: true,
    },
  },
} satisfies Prisma.DocumentInclude;

type DocumentWithPrice = Prisma.DocumentGetPayload<{ include: typeof withPrices }>;

const syncStatus = z.enum(["pending", "synced", "failed"]);

// Whitelist of fields sent to the browser; zod strips anything not listed
export const productResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  storagePath: z.string(),
  archivedAt: z.date().nullable(),
  stripeProductId: z.string().nullable(),
  price: z
    .object({ id: z.uuid(), amountCents: z.int(), currency: z.string(), stripePriceId: z.string().nullable() })
    .nullable(),
  // Product + all its prices combined: worst status wins, first error shown
  stripeSync: z.object({ status: syncStatus, error: z.string().nullable() }),
});

export type ProductResponse = z.infer<typeof productResponseSchema>;

export function toProduct(doc: DocumentWithPrice): ProductResponse {
  const rows = [doc, ...doc.prices];
  const statuses = rows.map((r) => r.stripeSyncStatus);
  const status = statuses.includes("failed") ? "failed" : statuses.includes("pending") ? "pending" : "synced";
  const error = rows.find((r) => r.stripeSyncError)?.stripeSyncError ?? null;

  return productResponseSchema.parse({
    ...doc,
    price: doc.prices.find((p) => p.active) ?? null,
    stripeSync: { status, error },
  });
}
