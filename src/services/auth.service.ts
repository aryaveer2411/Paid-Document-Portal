import { ApiError } from "../errors/api.error.js";
import type { LoginInput } from "../schema/auth/request/auth.login.js";
import type { SignupInput } from "../schema/auth/request/auth.signup.js";
import { loginResponseSchema, type LoginResponse } from "../schema/auth/response/auth.login.js";
import { signupResponseSchema, type SignupResponse } from "../schema/auth/response/auth.signup.js";
import { createRequestClient } from "../supabase.js";

// Supabase has separate limits; naming which one tripped saves guessing (email quota vs request rate)
function rateLimitError(code: string | undefined) {
  if (code === "over_email_send_rate_limit") {
    return ApiError.rateLimited("Email sending limit reached (Supabase built-in mailer); try again later");
  }
  return ApiError.rateLimited("Too many auth requests from this server; try again in a few minutes");
}

// Creates the Supabase Auth account; DB trigger on auth.users then inserts the public.users row (role client)
export async function signup(input: SignupInput): Promise<SignupResponse> {
  // full_name rides in user metadata; the auth.users trigger copies it into public.users in the same insert
  const { data, error } = await createRequestClient().auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { full_name: input.fullName } },
  });
  if (error) {
    if (error.status === 429) throw rateLimitError(error.code);
    // Other 4xx = bad input (weak password, already registered); Supabase message is safe to show
    if (error.status && error.status < 500) throw new ApiError(400, "VALIDATION_FAILED", error.message);
    throw ApiError.upstream("Auth service unavailable");
  }

  return signupResponseSchema.parse({ email: input.email, needsEmailConfirmation: !data.session });
}

// Supabase checks the password; we return its tokens. Fresh client so the session never sits in shared memory.
export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data, error } = await createRequestClient().auth.signInWithPassword(input);
  if (error) {
    if (error.code === "email_not_confirmed") throw ApiError.forbidden("Confirm your email before signing in");
    if (error.status === 429) throw rateLimitError(error.code);
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
