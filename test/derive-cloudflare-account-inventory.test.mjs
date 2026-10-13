import assert from "node:assert/strict";
import test from "node:test";
import { deriveCloudflareAccountInventory } from "../scripts/derive-cloudflare-account-inventory.mjs";

const ACCOUNT_ID = "337e54ee6dc7d488933f473204a6d89e".slice(0, 32);

function jsonResponse(ok, body) {
  return { ok, json: async () => body };
}

function makeFixtureFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/user/tokens/verify")) {
      return jsonResponse(true, { success: true, result: { id: "tok1", status: "active" }, errors: [] });
    }
    if (url.includes("/zones/zoneA/dns_records")) {
      return jsonResponse(true, {
        success: true,
        result: [
          { id: "recA1", type: "A", name: "example.com", content: "1.2.3.4", proxied: true, ttl: 1 },
          { id: "recA2", type: "TXT", name: "example.com", content: "v=spf1", proxied: false, ttl: 300 },
        ],
      });
    }
    if (url.includes("/zones/zoneB/dns_records")) {
      return jsonResponse(true, {
        success: true,
        result: [{ id: "recB1", type: "CNAME", name: "www.example.org", content: "example.org", proxied: true, ttl: 1 }],
      });
    }
    if (new URL(url).pathname.endsWith("/zones")) {
      return jsonResponse(true, {
        success: true,
        result: [
          { id: "zoneA", name: "example.com", status: "active" },
          { id: "zoneB", name: "example.org", status: "active" },
        ],
      });
    }
    if (url.includes("/workers/scripts")) {
      return jsonResponse(true, {
        success: true,
        result: [
          { id: "worker-a", modified_on: "2026-01-01T00:00:00Z" },
          { id: "worker-b", modified_on: "2026-02-01T00:00:00Z" },
        ],
      });
    }
    if (url.includes("/workers/domains")) {
      return jsonResponse(true, {
        success: true,
        result: [{ hostname: "api.example.com", service: "worker-a", zone_name: "example.com" }],
      });
    }
    throw new Error(`unexpected fixture url ${url}`);
  };
  return { fetchImpl, calls };
}

test("derives the inventory record with correct counts over an injected fetch fixture", async () => {
  process.env.CFINV_TEST_TOKEN = "test-token-value";
  try {
    const { fetchImpl } = makeFixtureFetch();
    const result = await deriveCloudflareAccountInventory({
      accountId: ACCOUNT_ID,
      tokenEnvironmentVariable: "CFINV_TEST_TOKEN",
      fetch: fetchImpl,
    });
    assert.equal(result.type, "CloudflareAccountInventory");
    assert.equal(result.version, 1);
    assert.equal(typeof result.observedAt, "string");
    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.tokenStatus, "active");
    assert.equal(result.zones.length, 2);
    assert.equal(result.zones[0].records.length, 2);
    assert.equal(result.zones[1].records.length, 1);
    assert.deepEqual(result.workers, [
      { id: "worker-a", modifiedOn: "2026-01-01T00:00:00Z" },
      { id: "worker-b", modifiedOn: "2026-02-01T00:00:00Z" },
    ]);
    assert.deepEqual(result.customDomains, [{ hostname: "api.example.com", service: "worker-a", zoneName: "example.com" }]);
    assert.deepEqual(result.counts, { zones: 2, records: 3, workers: 2, customDomains: 1 });
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("test-token-value"), false);
  } finally {
    delete process.env.CFINV_TEST_TOKEN;
  }
});

test("refuses TOKEN_ENVIRONMENT_VARIABLE_UNSET when the named environment variable is unset", async () => {
  delete process.env.CFINV_TEST_TOKEN_UNSET;
  const result = await deriveCloudflareAccountInventory({
    accountId: ACCOUNT_ID,
    tokenEnvironmentVariable: "CFINV_TEST_TOKEN_UNSET",
    fetch: async () => {
      throw new Error("must not be called when the token is unset");
    },
  });
  assert.deepEqual(result, {
    type: "CloudflareAccountInventoryRefusal",
    code: "TOKEN_ENVIRONMENT_VARIABLE_UNSET",
    tokenEnvironmentVariable: "CFINV_TEST_TOKEN_UNSET",
  });
});

