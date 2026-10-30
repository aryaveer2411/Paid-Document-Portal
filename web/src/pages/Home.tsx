import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, coverFor, money, type CatalogItem } from "../api";
import { useAuth } from "../auth";
import { openDocument } from "../openDocument";

const HERO_IMG = "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1600&q=80";

export function Home() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const [products, setProducts] = useState<CatalogItem[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    const { products } = await api<{ products: CatalogItem[] }>("/api/products");
    setProducts(products);
    return products;
  }, []);

  // Guests browse too; wait for auth so a signed-in client gets "owned" flags on the first load
  useEffect(() => {
    if (loading || user?.role === "admin") return;
    loadCatalog().catch((e: Error) => setError(e.message));
  }, [user, loading, loadCatalog]);

  // Keyed on the id: auth events (e.g. tab refocus) replace the user object, which would cancel the poll below
  const userId = user?.id;

  // Back from Stripe. The redirect proves nothing; access appears only once the webhook has granted it.
  useEffect(() => {
    const result = params.get("checkout");
    if (!result || !userId) return;
    const next = new URLSearchParams(params);
    next.delete("checkout");
    setParams(next, { replace: true });
    if (result === "cancelled") {
      setNotice("Checkout cancelled. You were not charged.");
      return;
    }
    let documentId: string | null = null;
    try {
      documentId = sessionStorage.getItem("pendingDocumentId");
      sessionStorage.removeItem("pendingDocumentId");
    } catch {}
    setNotice("Payment received, confirming access…");
    let cancelled = false;
    (async () => {
      // Webhook usually lands within seconds; poll briefly instead of trusting the redirect
      for (let i = 0; i < 10 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const list = await loadCatalog().catch(() => [] as CatalogItem[]);
        if (list.some((p) => p.owned && (!documentId || p.id === documentId))) {
          if (!cancelled) setNotice("Access granted. Find it in your orders.");
          return;
        }
      }
      if (!cancelled) setNotice("Payment is still being confirmed. Refresh in a minute.");
    })();
    return () => { cancelled = true; };
    // Runs once per sign-in; params are read, not watched (we rewrite them above)
  }, [userId]);

  const visible = useMemo(
    () => products.filter((p) => !query || `${p.title} ${p.description ?? ""}`.toLowerCase().includes(query)),
    [products, query],
  );

  const buy = async (p: CatalogItem) => {
    if (!user) {
      navigate("/login");
      return;
    }
    setError("");
    setBusyId(p.id);
    try {
      const { checkoutUrl } = await api<{ checkoutUrl: string }>("/api/checkout", {
        method: "POST",
        body: JSON.stringify({ documentId: p.id }),
      });
      // Remembered across the Stripe round trip so the return page knows which document to wait for
      try { sessionStorage.setItem("pendingDocumentId", p.id); } catch {}
      window.location.assign(checkoutUrl);
    } catch (e) {
      setError((e as Error).message);
      setBusyId(null);
    }
  };

  return (
    <>
      {/* Sign-up pitch is for guests only; wait for auth so it doesn't flash for signed-in users */}
      {!loading && !user && (
        <section className="hero">
          <img className="hero__img" src={HERO_IMG} alt="" />
          <div className="hero__card">
            <h1>Build the skills your career needs.</h1>
            <p>Get instant access to expert documents. Pay once, keep it forever, and track every order and its status in one simple place.</p>
            <Link to="/signup" className="btn btn--primary btn--lg">Get started</Link>
          </div>
        </section>
      )}

      <section className="intro container" id="categories">
        <div className="intro__text">
          <h2>Learn <em>essential</em> career and life skills</h2>
          <p>Docademy helps you build in-demand skills fast and advance your career in a changing job market</p>
        </div>
      </section>

      <section className="container catalog" id="catalog">
        <h2>{query ? `Results for “${params.get("q")}”` : "All documents"}</h2>
        {notice && <p className="notice" role="status">{notice}</p>}
        {error && <p className="error" role="alert">{error}</p>}

        {user?.role === "admin" && (
          <div className="empty"><p>Admins manage the catalog from the <Link to="/admin">admin dashboard</Link>.</p></div>
        )}
        {!loading && user?.role !== "admin" && visible.length === 0 && <div className="empty"><p>No documents found.</p></div>}

        <div className="grid">
          {visible.map((p) => (
            <article key={p.id} className="course">
              <img src={coverFor(p.id)} alt="" loading="lazy" />
              <div className="course__body">
                <h3>{p.title}</h3>
                {p.description && <p className="course__desc">{p.description}</p>}
                <div className="course__foot">
                  <strong>{money(p.price.amountCents, p.price.currency)}</strong>
                  {p.owned ? (
                    <button className="btn btn--dark" onClick={() => openDocument(p.id).catch((e: Error) => setError(e.message))}>
                      Open
                    </button>
                  ) : (
                    <button className="btn btn--primary" disabled={busyId === p.id} onClick={() => void buy(p)}>
                      {busyId === p.id ? "Redirecting…" : user ? "Buy now" : "Log in to buy"}
                    </button>
                  )}
                </div>
                {p.owned && <span className="badge badge--ok">Purchased</span>}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
