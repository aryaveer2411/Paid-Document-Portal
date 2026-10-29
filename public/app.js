import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";

const $ = (id) => document.getElementById(id);
const showError = (msg) => ($("error").textContent = msg ?? "");

const config = await (await fetch("/config.json")).json();
// Publishable key only; session (access + refresh token) kept in localStorage by supabase-js
const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey);

// Calls our server with the current access token; server verifies it with Supabase
async function api(path, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...options.headers },
  });
  // Server envelope: { success, message, data } or { success: false, error: { code, message, details? } }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    const details = body.error?.details?.map((d) => `${d.path}: ${d.message}`).join("; ");
    throw new Error([body.error?.message ?? `Request failed (${res.status})`, details].filter(Boolean).join(" — "));
  }
  return body.data ?? {};
}

const toCents = (dollars) => Math.round(Number(dollars) * 100);
const formatPrice = (p) => (p ? `${(p.amountCents / 100).toFixed(2)} ${p.currency.toUpperCase()}` : "—");

async function render() {
  showError();
  const { data } = await supabase.auth.getSession();
  $("login-view").hidden = !!data.session;
  $("session-view").hidden = !data.session;
  if (!data.session) return;

  try {
    const { user } = await api("/api/auth/me");
    $("who").textContent = `${user.fullName} <${user.email}>`;
    $("role").textContent = user.role;
    // UI hint only; every /api/admin call is re-checked on the server
    $("admin-view").hidden = user.role !== "admin";
    $("client-view").hidden = user.role === "admin";
    if (user.role === "admin") await loadProducts();
  } catch (err) {
    showError(err.message);
  }
}

async function loadProducts() {
  const { products } = await api("/api/admin/products");
  const tbody = $("product-rows");
  tbody.replaceChildren(...products.map(productRow));
}

// textContent everywhere: titles are user input, never inject as HTML
function productRow(p) {
  const tr = document.createElement("tr");
  const cell = (text) => {
    const td = document.createElement("td");
    td.textContent = text;
    return td;
  };
  const sync = p.stripeSync;
  const stripeCell = cell(sync.status === "failed" ? `failed: ${sync.error ?? "unknown error"}` : sync.status);
  // Hover shows the Stripe ids, useful when matching rows to the Stripe dashboard
  stripeCell.title = [p.stripeProductId, p.price?.stripePriceId].filter(Boolean).join(" / ");
  tr.append(cell(p.title), cell(formatPrice(p.price)), cell(p.archivedAt ? "Deleted" : "Available"), stripeCell);

  const actions = document.createElement("td");
  // Deleted products need syncing too (Stripe product must be archived)
  if (sync.status !== "synced") {
    const retry = Object.assign(document.createElement("button"), { textContent: "Retry Stripe sync" });
    retry.onclick = () => run(() => api(`/api/admin/products/${p.id}/stripe-sync`, { method: "POST" }));
    actions.append(retry);
  }
  if (!p.archivedAt) {
    const wrap = document.createElement("div");
    wrap.className = "row-actions";
    const input = Object.assign(document.createElement("input"), { type: "number", min: "0.50", step: "0.01" });
    if (p.price) input.value = (p.price.amountCents / 100).toFixed(2);
    const save = Object.assign(document.createElement("button"), { textContent: "Update price" });
    save.onclick = () => run(() => api(`/api/admin/products/${p.id}/price`, {
      method: "PUT",
      body: JSON.stringify({ amountCents: toCents(input.value), currency: p.price?.currency ?? "usd" }),
    }));
    const del = Object.assign(document.createElement("button"), { textContent: "Delete" });
    del.onclick = () => confirm(`Delete "${p.title}"? Existing buyers keep access.`) &&
      run(() => api(`/api/admin/products/${p.id}`, { method: "DELETE" }));
    wrap.append(input, save, del);
    actions.append(wrap);
  }
  tr.append(actions);
  return tr;
}

// Run an admin action, then refresh the table
async function run(action) {
  showError();
  try {
    await action();
    await loadProducts();
  } catch (err) {
    showError(err.message);
  }
}

// Server login returns Supabase tokens; setSession stores them so supabase-js can refresh and read Supabase directly
async function login(email, password) {
  const { accessToken, refreshToken } = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  if (error) throw error;
}

$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  showError();
  const form = new FormData(e.target);
  try {
    await login(form.get("email"), form.get("password"));
  } catch (err) {
    showError(err.message);
  }
};

$("signup-btn").onclick = async () => {
  showError();
  const form = new FormData($("login-form"));
  const email = form.get("email");
  const password = form.get("password");
  // Not `required` in HTML: same form is used for sign in, which needs no name. Server validates too.
  const fullName = form.get("fullName")?.trim();
  if (!fullName) return showError("Full name is required to create an account.");
  try {
    const { needsEmailConfirmation } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, fullName }),
    });
    if (needsEmailConfirmation) return showError("Check your email to confirm the account, then sign in.");
    await login(email, password);
  } catch (err) {
    showError(err.message);
  }
};

$("logout-btn").onclick = async () => {
  // Server revokes the session; failure there must not leave the browser signed in
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  // scope "local" = clear this browser's stored session
  await supabase.auth.signOut({ scope: "local" });
};

$("create-form").onsubmit = (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  run(async () => {
    await api("/api/admin/products", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        description: form.get("description") || undefined,
        storagePath: form.get("storagePath"),
        amountCents: toCents(form.get("price")),
      }),
    });
    e.target.reset();
  });
};

// Fires on load (INITIAL_SESSION), sign in, sign out, token refresh
supabase.auth.onAuthStateChange((event) => {
  if (event !== "TOKEN_REFRESHED") setTimeout(render, 0);
});
