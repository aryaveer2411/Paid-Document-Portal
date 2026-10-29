import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakePurchase } from "./fakeDb.js";

const db = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof createFakeDb> }));

vi.mock("../db.js", async () => {
  const { createFakeDb } = await import("./fakeDb.js");
  db.fake = createFakeDb();
  return { prisma: db.fake.prisma };
});
// Zoho and the auto-refund run after commit; here we only check whether they were triggered
vi.mock("../services/crmSync.service.js", () => ({ syncPurchase: vi.fn() }));
vi.mock("../services/refund.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/refund.service.js")>()),
  issueRefund: vi.fn(),
}));

const { handleStripeEvent, verifyStripeEvent } = await import("../services/webhook.service.js");
const { syncPurchase } = await import("../services/crmSync.service.js");
const { issueRefund } = await import("../services/refund.service.js");
const { stripe } = await import("../stripe.js");
const { ApiError } = await import("../errors/api.error.js");

function sessionFor(purchase: FakePurchase, overrides: Partial<Stripe.Checkout.Session> = {}) {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    payment_status: "paid",
    client_reference_id: purchase.userId,
    amount_total: purchase.amountCents,
    currency: purchase.currency,
    payment_intent: "pi_test_1",
    metadata: { purchase_id: purchase.id },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function event(id: string, type: string, object: unknown) {
  return { id, type, data: { object } } as Stripe.Event;
}

const completed = (id: string, session: Stripe.Checkout.Session) => event(id, "checkout.session.completed", session);

beforeEach(() => {
  db.fake.reset();
  vi.mocked(syncPurchase).mockReset().mockResolvedValue("synced");
  vi.mocked(issueRefund).mockReset().mockResolvedValue("refunded");
});

describe("verifyStripeEvent", () => {
  const payload = JSON.stringify({ id: "evt_sig", object: "event", type: "checkout.session.completed", data: { object: {} } });

  it("accepts a body signed with the webhook secret", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    expect(verifyStripeEvent(Buffer.from(payload), header).id).toBe("evt_sig");
  });

  it("rejects a wrong signature", () => {
    expect(() => verifyStripeEvent(Buffer.from(payload), "t=1,v1=bad")).toThrow(ApiError);
  });

  it("rejects a body changed after signing", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    const tampered = payload.replace("evt_sig", "evt_other");
    expect(() => verifyStripeEvent(Buffer.from(tampered), header)).toThrow(ApiError);
  });

  it("rejects a body signed with another secret", () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_else" });
    expect(() => verifyStripeEvent(Buffer.from(payload), header)).toThrow(ApiError);
  });
});

