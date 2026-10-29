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
  // Currency new prices are created in (customer pays this); Stripe settles into the account's own currency
  DEFAULT_CURRENCY: z.string().regex(/^[a-z]{3}$/).default("inr"),
  // Private Supabase Storage bucket holding the paid documents
  STORAGE_BUCKET: z.string().min(1).default("documents"),
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_/, "must start with sk_ or rk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  // Zoho Self Client (OAuth). Refresh token is long-lived; access tokens are fetched from it hourly.
  ZOHO_CLIENT_ID: z.string().min(1),
  ZOHO_CLIENT_SECRET: z.string().min(1),
  ZOHO_REFRESH_TOKEN: z.string().min(1),
  // Data-center specific (.in, .com, .eu ...); must match where the Zoho account lives
  ZOHO_ACCOUNTS_URL: z.url().default("https://accounts.zoho.in").transform((url) => url.replace(/\/+$/, "")),
  ZOHO_API_URL: z.url().default("https://www.zohoapis.in").transform((url) => url.replace(/\/+$/, "")),
  // Unique custom Deal field holding our purchase id: the stable link Zoho dedupes on
  ZOHO_DEAL_PURCHASE_FIELD: z.string().regex(/^[A-Za-z0-9_]+$/).default("Portal_Purchase_ID"),
  // Zoho org's home currency: Deals in it are sent without a Currency field (no multi-currency needed)
  ZOHO_HOME_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default("INR"),
  // Only needed if the Zoho org makes Pipeline mandatory on Deals
  ZOHO_DEAL_PIPELINE: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

// Fail fast at boot; messages name the variable, never print its value
if (!parsed.success) {
  console.error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const env = parsed.data;
