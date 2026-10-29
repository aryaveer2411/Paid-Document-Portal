import type { Response } from "express";

// Machine-readable code: the browser branches on this, never on message text
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "INVALID_JSON"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type ErrorDetail = { path: string; message: string };

// Every 4xx/5xx body: { success: false, error: { code, message, details? } }
export class ErrorResponse {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly message: string,
    readonly details?: ErrorDetail[],
  ) {}

  send(res: Response) {
    res.status(this.status).json({
      success: false,
      error: { code: this.code, message: this.message, ...(this.details && { details: this.details }) },
    });
  }
}
