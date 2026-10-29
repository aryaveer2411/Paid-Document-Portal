import express, { Router } from "express";
import * as adminController from "../controllers/admin.controller.js";
import { requireAdmin } from "../middleware/requireAdmin.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);

adminRouter.get("/products", adminController.listProducts);
adminRouter.post("/products", adminController.createProduct);
adminRouter.put("/products/:id/price", adminController.updatePrice);
adminRouter.delete("/products/:id", adminController.deleteProduct);
adminRouter.post("/products/:id/stripe-sync", adminController.retryStripeSync);
// Raw PDF body, max 10 MB; parsed only after the admin check above has passed
adminRouter.post("/uploads", express.raw({ type: "application/pdf", limit: "10mb" }), adminController.uploadFile);
adminRouter.get("/purchases", adminController.listPurchases);
adminRouter.post("/purchases/crm-sync", adminController.retryCrmSync);