describe("checkout.session.completed", () => {
  it("marks paid, grants one entitlement, queues CRM and triggers one Zoho sync", async () => {
    const purchase = db.fake.addPurchase();

    expect(await handleStripeEvent(completed("evt_1", sessionFor(purchase)))).toBe("processed");

    expect(purchase.status).toBe("paid");
    expect(purchase.stripeCheckoutSessionId).toBe("cs_test_1");
    expect(purchase.stripePaymentIntentId).toBe("pi_test_1");
    expect(purchase.crmSyncStatus).toBe("pending");
    expect(db.fake.entitlements).toHaveLength(1);
    expect(db.fake.entitlements[0]).toMatchObject({ userId: purchase.userId, documentId: purchase.documentId, purchaseId: purchase.id });
    expect(syncPurchase).toHaveBeenCalledExactlyOnceWith(purchase.id);
  });

  it("repeated delivery of the same event: no second entitlement, no second Zoho update", async () => {
    const purchase = db.fake.addPurchase();
    const evt = completed("evt_1", sessionFor(purchase));

    await handleStripeEvent(evt);
    expect(await handleStripeEvent(evt)).toBe("duplicate");

    expect(db.fake.entitlements).toHaveLength(1);
    expect(syncPurchase).toHaveBeenCalledTimes(1);
  });

  it("a different event for an already-paid purchase is a duplicate", async () => {
    const purchase = db.fake.addPurchase();
    await handleStripeEvent(completed("evt_1", sessionFor(purchase)));

    const again = event("evt_2", "checkout.session.async_payment_succeeded", sessionFor(purchase));
    expect(await handleStripeEvent(again)).toBe("duplicate");

    expect(db.fake.entitlements).toHaveLength(1);
    expect(syncPurchase).toHaveBeenCalledTimes(1);
  });

  it("ignores an unpaid session (delayed payment method)", async () => {
    const purchase = db.fake.addPurchase();
    const session = sessionFor(purchase, { payment_status: "unpaid" });

    expect(await handleStripeEvent(completed("evt_1", session))).toBe("ignored");

    expect(purchase.status).toBe("pending");
    expect(db.fake.entitlements).toHaveLength(0);
    expect(db.fake.events.size).toBe(0);
  });

  it("grants access later on async_payment_succeeded", async () => {
    const purchase = db.fake.addPurchase();
    await handleStripeEvent(completed("evt_1", sessionFor(purchase, { payment_status: "unpaid" })));

    const succeeded = event("evt_2", "checkout.session.async_payment_succeeded", sessionFor(purchase));
    expect(await handleStripeEvent(succeeded)).toBe("processed");
    expect(db.fake.entitlements).toHaveLength(1);
  });

  it.each([
    ["missing", {}],
    ["not a uuid", { purchase_id: "abc" }],
  ])("ignores a session whose purchase_id is %s", async (_label, metadata) => {
    const purchase = db.fake.addPurchase();
    const session = sessionFor(purchase, { metadata });

    expect(await handleStripeEvent(completed("evt_1", session))).toBe("ignored");
    expect(db.fake.entitlements).toHaveLength(0);
  });

  it("ignores a purchase id that does not exist", async () => {
    const purchase = db.fake.addPurchase();
    const session = sessionFor(purchase, { metadata: { purchase_id: crypto.randomUUID() } });

    expect(await handleStripeEvent(completed("evt_1", session))).toBe("ignored");
    expect(db.fake.entitlements).toHaveLength(0);
  });

  it.each<[string, Partial<Stripe.Checkout.Session>]>([
    ["another user", { client_reference_id: crypto.randomUUID() }],
    ["a different amount", { amount_total: 1 }],
    ["a different currency", { currency: "usd" }],
  ])("grants nothing when the session belongs to %s", async (_label, overrides) => {
    const purchase = db.fake.addPurchase();

    expect(await handleStripeEvent(completed("evt_1", sessionFor(purchase, overrides)))).toBe("ignored");

    expect(purchase.status).toBe("pending");
    expect(db.fake.entitlements).toHaveLength(0);
    expect(syncPurchase).not.toHaveBeenCalled();
  });

  it("grants nothing when the session id differs from the one stored at checkout", async () => {
    const purchase = db.fake.addPurchase({ stripeCheckoutSessionId: "cs_test_original" });

    expect(await handleStripeEvent(completed("evt_1", sessionFor(purchase)))).toBe("ignored");
    expect(db.fake.entitlements).toHaveLength(0);
  });

  it("never grants access to a purchase already refunded (refund event arrived first)", async () => {
    const purchase = db.fake.addPurchase({ status: "refunded" });

    expect(await handleStripeEvent(completed("evt_1", sessionFor(purchase)))).toBe("ignored");
    expect(db.fake.entitlements).toHaveLength(0);
  });

  it("paid twice for the same document: no second entitlement, auto-refund, no Zoho update", async () => {
    const first = db.fake.addPurchase({ status: "paid" });
    db.fake.addEntitlement({ userId: first.userId, documentId: first.documentId, purchaseId: first.id });
    const second = db.fake.addPurchase({ userId: first.userId, documentId: first.documentId });

    const session = sessionFor(second, { id: "cs_test_2", payment_intent: "pi_test_2" });
    expect(await handleStripeEvent(completed("evt_2", session))).toBe("processed");

    expect(second.status).toBe("paid");
    expect(second.refundRequestedAt).toBeInstanceOf(Date);
    expect(second.crmSyncStatus).toBeNull();
    expect(db.fake.entitlements).toHaveLength(1);
    expect(issueRefund).toHaveBeenCalledExactlyOnceWith(second.id);
    expect(syncPurchase).not.toHaveBeenCalled();
  });

  it("buying again after a refund re-grants the revoked entitlement", async () => {
    const old = db.fake.addPurchase({ status: "refunded" });
    const revoked = db.fake.addEntitlement({
      userId: old.userId,
      documentId: old.documentId,
      purchaseId: old.id,
      revokedAt: new Date(),
      openedAt: new Date(),
    });
    const fresh = db.fake.addPurchase({ userId: old.userId, documentId: old.documentId });

    expect(await handleStripeEvent(completed("evt_3", sessionFor(fresh)))).toBe("processed");

    expect(db.fake.entitlements).toHaveLength(1);
    expect(revoked).toMatchObject({ revokedAt: null, openedAt: null, purchaseId: fresh.id });
  });

  it("access stays granted when the Zoho sync fails", async () => {
    vi.mocked(syncPurchase).mockRejectedValue(new Error("Zoho down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const purchase = db.fake.addPurchase();

    expect(await handleStripeEvent(completed("evt_1", sessionFor(purchase)))).toBe("processed");
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());

    expect(purchase.status).toBe("paid");
    expect(purchase.crmSyncStatus).toBe("pending");
    expect(db.fake.entitlements[0]?.revokedAt).toBeNull();
  });
});

describe("failed and expired sessions", () => {
  it.each(["checkout.session.expired", "checkout.session.async_payment_failed"])("%s marks a pending purchase failed", async (type) => {
    const purchase = db.fake.addPurchase();

    expect(await handleStripeEvent(event("evt_f", type, sessionFor(purchase)))).toBe("processed");
    expect(purchase.status).toBe("failed");
    expect(db.fake.entitlements).toHaveLength(0);
  });

  it("repeated delivery is caught by the event id alone", async () => {
    const purchase = db.fake.addPurchase();
    const expired = event("evt_f", "checkout.session.expired", sessionFor(purchase));

    await handleStripeEvent(expired);
    expect(await handleStripeEvent(expired)).toBe("duplicate");
    expect(db.fake.events.size).toBe(1);
  });

  it("a late expiry never downgrades a paid purchase", async () => {
    const purchase = db.fake.addPurchase();
    await handleStripeEvent(completed("evt_1", sessionFor(purchase)));

    await handleStripeEvent(event("evt_2", "checkout.session.expired", sessionFor(purchase)));
    expect(purchase.status).toBe("paid");
  });
});

describe("charge.refunded", () => {
  function charge(paymentIntent: string, refunded = true) {
    return { id: "ch_test_1", object: "charge", refunded, payment_intent: paymentIntent } as Stripe.Charge;
  }

  it("full refund revokes access and queues the Deal update", async () => {
    const purchase = db.fake.addPurchase();
    await handleStripeEvent(completed("evt_1", sessionFor(purchase)));
    vi.mocked(syncPurchase).mockClear();

    expect(await handleStripeEvent(event("evt_r", "charge.refunded", charge("pi_test_1")))).toBe("processed");

    expect(purchase.status).toBe("refunded");
    expect(purchase.crmSyncStatus).toBe("pending");
    expect(db.fake.entitlements[0]?.revokedAt).toBeInstanceOf(Date);
    expect(syncPurchase).toHaveBeenCalledExactlyOnceWith(purchase.id);
  });

  it("repeated refund event is a duplicate", async () => {
    const purchase = db.fake.addPurchase();
    await handleStripeEvent(completed("evt_1", sessionFor(purchase)));
    const refund = event("evt_r", "charge.refunded", charge("pi_test_1"));

    await handleStripeEvent(refund);
    expect(await handleStripeEvent(refund)).toBe("duplicate");
  });

  it("partial refund keeps access", async () => {
    const purchase = db.fake.addPurchase();
    await handleStripeEvent(completed("evt_1", sessionFor(purchase)));

    expect(await handleStripeEvent(event("evt_r", "charge.refunded", charge("pi_test_1", false)))).toBe("ignored");
    expect(purchase.status).toBe("paid");
    expect(db.fake.entitlements[0]?.revokedAt).toBeNull();
  });

  it("refund before the payment event finds the purchase through PaymentIntent metadata", async () => {
    const purchase = db.fake.addPurchase();
    vi.spyOn(stripe.paymentIntents, "retrieve").mockResolvedValue({
      metadata: { purchase_id: purchase.id },
    } as unknown as Stripe.Response<Stripe.PaymentIntent>);

    expect(await handleStripeEvent(event("evt_r", "charge.refunded", charge("pi_unknown")))).toBe("processed");
    expect(purchase.status).toBe("refunded");

    // The late payment event must not grant access now
    expect(await handleStripeEvent(completed("evt_1", sessionFor(purchase, { payment_intent: "pi_unknown" })))).toBe("ignored");
    expect(db.fake.entitlements).toHaveLength(0);
  });
});

it("ignores event types it does not handle", async () => {
  expect(await handleStripeEvent(event("evt_x", "customer.created", {}))).toBe("ignored");
});
