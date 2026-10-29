import { Router, type Request, type Response } from "express";
import { prisma } from "../db.js";
import { HttpError } from "../httpError.js";
import { bearerToken, requireUser } from "../middleware/requireUser.middleware.js";
import { loginSchema } from "../schema/auth/request/auth.login.js";
import { signupSchema } from "../schema/auth/request/auth.signup.js";
import { loginResponseSchema } from "../schema/auth/response/auth.login.js";
import { meResponseSchema } from "../schema/auth/response/auth.me.js";
import { signupResponseSchema } from "../schema/auth/response/auth.signup.js";
import { createRequestClient } from "../supabase.js";
import { parse } from "../validate.js";

export const authRouter = Router();

// Creates the Supabase Auth account; DB trigger on auth.users then inserts the public.users row (role client)
authRouter.post("/signup", async (req: Request, res: Response) => {
  const body = parse(signupSchema, req.body);

  const { data, error } = await createRequestClient().auth.signUp({ email: body.email, password: body.password });
  if (error) {
    // 4xx from Supabase = bad input (weak password, already registered, rate limit); pass message through
    const status = error.status && error.status < 500 ? (error.status === 429 ? 429 : 400) : 502;
    throw new HttpError(status, status === 502 ? "Auth service unavailable" : error.message);
  }

  // With confirmation on, an existing email gets a fake user here; updateMany then matches nothing
  if (body.fullName && data.user) {
    await prisma.user.updateMany({ where: { id: data.user.id }, data: { fullName: body.fullName } });
  }

  res.status(201).json(signupResponseSchema.parse({ email: body.email, needsEmailConfirmation: !data.session }));
});

// Supabase checks the password; we return its tokens. Fresh client so the session never sits in shared memory.
authRouter.post("/login", async (req: Request, res: Response) => {
  const body = parse(loginSchema, req.body);

  const { data, error } = await createRequestClient().auth.signInWithPassword(body);
  if (error) {
    if (error.code === "email_not_confirmed") throw new HttpError(403, "Confirm your email before signing in");
    if (error.status === 429) throw new HttpError(429, "Too many attempts, try again later");
    // One message for wrong email and wrong password: don't reveal which accounts exist
    if (error.status && error.status < 500) throw new HttpError(401, "Invalid email or password");
    throw new HttpError(502, "Auth service unavailable");
  }

  const { session, user } = data;
  res.json(
    loginResponseSchema.parse({
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at,
      user: { id: user.id, email: user.email ?? null },
    }),
  );
});

// Revokes this session's refresh token in Supabase Auth. No requireUser: an expired token must still be able to log out.
authRouter.post("/logout", async (req: Request, res: Response) => {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "Missing bearer token");

  // admin.signOut sends the user's own JWT to /logout; publishable key is enough
  const { error } = await createRequestClient().auth.admin.signOut(token, "local");
  // 401/403/404 = session already gone; logout is idempotent
  if (error && !(error.status && [401, 403, 404].includes(error.status))) {
    throw new HttpError(502, "Auth service unavailable");
  }
  res.status(204).end();
});

// Who am I? Page uses role to decide which view to show; server re-checks role on every admin call
authRouter.get("/me", requireUser, (req: Request, res: Response) => {
  res.json(meResponseSchema.parse({ user: req.user }));
});
