import { Router } from "express";
import * as productController from "../controllers/product.controller.js";
import { optionalUser } from "../middleware/requireUser.middleware.js";

// Catalog is public; "owned" is only filled in for a signed-in user
export const productRouter = Router();
productRouter.use(optionalUser);

productRouter.get("/", productController.listProducts);
