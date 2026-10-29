import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  purchase: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));

vi.mock("../db.js", () => ({ prisma }));
// Keep the real ZohoError class: the service branches on instanceof
vi.mock("../services/zoho.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/zoho.service.js")>()),
  upsertDeal: vi.fn(),
}));

const { syncPurchase, syncAllPendingPurchases } = await import("../services/crmSync.service.js");
const { upsertDeal, ZohoError } = await import("../services/zoho.service.js");

const PURCHASE_ID = "11111111-1111-4111-8111-111111111111";

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    id: PURCHASE_ID,
    status: "paid",
    crmSyncStatus: "pending",
    amountCents: 49900,
    currency: "inr",
    paidAt: new Date("2026-10-01T10:00:00Z"),
    refundedAt: null,
    user: { email: "client.a@example.com", fullName: "Client A" },
    document: { title: "Sample PDF" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  prisma.purchase.updateMany.mockResolvedValue({ count: 1 });
  prisma.purchase.update.mockResolvedValue({});
  vi.mocked(upsertDeal).mockResolvedValue("zoho_deal_1");
});

describe("syncPurchase", () => {
  it("paid purchase → Deal Closed Won, row marked synced", async () => {
    prisma.purchase.findUnique.mockResolvedValue(loaded());

    expect(await syncPurchase(PURCHASE_ID)).toBe("synced");

    expect(upsertDeal).toHaveBeenCalledExactlyOnceWith({
      purchaseId: PURCHASE_ID,
      name: "Sample PDF - Client A",
      stage: "Closed Won",
      amount: 499,
      currency: "INR",
      closingDate: new Date("2026-10-01T10:00:00Z"),
      description: "Portal purchase by client.a@example.com",
    });
    expect(prisma.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: PURCHASE_ID, crmSyncStatus: "pending", status: "paid" },
      data: expect.objectContaining({ zohoDealId: "zoho_deal_1", crmSyncStatus: "synced", crmSyncError: null }),
    });
  });

  it("refunded purchase → Deal Closed Lost, marked [Refunded]", async () => {
    prisma.purchase.findUnique.mockResolvedValue(loaded({ status: "refunded", refundedAt: new Date("2026-10-02T00:00:00Z") }));

    expect(await syncPurchase(PURCHASE_ID)).toBe("synced");

    expect(upsertDeal).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "Closed Lost",
        name: "Sample PDF - Client A [Refunded]",
        description: "Portal purchase by client.a@example.com. Refunded on 2026-10-02",
      }),
    );
  });

  it("already synced → skipped, Zoho not called (no second update)", async () => {
    prisma.purchase.findUnique.mockResolvedValue(loaded({ crmSyncStatus: "synced" }));

    expect(await syncPurchase(PURCHASE_ID)).toBe("skipped");
    expect(upsertDeal).not.toHaveBeenCalled();
  });

  it.each(["pending", "failed"])("%s purchase → skipped", async (status) => {
    prisma.purchase.findUnique.mockResolvedValue(loaded({ status }));

    expect(await syncPurchase(PURCHASE_ID)).toBe("skipped");
    expect(upsertDeal).not.toHaveBeenCalled();
  });

  it("missing purchase → skipped", async () => {
    prisma.purchase.findUnique.mockResolvedValue(null);
    expect(await syncPurchase(PURCHASE_ID)).toBe("skipped");
  });

  it("Zoho down → stays pending with the error recorded", async () => {
    prisma.purchase.findUnique.mockResolvedValue(loaded());
    vi.mocked(upsertDeal).mockRejectedValue(new ZohoError("Zoho unreachable: fetch failed"));

    expect(await syncPurchase(PURCHASE_ID)).toBe("pending");

    expect(prisma.purchase.updateMany).not.toHaveBeenCalled();
    expect(prisma.purchase.update).toHaveBeenCalledWith({
      where: { id: PURCHASE_ID },
      data: { crmSyncError: "Zoho unreachable: fetch failed", crmSyncAttempts: { increment: 1 } },
    });
  });

  it("unexpected error → stays pending and is logged", async () => {
    prisma.purchase.findUnique.mockResolvedValue(loaded());
    vi.mocked(upsertDeal).mockRejectedValue(new TypeError("boom"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await syncPurchase(PURCHASE_ID)).toBe("pending");
    expect(errors).toHaveBeenCalled();
  });

  it("status changed during the Zoho call → re-queues and sends the newer state", async () => {
    prisma.purchase.findUnique
      .mockResolvedValueOnce(loaded())
      .mockResolvedValueOnce(loaded({ status: "refunded", refundedAt: new Date("2026-10-02T00:00:00Z") }));
    prisma.purchase.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    expect(await syncPurchase(PURCHASE_ID)).toBe("synced");

    expect(prisma.purchase.update).toHaveBeenCalledWith({ where: { id: PURCHASE_ID }, data: { crmSyncStatus: "pending" } });
    expect(vi.mocked(upsertDeal).mock.calls.map(([deal]) => deal.stage)).toEqual(["Closed Won", "Closed Lost"]);
  });
});

describe("syncAllPendingPurchases (retry command)", () => {
  it("retries each pending row and counts what is still pending", async () => {
    prisma.purchase.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    prisma.purchase.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => loaded({ id: where.id }));
    vi.mocked(upsertDeal).mockResolvedValueOnce("deal_a").mockRejectedValueOnce(new ZohoError("Zoho 500"));

    expect(await syncAllPendingPurchases()).toEqual({ synced: 1, stillPending: 1 });
    expect(prisma.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["paid", "refunded"] }, crmSyncStatus: "pending" } }),
    );
  });
});
