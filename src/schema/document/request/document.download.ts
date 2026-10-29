import { z } from "zod";

// Route param `:id` = documents.id
export const documentIdSchema = z.object({ id: z.uuid() });
