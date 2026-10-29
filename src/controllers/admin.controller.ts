import type { Request, Response } from "express";
import { ApiError } from "../errors/api.error.js";
import { bearerToken } from "../middleware/requireUser.middleware.js";
import { SuccessResponse } from "../responses/success.response.js";
import { createProductSchema } from "../schema/admin/request/admin.createProduct.js";
import { productIdSchema } from "../schema/admin/request/admin.productId.js";
import { updatePriceSchema } from "../schema/admin/request/admin.updatePrice.js";
import * as adminService from "../services/admin.service.js";
import * as uploadService from "../services/upload.service.js";
import { parse } from "../validate.js";

// Controller: parse input → call service → send SuccessResponse. Thrown ApiErrors reach the app error handler.
// req.user is set by requireUser, which the router mounts before every admin route.

export async function listProducts(_req: Request, res: Response) {
  const products = await adminService.listProducts();
  SuccessResponse.ok({ products }, "Products fetched").send(res);
}

export async function createProduct(req: Request, res: Response) {
  const body = parse(createProductSchema, req.body);
  const product = await adminService.createProduct(body, req.user!.id);
  SuccessResponse.created({ product }, "Product created").send(res);
}

export async function updatePrice(req: Request, res: Response) {
  const { id } = parse(productIdSchema, req.params);
  const body = parse(updatePriceSchema, req.body);
  const product = await adminService.updatePrice(id, body, req.user!.id);
  SuccessResponse.ok({ product }, "Price updated").send(res);
}

export async function retryStripeSync(req: Request, res: Response) {
  const { id } = parse(productIdSchema, req.params);
  const product = await adminService.retryStripeSync(id);
  SuccessResponse.ok({ product }, `Stripe sync ${product.stripeSync.status}`).send(res);
}

// Body is the raw PDF (Content-Type: application/pdf), parsed by express.raw in the router
export async function uploadFile(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body)) {
    throw new ApiError(400, "VALIDATION_FAILED", "Send the file as the request body with Content-Type: application/pdf");
  }
  const result = await uploadService.uploadDocumentFile(bearerToken(req)!, req.body);
  SuccessResponse.created(result, "File uploaded").send(res);
}

export async function listPurchases(_req: Request, res: Response) {
  const purchases = await adminService.listPurchases();
  SuccessResponse.ok({ purchases }, "Purchases fetched").send(res);
}

export async function retryCrmSync(_req: Request, res: Response) {
  const result = await adminService.retryCrmSync();
  SuccessResponse.ok(result, `Zoho sync: ${result.synced} synced, ${result.stillPending} still pending`).send(res);
}

export async function deleteProduct(req: Request, res: Response) {
  const { id } = parse(productIdSchema, req.params);
  const product = await adminService.archiveProduct(id, req.user!.id);
  SuccessResponse.ok({ product }, "Product deleted").send(res);
}
