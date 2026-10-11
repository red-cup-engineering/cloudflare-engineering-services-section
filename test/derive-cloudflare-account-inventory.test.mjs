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
    if (url.includes("/zones?per_page=50")) {
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
