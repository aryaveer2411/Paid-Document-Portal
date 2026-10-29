import { z } from "zod";
import { env } from "../../../config/env.js";

// Stripe needs each charge worth at least ~0.50 of the account's settlement currency (AUD here).
// 50 minor units is fine for USD/AUD/EUR; ₹0.50 is far below, so INR needs ₹50.
const MIN_AMOUNT_MINOR: Record<string, number> = { inr: 5000 };
const DEFAULT_MIN = 50;

export const amountCents = z.int().positive().max(99_999_999);
export const currency = z.string().regex(/^[a-z]{3}$/, "3-letter lowercase ISO code").default(env.DEFAULT_CURRENCY);

// Minimum depends on the currency, so it is checked on the whole object
export function withMinimumAmount<T extends { amountCents: number; currency: string }>(value: T, ctx: z.RefinementCtx) {
  const min = MIN_AMOUNT_MINOR[value.currency] ?? DEFAULT_MIN;
  if (value.amountCents < min) {
    ctx.addIssue({
      code: "custom",
      path: ["amountCents"],
      message: `Minimum is ${(min / 100).toFixed(2)} ${value.currency.toUpperCase()} (Stripe limit)`,
    });
  }
}

export const updatePriceSchema = z.object({ amountCents, currency }).superRefine(withMinimumAmount);

export type UpdatePriceInput = z.infer<typeof updatePriceSchema>;
