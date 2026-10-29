import type { Request, Response } from "express";
import { bearerToken } from "../middleware/requireUser.middleware.js";
import { SuccessResponse } from "../responses/success.response.js";
import { documentIdSchema } from "../schema/document/request/document.download.js";
import * as documentService from "../services/document.service.js";
import { parse } from "../validate.js";

export async function getDownloadLink(req: Request, res: Response) {
  const { id } = parse(documentIdSchema, req.params);
  // requireUser already verified this token; it is reused so Storage sees the same user
  const link = await documentService.getDownloadLink(req.user!.id, bearerToken(req)!, id);
  SuccessResponse.ok(link, "Download link created").send(res);
}
