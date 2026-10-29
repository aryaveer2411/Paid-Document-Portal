import { z } from "zod";

// Stripe rejects charges under ~50 minor units and over 99,999,999
export const amountCents = z.int().min(50).max(99_999_999);
export const currency = z.string().regex(/^[a-z]{3}$/, "3-letter lowercase ISO code").default("usd");

export const updatePriceSchema = z.object({ amountCents, currency });

export type UpdatePriceInput = z.infer<typeof updatePriceSchema>;
