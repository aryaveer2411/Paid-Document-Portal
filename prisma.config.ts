import { defineConfig, env } from "prisma/config";

// Prisma CLI runs outside `npm run dev`, so load .env with Node's built-in loader; a missing file is fine
try {
  process.loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
}

// Prisma 7: CLI (migrate/generate) reads connection here, not from schema.prisma
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations need a direct (session) connection; pgbouncer transaction mode breaks them
  datasource: { url: env("DIRECT_URL") },
});
