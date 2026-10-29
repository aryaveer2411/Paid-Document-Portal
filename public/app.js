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
    if (user.role === "admin") await Promise.all([loadProducts(), loadAdminPurchases()]);
    else {
      await Promise.all([loadCatalog(), loadMyPurchases()]);
      handleCheckoutReturn();
    }
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
    const input = Object.assign(document.createElement("input"), { type: "number", min: "0.01", step: "0.01" });
    if (p.price) input.value = (p.price.amountCents / 100).toFixed(2);
    const save = Object.assign(document.createElement("button"), { textContent: "Update price" });
    save.onclick = () => run(() => api(`/api/admin/products/${p.id}/price`, {
      method: "PUT",
      // No currency sent: server uses its default (INR), so updating an old USD price also moves it to INR
      body: JSON.stringify({ amountCents: toCents(input.value) }),
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

async function loadCatalog() {
  const { products } = await api("/api/products");
  $("catalog-rows").replaceChildren(...products.map(catalogRow));
  return products;
}

function catalogRow(p) {
  const tr = document.createElement("tr");
  for (const text of [p.title, formatPrice(p.price)]) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  const access = document.createElement("td");
  if (p.owned) {
    const open = Object.assign(document.createElement("button"), { textContent: "Open document" });
    open.onclick = async () => {
      showError();
      // Opened before the await: browsers block pop-ups opened after an async gap
      const tab = window.open("", "_blank");
      try {
        const { url } = await api(`/api/documents/${p.id}/download`);
        if (tab) tab.location.href = url;
        else window.location.assign(url);
      } catch (err) {
        tab?.close();
        showError(err.message);
      }
    };
    access.append(open);
  } else {
    const buy = Object.assign(document.createElement("button"), { textContent: "Buy" });
    buy.onclick = async () => {
      showError();
      buy.disabled = true;
      try {
        const { checkoutUrl } = await api("/api/checkout", { method: "POST", body: JSON.stringify({ documentId: p.id }) });
        // Remembered across the Stripe round trip so the return page knows which document to wait for
        try { sessionStorage.setItem("pendingDocumentId", p.id); } catch {}
        window.location.assign(checkoutUrl);
      } catch (err) {
        showError(err.message);
        buy.disabled = false;
      }
    };
    access.append(buy);
  }
  tr.append(access);
  return tr;
}

const textRow = (values) => {
  const tr = document.createElement("tr");
  for (const value of values) {
    const td = document.createElement("td");
    td.textContent = value;
    tr.append(td);
  }
  return tr;
};
const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
const crmLabel = (status) => (status === "synced" ? "Synced" : status === "pending" ? "Pending" : "—");

// Browser → Supabase directly with the user's token. RLS returns only this user's rows,
// so another client's purchases can't be fetched even by editing this code.
async function loadMyPurchases() {
  const [purchases, entitlements] = await Promise.all([
    supabase
      .from("purchases")
      .select("id, document_id, amount_cents, currency, status, crm_sync_status, created_at, documents(title)")
      .order("created_at", { ascending: false }),
    supabase.from("entitlements").select("document_id, revoked_at"),
  ]);
  if (purchases.error) throw new Error(purchases.error.message);
  if (entitlements.error) throw new Error(entitlements.error.message);

  const owned = new Set(entitlements.data.filter((e) => !e.revoked_at).map((e) => e.document_id));
  $("my-purchase-rows").replaceChildren(
    ...purchases.data.map((p) =>
      textRow([
        p.documents?.title ?? "(removed)",
        money(p.amount_cents, p.currency),
        p.status,
        p.status === "paid" && owned.has(p.document_id) ? "Granted" : "No access",
        crmLabel(p.crm_sync_status),
      ]),
    ),
  );
}

async function loadAdminPurchases() {
  const { purchases } = await api("/api/admin/purchases");
  $("purchase-rows").replaceChildren(
    ...purchases.map((p) => {
      const tr = textRow([p.customer, p.documentTitle, money(p.amountCents, p.currency), p.status, crmLabel(p.crmSyncStatus)]);
      // Hover the Zoho cell for the Deal id or the last error
      tr.lastChild.title = p.crmSyncError ?? p.zohoDealId ?? "";
      if (p.crmSyncError && p.crmSyncStatus === "pending") tr.lastChild.textContent += ` (${p.crmSyncError})`;
      return tr;
    }),
  );
}

$("crm-retry-btn").onclick = () => run(async () => {
  await api("/api/admin/purchases/crm-sync", { method: "POST" });
  await loadAdminPurchases();
});

// Back from Stripe. The redirect proves nothing; access appears only once the webhook has granted it.
async function handleCheckoutReturn() {
  const result = new URLSearchParams(location.search).get("checkout");
  if (!result) return;
  history.replaceState(null, "", "/");
  const status = $("checkout-status");
  if (result === "cancelled") {
    status.textContent = "Checkout cancelled. You were not charged.";
    return;
  }
  let documentId = null;
  try { documentId = sessionStorage.getItem("pendingDocumentId"); sessionStorage.removeItem("pendingDocumentId"); } catch {}
  status.textContent = "Payment received, confirming access…";
  // Webhook usually lands within seconds; poll briefly instead of trusting the redirect
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const products = await loadCatalog().catch(() => []);
    if (products.some((p) => p.owned && (!documentId || p.id === documentId))) {
      status.textContent = "Access granted.";
      await loadMyPurchases().catch(() => {});
      // Zoho update runs right after access; refresh once more to show it synced
      setTimeout(() => loadMyPurchases().catch(() => {}), 4000);
      return;
    }
  }
  status.textContent = "Payment is still being confirmed. Refresh in a minute.";
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
  const file = form.get("file");
  // Quick checks for a fast message; the server re-checks size and real PDF content
  if (!(file instanceof File) || file.size === 0) return showError("Choose a PDF file.");
  if (file.size > 10 * 1024 * 1024) return showError("File is over 10 MB.");
  run(async () => {
    // 1) Upload the raw PDF; the server picks the storage path and returns it
    const { storagePath } = await api("/api/admin/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    // 2) Create the product pointing at that file
    await api("/api/admin/products", {
      method: "POST",
      body: JSON.stringify({
        title: form.get("title"),
        description: form.get("description") || undefined,
        storagePath,
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
