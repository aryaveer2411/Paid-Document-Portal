import { z } from "zod";

// Only the document id: price and amount always come from our DB, never from the browser
export const createCheckoutSchema = z.object({ documentId: z.uuid() });

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
