import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { env } from "./config/env.js";
import { ApiError } from "./errors/api.error.js";
import { ErrorResponse } from "./responses/error.response.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { checkoutRouter } from "./routes/checkout.routes.js";
import { documentRouter } from "./routes/document.routes.js";
import { productRouter } from "./routes/product.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";

export const app = express();

// Before express.json(): the webhook needs the untouched raw body to verify Stripe's signature
app.use("/api/webhooks", webhookRouter);

app.use(express.json());

// ../public resolves to <project>/public from both src/ (tsx) and dist/ (node)
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

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
  // Unknown error: full detail to server log, generic message to client
  console.error(err);
  new ErrorResponse(500, "INTERNAL_ERROR", "Internal server error").send(res);
});
