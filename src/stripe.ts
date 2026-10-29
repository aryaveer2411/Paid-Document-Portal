import Stripe from "stripe";
import { env } from "./config/env.js";

// Retries reuse the same idempotency key, so a retried create never makes a duplicate.
// 10s timeout: admin requests wait on Stripe; the SDK default (80s) would hang the page.
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 10_000 });
