import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { api, money, toCents, type AdminProduct, type AdminPurchase } from "../api";
import { useAuth } from "../auth";

export function Admin() {
  const { user, loading } = useAuth();
  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [purchases, setPurchases] = useState<AdminPurchase[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, q] = await Promise.all([
      api<{ products: AdminProduct[] }>("/api/admin/products"),
      api<{ purchases: AdminPurchase[] }>("/api/admin/purchases"),
    ]);
    setProducts(p.products);
    setPurchases(q.purchases);
  }, []);

  useEffect(() => {
    if (user?.role === "admin") load().catch((e: Error) => setError(e.message));
  }, [user, load]);

  // Run an admin action, then refresh both tables
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // UI hint only; every /api/admin call is re-checked on the server
  if (!loading && user?.role !== "admin") return <Navigate to="/" replace />;

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const file = form.get("file");
    // Quick checks for a fast message; the server re-checks size and real PDF content
    if (!(file instanceof File) || file.size === 0) return setError("Choose a PDF file.");
    if (file.size > 10 * 1024 * 1024) return setError("File is over 10 MB.");
    void run(async () => {
      // 1) Upload the raw PDF; the server picks the storage path and returns it
      const { storagePath } = await api<{ storagePath: string }>("/api/admin/uploads", {
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
          amountCents: toCents(String(form.get("price"))),
        }),
      });
      formEl.reset();
    });
  };

  return (
    <section className="container page admin">
      <h1>Admin dashboard</h1>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="card">
        <h2>New product</h2>
        <form className="form form--grid" onSubmit={onCreate}>
          <label>Title<input name="title" maxLength={200} required /></label>
          <label>Price<input name="price" type="number" min="0.01" step="0.01" required /></label>
          <label className="span-2">Description<textarea name="description" maxLength={2000} rows={3} /></label>
          <label className="span-2">Document (PDF, max 10 MB)<input name="file" type="file" accept="application/pdf" required /></label>
          <button className="btn btn--primary" disabled={busy}>Create</button>
        </form>
      </div>

      <div className="card">
        <h2>Products</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Title</th><th>Price</th><th>Status</th><th>Stripe</th><th>Actions</th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.title}</td>
                  <td>{p.price ? money(p.price.amountCents, p.price.currency) : "—"}</td>
                  <td>{p.archivedAt ? "Deleted" : "Available"}</td>
                  {/* Hover shows the Stripe ids, useful when matching rows to the Stripe dashboard */}
                  <td title={[p.stripeProductId, p.price?.stripePriceId].filter(Boolean).join(" / ")}>
                    <span className={`badge badge--${p.stripeSync.status === "synced" ? "ok" : p.stripeSync.status === "pending" ? "warn" : "bad"}`}>
                      {p.stripeSync.status}
                    </span>
                    {p.stripeSync.status === "failed" && <small className="muted"> {p.stripeSync.error ?? "unknown error"}</small>}
                  </td>
                  <td>
                    <div className="row-actions">
                      {/* Deleted products need syncing too (Stripe product must be archived) */}
                      {p.stripeSync.status !== "synced" && (
                        <button className="btn btn--outline btn--sm" disabled={busy}
                          onClick={() => void run(() => api(`/api/admin/products/${p.id}/stripe-sync`, { method: "POST" }))}>
                          Retry Stripe
                        </button>
                      )}
                      {!p.archivedAt && (
                        <>
                          <input
                            type="number" min="0.01" step="0.01" aria-label="New price"
                            value={prices[p.id] ?? (p.price ? (p.price.amountCents / 100).toFixed(2) : "")}
                            onChange={(e) => setPrices((s) => ({ ...s, [p.id]: e.target.value }))}
                          />
                          <button className="btn btn--outline btn--sm" disabled={busy}
                            onClick={() => void run(() => api(`/api/admin/products/${p.id}/price`, {
                              method: "PUT",
                              // No currency sent: server uses its default currency
                              body: JSON.stringify({ amountCents: toCents(prices[p.id] ?? String((p.price?.amountCents ?? 0) / 100)) }),
                            }))}>
                            Update price
                          </button>
                          <button className="btn btn--danger btn--sm" disabled={busy}
                            onClick={() => confirm(`Delete "${p.title}"? Existing buyers keep access.`) &&
                              void run(() => api(`/api/admin/products/${p.id}`, { method: "DELETE" }))}>
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card__head">
          <h2>Purchases</h2>
          <button className="btn btn--primary btn--sm" disabled={busy}
            onClick={() => void run(() => api("/api/admin/purchases/crm-sync", { method: "POST" }))}>
            Retry pending Zoho syncs
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th>Document</th><th>Amount</th><th>Payment</th><th>Zoho</th></tr></thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id}>
                  <td>{p.customer}</td>
                  <td>{p.documentTitle}</td>
                  <td>{money(p.amountCents, p.currency)}</td>
                  <td>{p.status}</td>
                  {/* Hover the Zoho cell for the Deal id or the last error */}
                  <td title={p.crmSyncError ?? p.zohoDealId ?? ""}>
                    {p.crmSyncStatus === "synced" ? "Synced" : p.crmSyncStatus === "pending" ? "Pending" : "—"}
                    {p.crmSyncError && p.crmSyncStatus === "pending" && <small className="muted"> ({p.crmSyncError})</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
