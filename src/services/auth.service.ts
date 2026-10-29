import { prisma } from "../db.js";
import { ApiError } from "../errors/api.error.js";
import type { LoginInput } from "../schema/auth/request/auth.login.js";
import type { SignupInput } from "../schema/auth/request/auth.signup.js";
import { loginResponseSchema, type LoginResponse } from "../schema/auth/response/auth.login.js";
import { signupResponseSchema, type SignupResponse } from "../schema/auth/response/auth.signup.js";
import { createRequestClient } from "../supabase.js";

// Creates the Supabase Auth account; DB trigger on auth.users then inserts the public.users row (role client)
export async function signup(input: SignupInput): Promise<SignupResponse> {
  const { data, error } = await createRequestClient().auth.signUp({ email: input.email, password: input.password });
  if (error) {
    if (error.status === 429) throw ApiError.rateLimited();
    // Other 4xx = bad input (weak password, already registered); Supabase message is safe to show
    if (error.status && error.status < 500) throw new ApiError(400, "VALIDATION_FAILED", error.message);
    throw ApiError.upstream("Auth service unavailable");
  }

  // With confirmation on, an existing email gets a fake user here; updateMany then matches nothing
  if (input.fullName && data.user) {
    await prisma.user.updateMany({ where: { id: data.user.id }, data: { fullName: input.fullName } });
  }

  return signupResponseSchema.parse({ email: input.email, needsEmailConfirmation: !data.session });
}

// Supabase checks the password; we return its tokens. Fresh client so the session never sits in shared memory.
export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data, error } = await createRequestClient().auth.signInWithPassword(input);
  if (error) {
    if (error.code === "email_not_confirmed") throw ApiError.forbidden("Confirm your email before signing in");
    if (error.status === 429) throw ApiError.rateLimited();
    // One message for wrong email and wrong password: don't reveal which accounts exist
    if (error.status && error.status < 500) throw ApiError.unauthorized("Invalid email or password");
    throw ApiError.upstream("Auth service unavailable");
  }

  const { session, user } = data;
  return loginResponseSchema.parse({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at,
    user: { id: user.id, email: user.email ?? null },
  });
}

// Revokes this session's refresh token in Supabase Auth
export async function logout(accessToken: string): Promise<void> {
  // admin.signOut sends the user's own JWT to /logout; publishable key is enough
  const { error } = await createRequestClient().auth.admin.signOut(accessToken, "local");
  // 401/403/404 = session already gone; logout is idempotent
  if (error && !(error.status && [401, 403, 404].includes(error.status))) {
    throw ApiError.upstream("Auth service unavailable");
  }
}
