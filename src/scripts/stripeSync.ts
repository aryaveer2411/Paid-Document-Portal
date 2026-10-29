import { prisma } from "../db.js";
import { syncAllPending } from "../services/stripeSync.service.js";

// Retry command: `npm run stripe:sync` pushes every pending/failed product and price to Stripe
try {
  const { attempted } = await syncAllPending();
  const failed = await prisma.document.count({
    where: { OR: [{ stripeSyncStatus: "failed" }, { prices: { some: { stripeSyncStatus: "failed" } } }] },
  });
  console.log(`Stripe sync: ${attempted} product(s) attempted, ${failed} still failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
