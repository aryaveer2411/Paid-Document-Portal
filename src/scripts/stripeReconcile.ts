import { prisma } from "../db.js";
import { reconcilePendingPurchases } from "../services/reconcile.service.js";

// `npm run stripe:reconcile`: settle purchases stuck in "pending" (e.g. webhook never arrived)
try {
  const { paid, failed, waiting, errors } = await reconcilePendingPurchases();
  console.log(`Reconcile: ${paid} paid, ${failed} failed, ${waiting} still waiting, ${errors} errors`);
  process.exitCode = errors > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
