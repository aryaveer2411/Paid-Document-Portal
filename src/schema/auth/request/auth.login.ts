import { z } from "zod";

// Password rules not re-checked here: login only compares, and old accounts may predate current rules
export const loginSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(1).max(72),
});

export type LoginInput = z.infer<typeof loginSchema>;
