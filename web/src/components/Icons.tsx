// Inline SVG icons: no icon font or extra dependency
const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const SearchIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const CartIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M3 4h2l2.4 11h10.8L21 7H6.2" /><circle cx="9" cy="19.5" r="1.3" /><circle cx="17" cy="19.5" r="1.3" /></svg>
);
export const GlobeIcon = () => (
  <svg {...base} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" /></svg>
);
export const MenuIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const ArrowIcon = () => (
  <svg {...base} aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
