import { z } from "zod";

// Path the server chose inside the bucket; the admin passes it to "create product"
export const uploadResponseSchema = z.object({
  storagePath: z.string(),
  sizeBytes: z.int(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
