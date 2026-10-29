import { Router } from "express";
import * as adminController from "../controllers/admin.controller.js";
import { requireAdmin } from "../middleware/requireAdmin.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const adminRouter = Router();
adminRouter.use(requireUser, requireAdmin);

adminRouter.get("/products", adminController.listProducts);
adminRouter.post("/products", adminController.createProduct);
adminRouter.put("/products/:id/price", adminController.updatePrice);
adminRouter.delete("/products/:id", adminController.deleteProduct);
