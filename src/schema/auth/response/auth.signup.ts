import { z } from "zod";

// No user id or tokens: same answer whether the email was new or already taken (no account probing)
export const signupResponseSchema = z.object({
  email: z.string(),
  needsEmailConfirmation: z.boolean(),
});

export type SignupResponse = z.infer<typeof signupResponseSchema>;
