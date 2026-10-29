import { z } from "zod";

// Browser hands these to supabase-js setSession(), so it can read its own rows from Supabase (RLS)
export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.int().optional(),
  user: z.object({ id: z.uuid(), email: z.string().nullable() }),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;
