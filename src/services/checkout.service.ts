import Stripe from "stripe";
import { env } from "../config/env.js";
import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import type { CreateCheckoutInput } from "../schema/checkout/request/checkout.create.js";
import { checkoutResponseSchema, type CheckoutResponse } from "../schema/checkout/response/checkout.create.js";
import { purchasableWhere } from "../schema/product/response/product.catalog.js";
import { stripe } from "../stripe.js";
import { openDealForCheckout } from "./crmSync.service.js";

// Unpaid sessions expire so stale tabs can't pay at an old price long after a change
const SESSION_TTL_SECONDS = 30 * 60;

export async function createCheckout(
  input: CreateCheckoutInput,
  user: { id: string; email: string | null },
): Promise<CheckoutResponse> {
  const doc = await prisma.document.findFirst({
    where: { id: input.documentId, ...purchasableWhere },
    include: { prices: { where: { active: true }, take: 1 } },
  });
  const price = doc?.prices[0];
  if (!doc || !price?.stripePriceId) throw ApiError.notFound("Product not available for purchase");

  const owned = await prisma.entitlement.findFirst({
    where: { userId: user.id, documentId: doc.id, revokedAt: null },
    select: { id: true },
  });
  if (owned) throw ApiError.conflict("You already own this document");

  // Our record first: its id is the stable link Stripe will echo back in the webhook.
  // Amount copied from the price row, so the purchase keeps what was actually charged.
  const purchase = await prisma.purchase.create({
    data: { userId: user.id, documentId: doc.id, priceId: price.id, amountCents: price.amountCents, currency: price.currency },
  });

  // Same ids on the session and its PaymentIntent, so either object can be traced back to us
  const metadata = { purchase_id: purchase.id, user_id: user.id, document_id: doc.id };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [{ price: price.stripePriceId, quantity: 1 }],
        // Buyer pays in the price's own currency (no local-currency conversion), matching our DB and Zoho
        adaptive_pricing: { enabled: false },
        client_reference_id: user.id,
        customer_email: user.email ?? undefined,
        metadata,
        payment_intent_data: { metadata },
        expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        // Redirect is only for the user's eyes; access is granted by the signed webhook, never by this URL
        success_url: `${env.APP_URL}/?checkout=success`,
        cancel_url: `${env.APP_URL}/?checkout=cancelled`,
      },
      // One session per purchase row, even if this call is retried
      { idempotencyKey: `checkout-${purchase.id}` },
    );
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeError)) throw err;
    await prisma.purchase.update({ where: { id: purchase.id }, data: { status: "failed" } });
    throw ApiError.upstream("Payment provider unavailable, try again");
  }

  if (!session.url) throw ApiError.upstream("Payment provider returned no checkout page");
  await prisma.purchase.update({ where: { id: purchase.id }, data: { stripeCheckoutSessionId: session.id } });
  // Open the matching Zoho Deal now; failures are logged only, checkout never waits on the CRM being up
  await openDealForCheckout(purchase.id);

  return checkoutResponseSchema.parse({ purchaseId: purchase.id, checkoutUrl: session.url });
}
