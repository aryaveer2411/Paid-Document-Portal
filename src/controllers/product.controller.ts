import type { Request, Response } from "express";
import { SuccessResponse } from "../responses/success.response.js";
import * as productService from "../services/product.service.js";

export async function listProducts(req: Request, res: Response) {
  const products = await productService.listCatalog(req.user?.id ?? null);
  SuccessResponse.ok({ products }, "Products fetched").send(res);
}
