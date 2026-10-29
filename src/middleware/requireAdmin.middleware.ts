import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../errors/api.error.js";

// Mount after requireUser; 403 = signed in but not allowed
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") throw ApiError.forbidden("Admin only");
  next();
}
