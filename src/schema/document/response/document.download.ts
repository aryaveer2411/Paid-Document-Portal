import { z } from "zod";

// Short-lived link to the private file; useless after it expires, so sharing it leaks little
export const downloadResponseSchema = z.object({
  url: z.url(),
  expiresInSeconds: z.int(),
});

export type DownloadResponse = z.infer<typeof downloadResponseSchema>;
