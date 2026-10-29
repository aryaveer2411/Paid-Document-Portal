import { z } from "zod";

export const checkoutResponseSchema = z.object({
  purchaseId: z.uuid(),
  // Stripe-hosted payment page; the browser redirects here
  checkoutUrl: z.url(),
});

export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;
