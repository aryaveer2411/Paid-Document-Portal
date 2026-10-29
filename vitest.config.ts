import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    // Fake, offline values: src/config/env.ts validates at import, tests never reach real services
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SUPABASE_URL: "http://localhost:54321",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_test_fake",
      ZOHO_CLIENT_ID: "test-client-id",
      ZOHO_CLIENT_SECRET: "test-client-secret",
      ZOHO_REFRESH_TOKEN: "test-refresh-token",
      ZOHO_ACCOUNTS_URL: "https://accounts.zoho.test",
      ZOHO_API_URL: "https://api.zoho.test",
    },
    restoreMocks: true,
  },
});
