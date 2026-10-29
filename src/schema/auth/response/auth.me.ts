import { z } from "zod";

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string().nullable(),
    fullName: z.string(),
    role: z.enum(["client", "admin"]),
  }),
});

export type MeResponse = z.infer<typeof meResponseSchema>;
