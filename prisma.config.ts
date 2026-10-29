import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7: CLI (migrate/generate) reads connection here, not from schema.prisma
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations need a direct (session) connection; pgbouncer transaction mode breaks them
  datasource: { url: env("DIRECT_URL") },
});
