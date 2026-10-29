import { createClient, type SupabaseClientOptions } from "@supabase/supabase-js";
import ws from "ws";
import { env } from "./config/env.js";

// ws's constructor overloads (one accepts null) don't line up with supabase's type; runtime-compatible
type RealtimeTransport = NonNullable<NonNullable<SupabaseClientOptions<"public">["realtime"]>["transport"]>;

const options = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // Node 20 has no built-in WebSocket; supabase-js builds a Realtime client on create and needs one
  realtime: { transport: ws as unknown as RealtimeTransport },
};

// Server-side client used only to verify user tokens; DB access goes through Prisma
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, options);

// signUp/signIn store the resulting session in the client's memory; a fresh client per call
// keeps one user's session from leaking into the shared client above
export function createRequestClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, options);
}
