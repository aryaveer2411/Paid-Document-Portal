import type { Request, Response } from "express";
import { ApiError } from "../errors/api.error.js";
import { bearerToken } from "../middleware/requireUser.middleware.js";
import { SuccessResponse } from "../responses/success.response.js";
import { loginSchema } from "../schema/auth/request/auth.login.js";
import { signupSchema } from "../schema/auth/request/auth.signup.js";
import { meResponseSchema } from "../schema/auth/response/auth.me.js";
import * as authService from "../services/auth.service.js";
import { parse } from "../validate.js";

// Controller: parse input → call service → send SuccessResponse. Thrown ApiErrors reach the app error handler.

export async function signup(req: Request, res: Response) {
  const body = parse(signupSchema, req.body);
  const result = await authService.signup(body);
  SuccessResponse.created(result, "Account created").send(res);
}

export async function login(req: Request, res: Response) {
  const body = parse(loginSchema, req.body);
  const session = await authService.login(body);
  SuccessResponse.ok(session, "Signed in").send(res);
}

// Reads the token itself instead of requireUser: an expired token must still be able to log out
export async function logout(req: Request, res: Response) {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized("Missing bearer token");
  await authService.logout(token);
  SuccessResponse.ok(null, "Signed out").send(res);
}

// Page uses role to decide which view to show; server re-checks role on every admin call
export function me(req: Request, res: Response) {
  SuccessResponse.ok(meResponseSchema.parse({ user: req.user }), "Current user").send(res);
}
