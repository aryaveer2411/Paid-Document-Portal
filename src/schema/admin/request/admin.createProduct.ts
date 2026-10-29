import { z } from "zod";
import { amountCents, currency } from "./admin.updatePrice.js";

export const createProductSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // Object path inside the private Storage bucket; no "..", no leading slash
  storagePath: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_\-/]*\.[A-Za-z0-9]+$/, "e.g. samples/guide.pdf").max(200),
  amountCents,
  currency,
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
