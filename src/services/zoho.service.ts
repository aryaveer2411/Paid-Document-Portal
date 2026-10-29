import { env } from "../config/env.js";

// Thin Zoho CRM client: OAuth token handling + Deal upsert. No DB access here.

const API_VERSION = "v8";
const TIMEOUT_MS = 10_000;

// Any Zoho failure (down, slow, auth, validation). Callers record it and retry later.
export class ZohoError extends Error {}

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | null = null;
// Concurrent callers share one refresh: Zoho rate-limits token refreshes per refresh token
let refreshing: Promise<string> | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ZohoError(`Zoho unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function refreshAccessToken(): Promise<string> {
  const res = await fetchWithTimeout(`${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
    }),
  });
  // Zoho reports token errors as HTTP 200 with an "error" field
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new ZohoError(`Zoho token refresh failed: ${body.error ?? `HTTP ${res.status}`}`);
  }
  // Renew 60s early so a token never expires mid-request
  const ttlSeconds = (body.expires_in ?? 3600) - 60;
  cachedToken = { value: body.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
  return body.access_token;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  refreshing ??= refreshAccessToken().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

type ZohoRecordResult = {
  code?: string;
  status?: string;
  message?: string;
  details?: Record<string, unknown> & { id?: string };
};

async function zohoRequest(method: string, path: string, payload: unknown, retryOnAuth = true): Promise<ZohoRecordResult> {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${env.ZOHO_API_URL}/crm/${API_VERSION}${path}`, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Token revoked or expired early: drop cache, refresh once, try again
  if (res.status === 401 && retryOnAuth) {
    cachedToken = null;
    return zohoRequest(method, path, payload, false);
  }

  const body = (await res.json().catch(() => ({}))) as { data?: ZohoRecordResult[] } & ZohoRecordResult;
  const record = body.data?.[0];
  if (!res.ok || !record || record.status !== "success") {
    const detail = record ?? body;
    throw new ZohoError(`Zoho ${res.status} ${detail.code ?? ""}: ${detail.message ?? "unexpected response"}`.trim());
  }
  return record;
}

// Standard Zoho Deal stages; a refunded purchase becomes "Closed Lost"
export type DealStage = "Qualification" | "Closed Won" | "Closed Lost";

export type DealInput = {
  purchaseId: string;
  name: string;
  stage: DealStage;
  amount: number;
  // ISO code (e.g. "USD"); without it Zoho reads Amount in the org's home currency
  currency: string;
  closingDate: Date;
  description: string;
};

// Upsert keyed on our unique purchase-id field: first call creates the Deal, every later call
// (retries, repeats) updates that same Deal. Zoho itself guarantees one Deal per purchase.
export async function upsertDeal(input: DealInput): Promise<string> {
  const record = await zohoRequest("POST", "/Deals/upsert", {
    duplicate_check_fields: [env.ZOHO_DEAL_PURCHASE_FIELD],
    data: [
      {
        [env.ZOHO_DEAL_PURCHASE_FIELD]: input.purchaseId,
        Deal_Name: input.name,
        Stage: input.stage,
        Amount: input.amount,
        // Home-currency Deals omit Currency, so orgs without multi-currency accept them
        ...(input.currency !== env.ZOHO_HOME_CURRENCY && { Currency: input.currency }),
        Closing_Date: input.closingDate.toISOString().slice(0, 10),
        Description: input.description,
        ...(env.ZOHO_DEAL_PIPELINE && { Pipeline: env.ZOHO_DEAL_PIPELINE }),
      },
    ],
  });
  const id = record.details?.id;
  if (typeof id !== "string") throw new ZohoError("Zoho upsert returned no Deal id");
  return id;
}
