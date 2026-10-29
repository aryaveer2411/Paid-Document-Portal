import { Router } from "express";
import * as authController from "../controllers/auth.controller.js";
import { authLimiter } from "../middleware/rateLimit.middleware.js";
import { requireUser } from "../middleware/requireUser.middleware.js";

export const authRouter = Router();

authRouter.post("/signup", authLimiter, authController.signup);
authRouter.post("/login", authLimiter, authController.login);
authRouter.post("/logout", authController.logout);
authRouter.get("/me", requireUser, authController.me);
