import type { Request, Response } from "express";
import { SuccessResponse } from "../responses/success.response.js";
import { purchaseIdSchema } from "../schema/purchase/request/purchase.refund.js";
import * as refundService from "../services/refund.service.js";
import { parse } from "../validate.js";

export async function requestRefund(req: Request, res: Response) {
  const { id } = parse(purchaseIdSchema, req.params);
  const result = await refundService.requestRefund(req.user!.id, id);
  const message = result.status === "refunded" ? "Refund completed" : "Refund requested, Stripe confirmation pending";
  SuccessResponse.ok(result, message).send(res);
}
