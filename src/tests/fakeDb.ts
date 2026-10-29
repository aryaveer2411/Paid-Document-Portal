import { randomUUID } from "node:crypto";

// In-memory stand-in for the few Prisma calls the payment flow makes. Enough to check the business rules
// (dedupe, one entitlement, status changes); real locking and constraints are Postgres's job.

export type FakePurchase = {
  id: string;
  userId: string;
  documentId: string;
  amountCents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  refundRequestedAt: Date | null;
  crmSyncStatus: "pending" | "synced" | null;
};

export type FakeEntitlement = {
  id: string;
  userId: string;
  documentId: string;
  purchaseId: string;
  grantedAt: Date;
  revokedAt: Date | null;
  openedAt: Date | null;
};

type Where = Record<string, unknown>;

// Supports plain equality plus { not: null }, which is all the services use
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (want && typeof want === "object" && "not" in want) return row[key] !== (want as { not: unknown }).not;
    return row[key] === want;
  });
}

export function createFakeDb() {
  const purchases = new Map<string, FakePurchase>();
  const entitlements: FakeEntitlement[] = [];
  const events = new Map<string, { type: string; purchaseId: string }>();

  const client = {
    $queryRaw: async () => [],
    stripeEvent: {
      createMany: async ({ data }: { data: { id: string; type: string; purchaseId: string }[] }) => {
        let count = 0;
        for (const e of data) {
          if (events.has(e.id)) continue;
          events.set(e.id, { type: e.type, purchaseId: e.purchaseId });
          count++;
        }
        return { count };
      },
    },
    purchase: {
      findUnique: async ({ where }: { where: Where }) =>
        [...purchases.values()].find((p) => matches(p, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakePurchase> }) => {
        const row = purchases.get(where.id);
        if (!row) throw new Error(`purchase ${where.id} not found`);
        return Object.assign(row, data);
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<FakePurchase> }) => {
        const rows = [...purchases.values()].filter((p) => matches(p, where));
        rows.forEach((p) => Object.assign(p, data));
        return { count: rows.length };
      },
    },
    entitlement: {
      findUnique: async ({ where }: { where: { userId_documentId: { userId: string; documentId: string } } }) =>
        entitlements.find((e) => matches(e, where.userId_documentId)) ?? null,
      create: async ({ data }: { data: Pick<FakeEntitlement, "userId" | "documentId" | "purchaseId"> }) => {
        const row = { id: randomUUID(), grantedAt: new Date(), revokedAt: null, openedAt: null, ...data };
        entitlements.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeEntitlement> }) => {
        const row = entitlements.find((e) => e.id === where.id);
        if (!row) throw new Error(`entitlement ${where.id} not found`);
        return Object.assign(row, data);
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<FakeEntitlement> }) => {
        const rows = entitlements.filter((e) => matches(e, where));
        rows.forEach((e) => Object.assign(e, data));
        return { count: rows.length };
      },
    },
  };

  // Transaction runs the callback on the same client; no rollback is needed for these tests
  const prisma = { ...client, $transaction: async <T>(fn: (tx: typeof client) => Promise<T>) => fn(client) };

  function addPurchase(overrides: Partial<FakePurchase> = {}): FakePurchase {
    const row: FakePurchase = {
      id: randomUUID(),
      userId: randomUUID(),
      documentId: randomUUID(),
      amountCents: 50000,
      currency: "inr",
      status: "pending",
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      paidAt: null,
      refundedAt: null,
      refundRequestedAt: null,
      crmSyncStatus: null,
      ...overrides,
    };
    purchases.set(row.id, row);
    return row;
  }

  function addEntitlement(data: Pick<FakeEntitlement, "userId" | "documentId" | "purchaseId"> & Partial<FakeEntitlement>) {
    const row: FakeEntitlement = { id: randomUUID(), grantedAt: new Date(), revokedAt: null, openedAt: null, ...data };
    entitlements.push(row);
    return row;
  }

  function reset() {
    purchases.clear();
    entitlements.length = 0;
    events.clear();
  }

  return { prisma, purchases, entitlements, events, addPurchase, addEntitlement, reset };
}
