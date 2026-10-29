import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getSupabase, type User } from "./api";

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, fullName: string) => Promise<{ needsEmailConfirmation: boolean }>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const supabase = await getSupabase();
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setUser(null);
      return;
    }
    try {
      const { user } = await api<{ user: User }>("/api/auth/me");
      setUser(user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let unsubscribe = () => {};
    getSupabase()
      .then((supabase) => {
        // Fires on load (INITIAL_SESSION), sign in, sign out; token refresh needs no reload of /me
        const { data } = supabase.auth.onAuthStateChange((event) => {
          if (event === "TOKEN_REFRESHED") return;
          setTimeout(() => void refresh().finally(() => setLoading(false)), 0);
        });
        unsubscribe = () => data.subscription.unsubscribe();
      })
      .catch(() => setLoading(false));
    return () => unsubscribe();
  }, [refresh]);

  // Server login returns Supabase tokens; setSession stores them so supabase-js can refresh and read Supabase directly
  const login = useCallback(async (email: string, password: string) => {
    const { accessToken, refreshToken } = await api<{ accessToken: string; refreshToken: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const supabase = await getSupabase();
    const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) throw error;
    await refresh();
  }, [refresh]);

  const signup = useCallback(async (email: string, password: string, fullName: string) => {
    const res = await api<{ needsEmailConfirmation: boolean }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, fullName }),
    });
    if (!res.needsEmailConfirmation) await login(email, password);
    return res;
  }, [login]);

  const logout = useCallback(async () => {
    // Server revokes the session; failure there must not leave the browser signed in
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    const supabase = await getSupabase();
    await supabase.auth.signOut({ scope: "local" });
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, signup, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
