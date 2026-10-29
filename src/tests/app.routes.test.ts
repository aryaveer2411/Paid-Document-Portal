import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Two signed-in clients; each token maps to one Supabase user
const CLIENT_A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "client.a@example.com" };
const CLIENT_B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "client.b@example.com" };
const DOC_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PURCHASE_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const mocks = vi.hoisted(() => {
  const prisma = {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    user: { findUnique: vi.fn() },
    purchase: { findUnique: vi.fn() },
    entitlement: { findFirst: vi.fn(), updateMany: vi.fn() },
  };
  return { prisma, getUser: vi.fn(), createSignedUrl: vi.fn(), handleStripeEvent: vi.fn() };
});

vi.mock("../db.js", () => ({ prisma: mocks.prisma }));
vi.mock("../supabase.js", () => ({
  supabase: { auth: { getUser: mocks.getUser } },
  createUserClient: () => ({ storage: { from: () => ({ createSignedUrl: mocks.createSignedUrl }) } }),
  createRequestClient: vi.fn(),
}));
// Keep the real signature check; only the event handling is stubbed (covered in webhook.service.test.ts)
vi.mock("../services/webhook.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/webhook.service.js")>()),
  handleStripeEvent: mocks.handleStripeEvent,
}));

const { app } = await import("../app.js");
const { stripe } = await import("../stripe.js");

const { prisma } = mocks;

// Fake DB: only client A owns DOC_A and PURCHASE_A
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockImplementation(async (token: string) => {
    const user = { "token-a": CLIENT_A, "token-b": CLIENT_B }[token];
    return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error("invalid JWT") };
  });
  prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    role: "client",
    fullName: where.id === CLIENT_A.id ? "Client A" : "Client B",
  }));
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  prisma.$queryRaw.mockResolvedValue([]);
  prisma.entitlement.updateMany.mockResolvedValue({ count: 0 });
  prisma.entitlement.findFirst.mockImplementation(async ({ where }: { where: { userId: string; documentId: string } }) =>
    where.userId === CLIENT_A.id && where.documentId === DOC_A ? { document: { storagePath: "docs/a.pdf" } } : null,
  );
  prisma.purchase.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === PURCHASE_A
      ? { id: PURCHASE_A, userId: CLIENT_A.id, status: "paid", stripePaymentIntentId: "pi_test_1", refundRequestedAt: null }
      : null,
  );
  mocks.createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://storage.test/signed/a.pdf" }, error: null });
});

describe("POST /api/webhooks/stripe", () => {
  const payload = JSON.stringify({ id: "evt_http", object: "event", type: "checkout.session.completed", data: { object: {} } });
  const signed = () => stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });

  it("400 without a signature header", async () => {
    const res = await request(app).post("/api/webhooks/stripe").set("Content-Type", "application/json").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect(mocks.handleStripeEvent).not.toHaveBeenCalled();
  });

  it("400 with a bad signature, nothing handled", async () => {
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=1,v1=bad")
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_SIGNATURE");
    expect(mocks.handleStripeEvent).not.toHaveBeenCalled();
  });

  it("200 with a valid signature over the raw body", async () => {
    mocks.handleStripeEvent.mockResolvedValue("processed");
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signed())
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true, outcome: "processed" });
    expect(mocks.handleStripeEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "evt_http" }));
  });

  it("500 when handling fails, so Stripe retries later", async () => {
    mocks.handleStripeEvent.mockRejectedValue(new Error("DB down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post("/api/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signed())
      .send(payload);
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("Internal server error");
  });
});

describe("GET /api/documents/:id/download", () => {
  const download = (token?: string) => {
    const req = request(app).get(`/api/documents/${DOC_A}/download`);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
  };

  it("401 without a session", async () => {
    expect((await download()).status).toBe(401);
  });

  it("401 with an invalid token", async () => {
    expect((await download("forged")).status).toBe(401);
  });

  it("owner gets a short-lived signed URL", async () => {
    const res = await download("token-a");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: "https://storage.test/signed/a.pdf", expiresInSeconds: 60 });
  });

  it("another client gets 404 and no URL is created", async () => {
    const res = await download("token-b");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    // Ownership comes from the verified token, never from the request
    expect(prisma.entitlement.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: CLIENT_B.id }) }));
  });

  it("400 for a malformed document id", async () => {
    const res = await request(app).get("/api/documents/not-a-uuid/download").set("Authorization", "Bearer token-a");
    expect(res.status).toBe(400);
  });

  it("storage failure → 404 and the first-open stamp is undone (refund right kept)", async () => {
    prisma.entitlement.updateMany.mockResolvedValueOnce({ count: 1 });
    mocks.createSignedUrl.mockResolvedValue({ data: null, error: new Error("Object not found") });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await download("token-a")).status).toBe(404);
    expect(prisma.entitlement.updateMany).toHaveBeenLastCalledWith({
      where: { userId: CLIENT_A.id, documentId: DOC_A },
      data: { openedAt: null },
    });
  });
});

describe("POST /api/purchases/:id/refund", () => {
  it("another client's purchase → 404, nothing refunded", async () => {
    const res = await request(app).post(`/api/purchases/${PURCHASE_A}/refund`).set("Authorization", "Bearer token-b");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("401 without a session", async () => {
    expect((await request(app).post(`/api/purchases/${PURCHASE_A}/refund`)).status).toBe(401);
  });
});

it("/config.json exposes only browser-safe values", async () => {
  const res = await request(app).get("/config.json");
  expect(Object.keys(res.body).sort()).toEqual(["supabasePublishableKey", "supabaseUrl"]);
  expect(JSON.stringify(res.body)).not.toMatch(/sk_|whsec_|test-client-secret|test-refresh-token/);
});
