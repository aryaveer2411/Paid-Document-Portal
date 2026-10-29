import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { env } from "./config/env.js";
import { ApiError } from "./errors/api.error.js";
import { apiLimiter } from "./middleware/rateLimit.middleware.js";
import { ErrorResponse } from "./responses/error.response.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { checkoutRouter } from "./routes/checkout.routes.js";
import { documentRouter } from "./routes/document.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { purchaseRouter } from "./routes/purchase.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";

export const app = express();

// Number of proxies in front of us (0 locally). Lets req.ip be the real client from X-Forwarded-For;
// trusting more hops than exist would let clients fake their IP and dodge rate limits.
app.set("trust proxy", env.TRUST_PROXY);

// Before express.json(): the webhook needs the untouched raw body to verify Stripe's signature.
// Before the rate limiter too: Stripe sends bursts, and a 429 would only make it resend later.
app.use("/api/webhooks", webhookRouter);

app.use("/api", apiLimiter);

app.use(express.json());

// React build output (npm run web:build); ../web/dist resolves the same from src/ (tsx) and dist/ (node)
const webDist = fileURLToPath(new URL("../web/dist", import.meta.url));
app.use(express.static(webDist));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Browser-safe values only: the page needs them to start supabase-js. Never add secret keys here.
app.get("/config.json", (_req: Request, res: Response) => {
  res.json({ supabaseUrl: env.SUPABASE_URL, supabasePublishableKey: env.SUPABASE_PUBLISHABLE_KEY });
});

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/products", productRouter);
app.use("/api/checkout", checkoutRouter);
app.use("/api/documents", documentRouter);
app.use("/api/purchases", purchaseRouter);

// SPA fallback: client-side routes (/orders, /login…) get index.html; React Router picks the page
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET" || req.path.startsWith("/api/") || !req.accepts("html")) return next();
  res.sendFile("index.html", { root: webDist }, (err) => err && next());
});

// Unknown routes
app.use((_req: Request, res: Response) => {
  new ErrorResponse(404, "NOT_FOUND", "Route not found").send(res);
});

// Central error handler; Express 5 forwards async throws here. Only place error bodies are built.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    err.toResponse().send(res);
    return;
  }
  // express.json() sets type on malformed bodies
  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.parse.failed") {
    new ErrorResponse(400, "INVALID_JSON", "Malformed JSON body").send(res);
    return;
  }
  // express.json()/raw() set this when a body is over its size limit
  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.too.large") {
    new ErrorResponse(413, "PAYLOAD_TOO_LARGE", "Request body too large (file uploads: max 10 MB)").send(res);
    return;
  }
  // Unknown error: full detail to server log, generic message to client
  console.error(err);
  new ErrorResponse(500, "INTERNAL_ERROR", "Internal server error").send(res);
});
