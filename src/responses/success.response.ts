import type { Response } from "express";

// Every 2xx body: { success: true, message, data }
export class SuccessResponse<T> {
  constructor(
    readonly data: T,
    readonly message: string,
    readonly status: 200 | 201 = 200,
  ) {}

  static ok<T>(data: T, message = "OK") {
    return new SuccessResponse(data, message, 200);
  }

  static created<T>(data: T, message = "Created") {
    return new SuccessResponse(data, message, 201);
  }

  send(res: Response) {
    res.status(this.status).json({ success: true, message: this.message, data: this.data });
  }
}
