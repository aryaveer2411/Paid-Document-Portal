import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Role = "client" | "admin";
export type User = { id: string; email: string | null; fullName: string; role: Role };
export type Price = { amountCents: number; currency: string };
export type CatalogItem = { id: string; title: string; description: string | null; price: Price; owned: boolean };
export type SyncStatus = "pending" | "synced" | "failed";
export type AdminProduct = {
  id: string;
  title: string;
  description: string | null;
  archivedAt: string | null;
  stripeProductId: string | null;
  price: (Price & { id: string; stripePriceId: string | null }) | null;
  stripeSync: { status: SyncStatus; error: string | null };
};
export type AdminPurchase = {
  id: string;
  customer: string;
  documentTitle: string;
  amountCents: number;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded";
  paidAt: string | null;
  zohoDealId: string | null;
  crmSyncStatus: "pending" | "synced" | null;
  crmSyncError: string | null;
  crmSyncAttempts: number;
};

let client: SupabaseClient | null = null;

// Browser-safe values only (URL + publishable key), served by Express from env
export async function getSupabase(): Promise<SupabaseClient> {
  if (client) return client;
  const res = await fetch("/config.json");
  if (!res.ok) throw new Error("Could not load app config");
  const config = (await res.json()) as { supabaseUrl: string; supabasePublishableKey: string };
  // Session (access + refresh token) kept in localStorage by supabase-js
  client = createClient(config.supabaseUrl, config.supabasePublishableKey);
  return client;
}

type ErrorBody = { success: false; error?: { message?: string; details?: { path: string; message: string }[] } };

// Calls our server with the current access token; server verifies it with Supabase
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
  // Server envelope: { success, message, data } or { success: false, error: { code, message, details? } }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T } & ErrorBody;
  if (!res.ok || !body.success) {
    const details = body.error?.details?.map((d) => `${d.path}: ${d.message}`).join("; ");
    throw new Error([body.error?.message ?? `Request failed (${res.status})`, details].filter(Boolean).join(" — "));
  }
  return (body.data ?? {}) as T;
}

export const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

export const toCents = (value: string) => Math.round(Number(value) * 100);

// Stable random-looking cover per product: same id → same picture
export const coverFor = (seed: string, w = 480, h = 270) =>
  `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`;
