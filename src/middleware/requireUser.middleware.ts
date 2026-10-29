import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import type { UserRole } from "../generated/prisma/client.js";
import { supabase } from "../supabase.js";

export type AuthUser = { id: string; email: string | null; fullName: string; role: UserRole };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// `Authorization: Bearer <token>` → token, else null
export function bearerToken(req: Request): string | null {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];
  return scheme === "Bearer" && token ? token : null;
}

// Browser sends `Authorization: Bearer <supabase access_token>`.
// getUser() asks Supabase Auth to validate it, so expired or signed-out tokens are rejected.
// Express 5 forwards throws (sync or async) from middleware to the app error handler
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized("Missing bearer token");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw ApiError.unauthorized("Invalid or expired session");

  // Role comes from our DB (set by SQL only), never from the token or request body
  const profile = await prisma.user.findUnique({ where: { id: data.user.id }, select: { role: true, fullName: true } });
  if (!profile) throw ApiError.forbidden("No profile for this account");

  req.user = { id: data.user.id, email: data.user.email ?? null, fullName: profile.fullName, role: profile.role };
  next();
}
