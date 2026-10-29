import { z } from "zod";

// refunded = Stripe confirmed · pending = Stripe unreachable, access already off, retry will finish it
export const refundResponseSchema = z.object({
  purchaseId: z.uuid(),
  status: z.enum(["refunded", "pending"]),
});

export type RefundResponse = z.infer<typeof refundResponseSchema>;