test("refuses CLOUDFLARE_API_REFUSED when an API body reports success:false", async () => {
  process.env.CFINV_TEST_TOKEN = "test-token-value";
  try {
    const result = await deriveCloudflareAccountInventory({
      accountId: ACCOUNT_ID,
      tokenEnvironmentVariable: "CFINV_TEST_TOKEN",
      fetch: async () => jsonResponse(true, { success: false, result: null, errors: [{ code: 9109, message: "Invalid access token" }] }),
    });
    assert.equal(result.type, "CloudflareAccountInventoryRefusal");
    assert.equal(result.code, "CLOUDFLARE_API_REFUSED");
    assert.equal(result.path, "/user/tokens/verify");
    assert.deepEqual(result.errors, [{ code: 9109, message: "Invalid access token" }]);
  } finally {
    delete process.env.CFINV_TEST_TOKEN;
  }
});

test("refuses a non-object request", async () => {
  await assert.rejects(deriveCloudflareAccountInventory(null), /request must be a JSON object/u);
});

test("refuses a malformed accountId", async () => {
  await assert.rejects(
    deriveCloudflareAccountInventory({ accountId: "not-hex", tokenEnvironmentVariable: "CFINV_TEST_TOKEN" }),
    /32 hexadecimal characters/u,
  );
});

test("refuses an empty tokenEnvironmentVariable", async () => {
  await assert.rejects(
    deriveCloudflareAccountInventory({ accountId: ACCOUNT_ID, tokenEnvironmentVariable: "" }),
    /tokenEnvironmentVariable must be a non-empty string/u,
  );
});

test("scopes zones to the requested account and receives every zone and DNS page", async () => {
  process.env.CFINV_TEST_TOKEN = "test-token-value";
  const seen = [];
  try {
    const result = await deriveCloudflareAccountInventory({
      accountId: ACCOUNT_ID, tokenEnvironmentVariable: "CFINV_TEST_TOKEN",
      fetch: async (url) => {
        const request = new URL(url); seen.push(request);
        const page = Number(request.searchParams.get("page"));
        if (request.pathname.endsWith("/verify")) return jsonResponse(true, { success: true, result: { status: "active" } });
        if (request.pathname.endsWith("/zones")) {
          assert.equal(request.searchParams.get("account.id"), ACCOUNT_ID);
          return jsonResponse(true, { success: true, result: [{ id: `zone${page}`, name: `zone${page}.test`, account: { id: ACCOUNT_ID } }], result_info: { page, total_pages: 2 } });
        }
        if (request.pathname.endsWith("/dns_records")) return jsonResponse(true, { success: true, result: [{ id: `record${page}`, name: "data.test" }], result_info: { page, total_pages: 2 } });
        return jsonResponse(true, { success: true, result: [] });
      }
    });
    assert.deepEqual(result.counts, { zones: 2, records: 4, workers: 0, customDomains: 0 });
    assert.equal(seen.filter(url => url.pathname.endsWith("/dns_records")).length, 4);
  } finally { delete process.env.CFINV_TEST_TOKEN; }
});

test("refuses inconsistent pagination and other-account zones before inventory acceptance", async () => {
  process.env.CFINV_TEST_TOKEN = "test-token-value";
  try {
    for (const [body, code] of [
      [{ result: [{ id: "z" }], result_info: { page: 2, total_pages: 2 } }, "CLOUDFLARE_PAGINATION_INVALID"],
      [{ result: [{ id: "z", account: { id: "0".repeat(32) } }] }, "CLOUDFLARE_ACCOUNT_SCOPE_MISMATCH"],
      [{ result: [{ id: "z", account: { id: 42 } }] }, "CLOUDFLARE_ACCOUNT_SCOPE_MISMATCH"],
      [{ result: null }, "CLOUDFLARE_PAGINATION_INVALID"]
    ]) {
      const result = await deriveCloudflareAccountInventory({
        accountId: ACCOUNT_ID, tokenEnvironmentVariable: "CFINV_TEST_TOKEN",
        fetch: async url => jsonResponse(true, url.includes("/verify") ? { success: true, result: { status: "active" } } : { success: true, ...body })
      });
      assert.equal(result.code, code);
    }
  } finally { delete process.env.CFINV_TEST_TOKEN; }
});

test("refuses repeating records rather than counting a repeated page twice", async () => {
  process.env.CFINV_TEST_TOKEN = "test-token-value";
  try {
    const result = await deriveCloudflareAccountInventory({
      accountId: ACCOUNT_ID, tokenEnvironmentVariable: "CFINV_TEST_TOKEN",
      fetch: async url => {
        const request = new URL(url);
        if (request.pathname.endsWith("/verify")) return jsonResponse(true, { success: true, result: { status: "active" } });
        return jsonResponse(true, { success: true, result: [{ id: "repeated-zone" }], result_info: { page: Number(request.searchParams.get("page")), total_pages: 2 } });
      }
    });
    assert.equal(result.code, "CLOUDFLARE_PAGINATION_INVALID");
  } finally { delete process.env.CFINV_TEST_TOKEN; }
});
