import type { Request, Response } from "express";
import { SuccessResponse } from "../responses/success.response.js";
import { createCheckoutSchema } from "../schema/checkout/request/checkout.create.js";
import * as checkoutService from "../services/checkout.service.js";
import { parse } from "../validate.js";

export async function createCheckout(req: Request, res: Response) {
  const body = parse(createCheckoutSchema, req.body);
  const result = await checkoutService.createCheckout(body, req.user!);
  SuccessResponse.created(result, "Checkout session created").send(res);
}
