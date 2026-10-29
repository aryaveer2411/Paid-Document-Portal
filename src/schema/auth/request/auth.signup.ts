import { z } from "zod";

// No role field: everyone signs up as client; admin is set by SQL only
export const signupSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(8).max(72),
  fullName: z.string().trim().min(1).max(200).optional(),
});

export type SignupInput = z.infer<typeof signupSchema>;
