import { z } from "zod";
import { HttpError } from "./httpError.js";

// Parse request input; failures become a 400 with zod's readable message
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
  return result.data;
}
