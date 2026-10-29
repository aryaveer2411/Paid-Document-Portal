import { Router } from "express";
import * as purchaseController from "../controllers/purchase.controller.js";
import { refundLimiter } from "../middleware/rateLimit.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const purchaseRouter = Router();
purchaseRouter.use(requireUser);

purchaseRouter.post("/:id/refund", refundLimiter, purchaseController.requestRefund);
