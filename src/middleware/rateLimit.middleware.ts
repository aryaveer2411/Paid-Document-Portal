import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { ApiError } from "../errors/api.error.js";

const MINUTE = 60 * 1000;

// Counters live in this process's memory: reset on restart, not shared between servers
// (several instances would need a shared store such as Redis).
// Key = signed-in user id when requireUser ran first, else the client IP. ipKeyGenerator groups an
// IPv6 address by its /56 block, since one client usually owns the whole block.
function limiter(windowMs: number, limit: number, message: string) {
  return rateLimit({
    windowMs,
    limit,
    // RateLimit-* headers tell well-behaved clients when to try again
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? "unknown"),
    // Through our error handler, so the body has the same { success: false, error } shape as every error
    handler: (_req, _res, next) => next(ApiError.rateLimited(message)),
  });
}

// Whole API per IP: a coarse cap against floods. Stripe webhooks are mounted before it and never limited.
export const apiLimiter = limiter(MINUTE, 300, "Too many requests, slow down");
// Login/signup per IP: slows password guessing and protects Supabase's own auth quota
export const authLimiter = limiter(15 * MINUTE, 20, "Too many sign-in attempts, try again in 15 minutes");
// Each checkout creates a Stripe session and a Zoho Deal: per user, so spam can't burn those quotas
export const checkoutLimiter = limiter(10 * MINUTE, 10, "Too many checkout attempts, try again in a few minutes");
// Refunds call Stripe; a handful per user is plenty
export const refundLimiter = limiter(10 * MINUTE, 5, "Too many refund attempts, try again in a few minutes");
// Each download mints a signed Storage URL
export const downloadLimiter = limiter(MINUTE, 30, "Too many downloads, try again in a minute");
