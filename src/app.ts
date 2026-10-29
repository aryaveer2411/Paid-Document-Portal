import express, { type NextFunction, type Request, type Response } from "express";
import { requireUser } from "./middleware/requireUser.js";

export const app = express();

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Who am I? Quick check that a browser session token is accepted
app.get("/me", requireUser, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// Unknown routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler; Express 5 forwards async throws here
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
