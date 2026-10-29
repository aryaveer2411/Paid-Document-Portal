import { Router } from "express";
import * as productController from "../controllers/product.controller.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const productRouter = Router();
productRouter.use(requireUser);

productRouter.get("/", productController.listProducts);
