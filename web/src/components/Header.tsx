import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";
import { CartIcon, GlobeIcon, MenuIcon, SearchIcon } from "./Icons";

const searchUrl = (q: string, hash = "") => `/${q ? `?q=${encodeURIComponent(q)}` : ""}${hash}`;

export function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const [menuOpen, setMenuOpen] = useState(false);

  // URL is the source of truth: logo click or back button must reset the box too
  useEffect(() => setQuery(urlQuery), [urlQuery]);

  // Any page change closes the mobile menu, otherwise its overlay hides the new page
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Search lives in the URL (?q=) so the home page can filter and the result is shareable.
  // On the home page it filters while typing; replace keeps one history entry per search.
  const onChange = (value: string) => {
    setQuery(value);
    if (location.pathname === "/") navigate(searchUrl(value.trim(), location.hash), { replace: true });
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    navigate(searchUrl(query.trim(), "#catalog"));
  };

  // Same-URL clicks don't change location, so scroll to top by hand
  const goHome = () => {
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const onLogout = () => {
    setMenuOpen(false);
    void logout().then(() => navigate("/"));
  };

  const isAdmin = user?.role === "admin";
  const initials = user?.fullName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <header className="header">
      <button className="icon-btn header__menu" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
        <MenuIcon />
      </button>
      <Link to="/" className="logo" aria-label="Docademy home" onClick={goHome}>
        <span className="logo__mark">d</span>ocademy
      </Link>

      {/* Admins don't shop: no search or cart, just a spacer keeping the user controls on the right */}
      {isAdmin ? (
        <div className="header__spacer" />
      ) : (
        <>
          <form className="search" role="search" onSubmit={onSearch}>
            <SearchIcon />
            <input
              type="search"
              placeholder="Search for anything"
              value={query}
              onChange={(e) => onChange(e.target.value)}
              aria-label="Search documents"
            />
          </form>

          <Link to="/orders" className="icon-btn" aria-label="Past orders" title="Past orders">
            <CartIcon />
          </Link>
        </>
      )}

      {user ? (
        <div className="header__user">
          {isAdmin ? (
            <Link to="/admin" className="avatar" title={`${user.fullName} — admin dashboard`}>{initials}</Link>
          ) : (
            <Link to="/orders" className="avatar" title={`${user.fullName} — my orders`}>{initials}</Link>
          )}
          <button className="btn btn--outline" onClick={onLogout}>Log out</button>
        </div>
      ) : (
        <div className="header__auth">
          <Link to="/login" className="btn btn--outline">Log in</Link>
          <Link to="/signup" className="btn btn--primary">Sign up</Link>
          <button className="btn btn--outline btn--square" aria-label="Language"><GlobeIcon /></button>
        </div>
      )}

      {menuOpen && (
        <div className="mobile-menu" onClick={() => setMenuOpen(false)}>
          {user ? (
            <>
              {!isAdmin && <Link to="/orders">Past orders</Link>}
              <button className="btn btn--outline mobile-menu__end" onClick={onLogout}>Log out</button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn--outline">Log in</Link>
              <Link to="/signup" className="btn btn--primary">Sign up</Link>
            </>
          )}
        </div>
      )}
    </header>
  );
}
