import { z } from "zod";

// Route param `:id` = purchases.id; ownership is checked in the service, never trusted from the browser
export const purchaseIdSchema = z.object({ id: z.uuid() });
