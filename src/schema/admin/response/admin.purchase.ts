import { z } from "zod";
import type { Prisma } from "../../../generated/prisma/client.js";

export const purchaseInclude = {
  user: { select: { email: true, fullName: true } },
  document: { select: { title: true } },
} satisfies Prisma.PurchaseInclude;

type PurchaseWithRefs = Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>;

// Admin-only view: includes Zoho ids and the last sync error for debugging
export const adminPurchaseSchema = z.object({
  id: z.uuid(),
  customer: z.string(),
  documentTitle: z.string(),
  amountCents: z.int(),
  currency: z.string(),
  status: z.enum(["pending", "paid", "failed", "refunded"]),
  paidAt: z.date().nullable(),
  zohoDealId: z.string().nullable(),
  crmSyncStatus: z.enum(["pending", "synced"]).nullable(),
  crmSyncError: z.string().nullable(),
  crmSyncAttempts: z.int(),
});

export type AdminPurchase = z.infer<typeof adminPurchaseSchema>;

export function toAdminPurchase(p: PurchaseWithRefs): AdminPurchase {
  return adminPurchaseSchema.parse({ ...p, customer: `${p.user.fullName} <${p.user.email}>`, documentTitle: p.document.title });
}
