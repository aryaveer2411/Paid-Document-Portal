import { prisma } from "../db.js";
import { syncAllPendingPurchases } from "../services/crmSync.service.js";

// Retry command: `npm run zoho:retry` pushes every paid purchase still marked CRM 'pending' to Zoho
try {
  const { synced, stillPending } = await syncAllPendingPurchases();
  console.log(`Zoho sync: ${synced} synced, ${stillPending} still pending`);
  process.exitCode = stillPending > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
