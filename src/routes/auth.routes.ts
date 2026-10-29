import { Router } from "express";
import * as authController from "../controllers/auth.controller.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const authRouter = Router();

authRouter.post("/signup", authController.signup);
authRouter.post("/login", authController.login);
authRouter.post("/logout", authController.logout);
authRouter.get("/me", requireUser, authController.me);
