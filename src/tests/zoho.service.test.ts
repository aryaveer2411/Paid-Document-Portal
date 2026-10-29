import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DealInput } from "../services/zoho.service.js";

const fetchMock = vi.fn<typeof fetch>();

const deal: DealInput = {
  purchaseId: "11111111-1111-4111-8111-111111111111",
  name: "Sample PDF - Client A",
  stage: "Closed Won",
  amount: 499,
  currency: "INR",
  closingDate: new Date("2026-10-01T10:00:00Z"),
  description: "Portal purchase by client.a@example.com",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokenOk = () => json({ access_token: "access-1", expires_in: 3600 });
const upsertOk = (id = "deal_1") => json({ data: [{ code: "SUCCESS", status: "success", details: { id } }] });

const isTokenCall = (url: unknown) => String(url).includes("/oauth/v2/token");
const upsertCalls = () => fetchMock.mock.calls.filter(([url]) => !isTokenCall(url));
const tokenCalls = () => fetchMock.mock.calls.filter(([url]) => isTokenCall(url));

// Fresh module per test: the access token cache lives in module scope
async function loadZoho() {
  vi.resetModules();
  return import("../services/zoho.service.js");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("upsertDeal", () => {
  it("refreshes a token, then upserts keyed on the purchase-id field", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(upsertOk());
    const { upsertDeal } = await loadZoho();

    expect(await upsertDeal(deal)).toBe("deal_1");

    const [url, init] = upsertCalls()[0]!;
    expect(url).toBe("https://api.zoho.test/crm/v8/Deals/upsert");
    expect(new Headers(init!.headers).get("Authorization")).toBe("Zoho-oauthtoken access-1");
    const body = JSON.parse(String(init!.body));
    expect(body.duplicate_check_fields).toEqual(["Portal_Purchase_ID"]);
    expect(body.data[0]).toMatchObject({
      Portal_Purchase_ID: deal.purchaseId,
      Deal_Name: deal.name,
      Stage: "Closed Won",
      Amount: 499,
      Closing_Date: "2026-10-01",
    });
    // Home currency is left out so orgs without multi-currency accept the Deal
    expect(body.data[0]).not.toHaveProperty("Currency");
  });

  it("sends Currency when it differs from the home currency", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(upsertOk());
    const { upsertDeal } = await loadZoho();

    await upsertDeal({ ...deal, currency: "USD" });
    expect(JSON.parse(String(upsertCalls()[0]![1]!.body)).data[0].Currency).toBe("USD");
  });

  it("reuses the cached token across calls", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(upsertOk()).mockResolvedValueOnce(upsertOk());
    const { upsertDeal } = await loadZoho();

    await upsertDeal(deal);
    await upsertDeal(deal);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("concurrent calls share one token refresh", async () => {
    fetchMock.mockImplementation(async (url) => (isTokenCall(url) ? tokenOk() : upsertOk()));
    const { upsertDeal } = await loadZoho();

    await Promise.all([upsertDeal(deal), upsertDeal(deal), upsertDeal(deal)]);
    expect(tokenCalls()).toHaveLength(1);
  });

  it("on 401 refreshes the token once and retries", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(json({ code: "INVALID_TOKEN" }, 401))
      .mockResolvedValueOnce(json({ access_token: "access-2", expires_in: 3600 }))
      .mockResolvedValueOnce(upsertOk());
    const { upsertDeal } = await loadZoho();

    expect(await upsertDeal(deal)).toBe("deal_1");
    expect(new Headers(upsertCalls()[1]![1]!.headers).get("Authorization")).toBe("Zoho-oauthtoken access-2");
  });

  it("a second 401 fails instead of looping", async () => {
    fetchMock.mockImplementation(async (url) => (isTokenCall(url) ? tokenOk() : json({ code: "INVALID_TOKEN" }, 401)));
    const { upsertDeal, ZohoError } = await loadZoho();

    await expect(upsertDeal(deal)).rejects.toBeInstanceOf(ZohoError);
    expect(upsertCalls()).toHaveLength(2);
  });

  it("token error reported as HTTP 200 → ZohoError", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_client" }));
    const { upsertDeal, ZohoError } = await loadZoho();

    const err = await upsertDeal(deal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoError);
    expect((err as Error).message).toBe("Zoho token refresh failed: invalid_client");
    expect(upsertCalls()).toHaveLength(0);
  });

  it("network failure → ZohoError 'Zoho unreachable'", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { upsertDeal, ZohoError } = await loadZoho();

    const err = await upsertDeal(deal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoError);
    expect((err as Error).message).toMatch(/^Zoho unreachable/);
  });

  it("record-level error (e.g. DUPLICATE_DATA) → ZohoError with Zoho's code", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(json({ data: [{ code: "DUPLICATE_DATA", status: "error", message: "duplicate data" }] }, 202));
    const { upsertDeal } = await loadZoho();

    await expect(upsertDeal(deal)).rejects.toThrow(/DUPLICATE_DATA/);
  });

  it("success without a Deal id → ZohoError", async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(json({ data: [{ status: "success", details: {} }] }));
    const { upsertDeal, ZohoError } = await loadZoho();

    await expect(upsertDeal(deal)).rejects.toBeInstanceOf(ZohoError);
  });
});
