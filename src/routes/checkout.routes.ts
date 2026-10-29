import { Router } from "express";
import * as checkoutController from "../controllers/checkout.controller.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const checkoutRouter = Router();
checkoutRouter.use(requireUser);

checkoutRouter.post("/", checkoutController.createCheckout);
