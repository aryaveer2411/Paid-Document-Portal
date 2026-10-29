// Thrown from route handlers; the app error handler turns it into { error } with this status
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
