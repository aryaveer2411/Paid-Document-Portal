import express, { type NextFunction, type Request, type Response } from "express";

export const app = express();

app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
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
