import { z } from "zod";
import type { Prisma } from "../../../generated/prisma/client.js";

// Query shape that every admin product response is built from
export const withActivePrice = {
  prices: { where: { active: true }, take: 1, select: { id: true, amountCents: true, currency: true } },
} satisfies Prisma.DocumentInclude;

type DocumentWithPrice = Prisma.DocumentGetPayload<{ include: typeof withActivePrice }>;

// Whitelist of fields sent to the browser; zod strips anything not listed
export const productResponseSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  storagePath: z.string(),
  archivedAt: z.date().nullable(),
  price: z.object({ id: z.uuid(), amountCents: z.int(), currency: z.string() }).nullable(),
  stripeSyncStatus: z.enum(["pending", "synced", "failed"]),
});

export type ProductResponse = z.infer<typeof productResponseSchema>;

export function toProduct(doc: DocumentWithPrice): ProductResponse {
  return productResponseSchema.parse({ ...doc, price: doc.prices[0] ?? null });
}
