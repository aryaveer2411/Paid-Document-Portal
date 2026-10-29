import { useCallback, useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, coverFor, getSupabase, money } from "../api";
import { useAuth } from "../auth";
import { openDocument } from "../openDocument";

type Order = {
  id: string;
  document_id: string;
  amount_cents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  crm_sync_status: "pending" | "synced" | null;
  refund_requested_at: string | null;
  created_at: string;
  documents: { title: string } | null;
};

type Entitlement = { purchase_id: string; document_id: string; revoked_at: string | null; opened_at: string | null };

// A token fresh from Supabase Auth can be rejected by the Data API for a few seconds when the two
// servers' clocks drift ("JWT issued at future"). Only that error is retried; anything else fails at once.
async function withClockSkewRetry<T extends { error: { message: string } | null }>(run: () => PromiseLike<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const result = await run();
    if (!result.error || !/issued at future/i.test(result.error.message) || attempt === 5) return result;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

const crmLabel = (s: Order["crm_sync_status"]) => (s === "synced" ? "Synced" : s === "pending" ? "Pending" : "—");

export function Orders() {
  const { user, loading } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  // Active (not revoked) entitlements, keyed by the purchase that grants them
  const [access, setAccess] = useState<Map<string, Entitlement>>(new Map());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refunding, setRefunding] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = await getSupabase();
    // Browser → Supabase directly with the user's token. RLS returns only this user's rows,
    // so another client's purchases can't be fetched even by editing this code.
    const [purchases, entitlements] = await Promise.all([
      withClockSkewRetry(() =>
        supabase
          .from("purchases")
          .select("id, document_id, amount_cents, currency, status, crm_sync_status, refund_requested_at, created_at, documents(title)")
          .order("created_at", { ascending: false }),
      ),
      withClockSkewRetry(() => supabase.from("entitlements").select("purchase_id, document_id, revoked_at, opened_at")),
    ]);
    if (purchases.error) throw new Error(purchases.error.message);
    if (entitlements.error) throw new Error(entitlements.error.message);
    const rows = (entitlements.data as Entitlement[]).filter((e) => !e.revoked_at);
    setAccess(new Map(rows.map((e) => [e.purchase_id, e])));
    setOrders(purchases.data as unknown as Order[]);
  }, []);

  useEffect(() => {
    if (!user) return;
    load().catch((e: Error) => setError(e.message));
  }, [user, load]);

  // Opening ends the refund window, so the page reloads to hide the refund button
  const open = (documentId: string) =>
    openDocument(documentId)
      .then(load)
      .catch((e: Error) => setError(e.message));

  async function refund(order: Order) {
    const title = order.documents?.title ?? "this document";
    if (!window.confirm(`Refund ${money(order.amount_cents, order.currency)} for "${title}"? You will lose access to it.`)) return;
    setError("");
    setNotice("");
    setRefunding(order.id);
    try {
      // Server re-checks ownership and "never opened"; this button is only a hint
      const { status } = await api<{ status: "refunded" | "pending" }>(`/api/purchases/${order.id}/refund`, { method: "POST" });
      setNotice(status === "refunded" ? "Refund completed." : "Refund requested; it will finish once Stripe confirms.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefunding(null);
      await load().catch((e: Error) => setError(e.message));
    }
  }

  if (!loading && !user) return <Navigate to="/login" replace />;

  return (
    <section className="container page">
      <h1>Past orders</h1>
      <p className="muted">Read straight from Supabase; database rules return only your own rows.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {orders === null && !error && <p className="muted">Loading…</p>}
      {orders?.length === 0 && (
        <div className="empty">
          <p>No orders yet.</p>
          <Link to="/#catalog" className="btn btn--primary">Browse documents</Link>
        </div>
      )}
      <div className="orders">
        {orders?.map((o) => {
          const entitlement = access.get(o.id);
          const hasAccess = o.status === "paid" && entitlement !== undefined;
          const refundPending = o.status === "paid" && o.refund_requested_at !== null;
          const canRefund = hasAccess && !refundPending && entitlement.opened_at === null;
          return (
            <article key={o.id} className="order">
              <img src={coverFor(o.document_id, 240, 135)} alt="" loading="lazy" />
              <div className="order__main">
                <h3>{o.documents?.title ?? "(removed)"}</h3>
                <p className="muted">{new Date(o.created_at).toLocaleString()}</p>
                <div className="order__badges">
                  <span className={`badge badge--${o.status === "paid" ? "ok" : o.status === "pending" ? "warn" : "bad"}`}>
                    Payment: {o.status}
                  </span>
                  {refundPending && <span className="badge badge--warn">Refund processing</span>}
                  <span className={`badge badge--${hasAccess ? "ok" : "muted"}`}>{hasAccess ? "Access granted" : "No access"}</span>
                  <span className={`badge badge--${o.crm_sync_status === "synced" ? "ok" : o.crm_sync_status === "pending" ? "warn" : "muted"}`}>
                    CRM: {crmLabel(o.crm_sync_status)}
                  </span>
                </div>
              </div>
              <div className="order__side">
                <strong>{money(o.amount_cents, o.currency)}</strong>
                {hasAccess && (
                  <button className="btn btn--dark" onClick={() => open(o.document_id)}>
                    Open document
                  </button>
                )}
                {canRefund && (
                  <button className="btn btn--danger btn--sm" disabled={refunding === o.id} onClick={() => refund(o)}>
                    {refunding === o.id ? "Refunding…" : "Refund"}
                  </button>
                )}
                {refundPending && (
                  <button className="btn btn--outline btn--sm" disabled={refunding === o.id} onClick={() => refund(o)}>
                    Retry refund
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
