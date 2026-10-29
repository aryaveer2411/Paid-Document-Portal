import express, { Router } from "express";
import * as webhookController from "../controllers/webhook.controller.js";

export const webhookRouter = Router();

// Raw bytes, not parsed JSON: the signature is computed over the exact body Stripe sent
webhookRouter.post("/stripe", express.raw({ type: "application/json", limit: "1mb" }), webhookController.handleStripe);
