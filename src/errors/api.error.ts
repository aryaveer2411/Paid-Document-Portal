import { ErrorResponse, type ErrorCode, type ErrorDetail } from "../responses/error.response.js";

// Thrown anywhere (service, middleware, validation); the app error handler sends its toResponse()
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
  }

  static validation(details: ErrorDetail[]) {
    return new ApiError(400, "VALIDATION_FAILED", "Request validation failed", details);
  }
  static invalidSignature(message = "Invalid webhook signature") {
    return new ApiError(400, "INVALID_SIGNATURE", message);
  }
  static unauthorized(message = "Not signed in") {
    return new ApiError(401, "UNAUTHORIZED", message);
  }
  static forbidden(message = "Not allowed") {
    return new ApiError(403, "FORBIDDEN", message);
  }
  static notFound(message = "Not found") {
    return new ApiError(404, "NOT_FOUND", message);
  }
  static conflict(message: string) {
    return new ApiError(409, "CONFLICT", message);
  }
  static rateLimited(message = "Too many requests, try again later") {
    return new ApiError(429, "RATE_LIMITED", message);
  }
  static upstream(message: string) {
    return new ApiError(502, "UPSTREAM_UNAVAILABLE", message);
  }

  toResponse() {
    return new ErrorResponse(this.status, this.code, this.message, this.details);
  }
}
