import { prisma } from "../db.js";
import { retryPendingRefunds } from "../services/refund.service.js";

// Retry command: `npm run refund:retry` finishes refunds whose Stripe call failed mid-way
try {
  const { settled, stillPending } = await retryPendingRefunds();
  console.log(`Refunds: ${settled} settled, ${stillPending} still pending`);
  process.exitCode = stillPending > 0 ? 1 : 0;
} finally {
  await prisma.$disconnect();
}
