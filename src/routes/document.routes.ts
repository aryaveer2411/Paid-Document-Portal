import { Router } from "express";
import * as documentController from "../controllers/document.controller.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const documentRouter = Router();
documentRouter.use(requireUser);

documentRouter.get("/:id/download", documentController.getDownloadLink);
