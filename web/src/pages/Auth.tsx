import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth";

const SIDE_IMG = "https://images.unsplash.com/photo-1513258496099-48168024aec0?auto=format&fit=crop&w=1000&q=80";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { user, login, signup } = useAuth();
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  // Single post-login redirect: login() sets user, this re-renders and routes by role
  if (user) return <Navigate to={user.role === "admin" ? "/admin" : "/"} replace />;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        const { needsEmailConfirmation } = await signup(email, password, String(form.get("fullName") ?? "").trim());
        if (needsEmailConfirmation) setInfo("Check your email to confirm the account, then log in.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isLogin = mode === "login";
  return (
    <section className="auth container">
      <img className="auth__img" src={SIDE_IMG} alt="" />
      <div className="auth__panel">
        <h1>{isLogin ? "Log in to continue your learning journey" : "Sign up with email"}</h1>
        <form onSubmit={onSubmit} className="form">
          {!isLogin && (
            <label>
              Full name
              <input name="fullName" autoComplete="name" maxLength={200} required />
            </label>
          )}
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={8}
              autoComplete={isLogin ? "current-password" : "new-password"}
              required
            />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          {info && <p className="notice" role="status">{info}</p>}
          <button className="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? "Please wait…" : isLogin ? "Log in" : "Sign up"}
          </button>
        </form>
        <p className="auth__switch">
          {isLogin ? <>Don't have an account? <Link to="/signup">Sign up</Link></> : <>Already have an account? <Link to="/login">Log in</Link></>}
        </p>
      </div>
    </section>
  );
}
