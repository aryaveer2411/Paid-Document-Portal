import { Router } from "express";
import * as checkoutController from "../controllers/checkout.controller.js";
import { checkoutLimiter } from "../middleware/rateLimit.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const checkoutRouter = Router();
// requireUser first, so the limiter counts per user instead of per IP
checkoutRouter.use(requireUser);

checkoutRouter.post("/", checkoutLimiter, checkoutController.createCheckout);
