import type { Request, Response } from "express";
import { ApiError } from "../errors/api.error.js";
import { SuccessResponse } from "../responses/success.response.js";
import * as webhookService from "../services/webhook.service.js";

// 2xx tells Stripe "done, don't resend". A thrown error (e.g. DB down) gives 500, and Stripe retries later.
export async function handleStripe(req: Request, res: Response) {
  const signature = req.header("stripe-signature");
  if (!signature || !Buffer.isBuffer(req.body)) throw ApiError.invalidSignature("Missing signature or body");

  const event = webhookService.verifyStripeEvent(req.body, signature);
  const outcome = await webhookService.handleStripeEvent(event);
  SuccessResponse.ok({ received: true, outcome }, `Event ${event.type} ${outcome}`).send(res);
}
