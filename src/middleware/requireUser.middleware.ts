import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db.js";
import type { UserRole } from "../generated/prisma/client.js";
import { supabase } from "../supabase.js";

export type AuthUser = { id: string; email: string | null; role: UserRole };

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
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  // Role comes from our DB (set by SQL only), never from the token or request body
  const profile = await prisma.user.findUnique({ where: { id: data.user.id }, select: { role: true } });
  if (!profile) {
    res.status(403).json({ error: "No profile for this account" });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email ?? null, role: profile.role };
  next();
}
