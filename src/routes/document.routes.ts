import { Router } from "express";
import * as documentController from "../controllers/document.controller.js";
import { downloadLimiter } from "../middleware/rateLimit.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const documentRouter = Router();
documentRouter.use(requireUser);

documentRouter.get("/:id/download", downloadLimiter, documentController.getDownloadLink);
