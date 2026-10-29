import { z } from "zod";

// Route param `:id`; rejects non-UUIDs before they reach the DB
export const productIdSchema = z.object({ id: z.uuid() });
