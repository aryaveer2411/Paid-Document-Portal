import type { z } from "zod";
import { ApiError } from "./errors/api.error.js";

// Parse request input; failures become 400 VALIDATION_FAILED with one detail per bad field
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw ApiError.validation(
      result.error.issues.map((issue) => ({ path: issue.path.join(".") || "(body)", message: issue.message })),
    );
  }
  return result.data;
}
