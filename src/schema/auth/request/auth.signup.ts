import { z } from "zod";

// No role field: everyone signs up as client; admin is set by SQL only
export const signupSchema = z.object({
  email: z.email().trim().toLowerCase().max(254),
  password: z.string().min(8).max(72),
  // Same message whether the field is missing or only spaces
  fullName: z.string({ error: "Full name is required" }).trim().min(1, "Full name is required").max(200),
});

export type SignupInput = z.infer<typeof signupSchema>;
