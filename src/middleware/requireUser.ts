import type { NextFunction, Request, Response } from "express";
import { supabase } from "../supabase.js";

export type AuthUser = { id: string; email: string | null };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Browser sends `Authorization: Bearer <supabase access_token>`.
// getUser() asks Supabase Auth to validate it, so expired or signed-out tokens are rejected.
export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email ?? null };
  next();
}
