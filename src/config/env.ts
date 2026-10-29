import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Base URL Stripe redirects back to after Checkout; trailing slash stripped
  APP_URL: z.url().default("http://localhost:3000").transform((url) => url.replace(/\/+$/, "")),
  // Runtime connection (Supabase pooler OK); migrations use DIRECT_URL via prisma.config.ts
  DATABASE_URL: z.url(),
  SUPABASE_URL: z.url(),
  // Public by design (browser-safe); RLS protects data. Never use the secret/service_role key here.
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_/, "must start with sk_ or rk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
});

const parsed = envSchema.safeParse(process.env);

// Fail fast at boot; messages name the variable, never print its value
if (!parsed.success) {
  console.error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
