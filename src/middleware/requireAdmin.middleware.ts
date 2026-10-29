import type { NextFunction, Request, Response } from "express";

// Mount after requireUser; 403 = signed in but not allowed
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  next();
}
