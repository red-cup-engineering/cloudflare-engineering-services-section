# derive-cloudflare-account-inventory
## Requirements
- `reads-token-from-environment`: The operation reads the Cloudflare API token from `process.env[request.tokenEnvironmentVariable]`; it never accepts a token directly in the request.
- `verifies-token`: The operation calls Cloudflare v4 `GET /user/tokens/verify` with the token as a Bearer credential and carries the verification result's `status` forward as the returned record's `tokenStatus`.
- `lists-zones-and-records`: The operation calls `GET /zones?per_page=50`, then for each returned zone calls `GET /zones/{id}/dns_records?per_page=500`, and reports each zone as `{id, name, status, records: [{type, name, content, proxied, ttl, id}]}`.
- `lists-workers-and-domains`: The operation calls `GET /accounts/{accountId}/workers/scripts`, reporting each as `{id, modifiedOn}`, and `GET /accounts/{accountId}/workers/domains`, reporting each as `{hostname, service, zoneName}`.
- `returns-typed-inventory-record`: The operation assembles a `CloudflareAccountInventory` record: `{type, version: 1, observedAt (ISO string), accountId, tokenStatus, zones, workers, customDomains, counts: {zones, records, workers, customDomains}}`, where `counts.records` is the sum of every zone's record count.
- `refuses-non-success-api-body`: Whenever a Cloudflare API call responds with a non-2xx HTTP status or a JSON body whose `success` field is not `true`, the operation returns a refusal datum `{type: "CloudflareAccountInventoryRefusal", code: "CLOUDFLARE_API_REFUSED", path, errors}` carrying the request path and the body's own `errors` array, and performs no further API calls.
- `injectable-network-call`: The operation accepts an injectable `request.fetch`, defaulting to the global `fetch`, so tests and fixtures never require a live Cloudflare account.
## Prohibitions
- `never-discloses-the-token`: The operation must never place the token's value in its returned record, a refusal datum, or a thrown error; only the caller-supplied `tokenEnvironmentVariable` name (never the credential it names) may appear in a refusal. [claims: a-secret-is-not-echoed]
- `refuses-non-object-request`: The operation must refuse (throw `TypeError`) a `request` that is not a JSON object. [claims: malformed-input-outside-domain]
- `refuses-malformed-account-id`: The operation must refuse (throw `TypeError`) an `accountId` that is not exactly {{account-id-length}} hexadecimal characters. [claims: account-id-length]
- `refuses-empty-token-environment-variable-name`: The operation must refuse (throw `TypeError`) a `tokenEnvironmentVariable` that is not a non-empty string. [claims: malformed-input-outside-domain]
- `unset-token-is-a-refusal-not-a-throw`: An unset or empty environment variable named by `tokenEnvironmentVariable` produces the returned refusal datum `{type: "CloudflareAccountInventoryRefusal", code: "TOKEN_ENVIRONMENT_VARIABLE_UNSET", tokenEnvironmentVariable}`, never a thrown error -- this is an expected account state, not a malformed call. [claims: unset-variable-is-an-account-state]
- `no-live-calls-in-tests`: This package's own tests must never perform a real network call; every path is exercised through an injected fixture `fetch`. [claims: a-live-call-reads-a-real-account]
## Laws
- `handwritten-state-surveys-are-the-debt` | 561 Group working discipline | 2026-08-31 | .claude/rules/working-discipline.md | Applies to this operation's whole purpose. | "A reading of org state is derived on demand by tools that compute it, never authored as another prose/JSON snapshot" -- this operation is that deriving tool for the org's Cloudflare account state, replacing a pasted survey.
- `fabricate-do-not-hand-write` | 561 Group working discipline, dispatch-agents skill | 2026-09-04 | .claude/skills/dispatch-agents/SKILL.md | Applies to this operation's own birth. | The operation is fabricated through the jsnode fabrication line from this work order, never hand-written.
- `primitives-exist-once` | 561 Group working discipline | 2026-08-30 | CLAUDE.md | Applies to every Cloudflare account fact this operation reads. | The org's Cloudflare zones, DNS records, Workers scripts, and Workers custom domains are read once, here, by one operation the rest of the tree composes rather than re-querying by hand.
## Standards
- `node-esm-operation` | Node.js | v24.2.0+ | https://nodejs.org/docs/v24/api/esm.html | Applies to the .mjs operation, its import.meta.main guard, and downstream package-birth assays. | The package uses one executable ESM operation source file that is eligible for downstream staged package-birth assays.
- `whatwg-fetch-standard` | WHATWG | Living Standard | https://fetch.spec.whatwg.org/ | Applies to every injectable network call this operation makes. | The operation uses the Fetch API contract for its HTTP calls, real by default via the global fetch and injectable for deterministic tests.
- `cloudflare-api-v4` | Cloudflare | v4 | https://developers.cloudflare.com/api/ | Applies to every API path this operation calls (`/user/tokens/verify`, `/zones`, `/zones/{id}/dns_records`, `/accounts/{accountId}/workers/scripts`, `/accounts/{accountId}/workers/domains`). | The v4 REST API documents a JSON envelope with its own `success`/`result`/`errors` fields independent of HTTP status; this operation treats that envelope's `success` field, not only the HTTP status, as the truth of a response.
## Open questions
- `pagination-limited-to-first-page` [nonblocking]: `/zones?per_page=50` and `/zones/{id}/dns_records?per_page=500` read only their first page; an account carrying more than 50 zones or more than 500 records in one zone needs a follow-up cursor-following revision.
## Claims
- `malformed-input-outside-domain` | derived | world | A request or field not of its declared type lies outside the operation's input domain | none | constraint:node-esm-operation; citation:Red Cup reconcile-typed-boundaries skill, a boundary admits only its declared type | Refusing an out-of-domain input is the typed boundary's own behavior, not a further choice
- `account-id-length` | derived | parameter | A Cloudflare account identifier is a thirty-two character hexadecimal string | 32 characters | constraint:cloudflare-api-v4 | The v4 API addresses an account by its identifier, a 128-bit value written as thirty-two hexadecimal characters
- `a-secret-is-not-echoed` | derived | world | A credential read from the environment is used to call the API and appears in no record, refusal or error the operation returns | none | requirement:reads-token-from-environment; citation:561 Group working discipline, credentials are never disclosed in outputs | The requirement keeps the token inside the request to the API, and the working discipline forbids any output that carries it
- `unset-variable-is-an-account-state` | derived | world | An unset or empty environment variable is a state of the account's environment that the operation is built to meet, not a malformed call | none | requirement:reads-token-from-environment | The requirement reads the token from the named variable, which the environment may legitimately not hold
- `a-live-call-reads-a-real-account` | derived | world | A live call to the Cloudflare API reads a real account with a real token | none | requirement:injectable-network-call; constraint:whatwg-fetch-standard | The requirement makes the fetch injectable so that tests never need a live call, and the fetch contract carries the call to the real API
## Package
```json
{"packageName":"@red-cup-engineering/derive-cloudflare-account-inventory-service","packageVersion":"0.1.0","license":"MIT","dependencies":{},"devDependencies":{}}
```
## Operation
```mjs path=scripts/derive-cloudflare-account-inventory.mjs
#!/usr/bin/env node
const API_BASE = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`derive-cloudflare-account-inventory: ${label} must be a JSON object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`derive-cloudflare-account-inventory: ${label} must be a non-empty string`);
  }
  return value;
}

const refusal = (code, detail) => ({ type: "CloudflareAccountInventoryRefusal", code, ...detail });

async function cloudflareGet(fetchImpl, token, path) {
  const response = await fetchImpl(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  return { ok: response.ok === true && body?.success === true, body, path };
}

function mapDnsRecord(record) {
  return { type: record.type, name: record.name, content: record.content, proxied: record.proxied === true, ttl: record.ttl, id: record.id };
}

function mapWorkerScript(script) {
  return { id: script.id, modifiedOn: script.modified_on ?? script.modifiedOn ?? null };
}

function mapCustomDomain(domain) {
  return { hostname: domain.hostname, service: domain.service, zoneName: domain.zone_name ?? domain.zoneName ?? null };
}

/**
 * Derives one CloudflareAccountInventory record -- zones, their DNS records, Workers scripts, and Workers custom domains -- for one Cloudflare account, reading the API token from the named environment variable and refusing rather than throwing on an unset token or a non-success API body.
 * @param {object} request A DeriveCloudflareAccountInventoryRequest.
 * @param {string} request.accountId The Cloudflare account id, exactly 32 hexadecimal characters.
 * @param {string} request.tokenEnvironmentVariable The name of the environment variable holding the Cloudflare API token (e.g. "CLOUDFLARE_API_TOKEN"); the token itself is read from `process.env`, never accepted directly.
 * @param {typeof fetch} [request.fetch] An injectable fetch implementation, defaulting to the global fetch, for deterministic tests.
 * @returns {Promise<object>} A CloudflareAccountInventory record on success, or a CloudflareAccountInventoryRefusal datum carrying code `TOKEN_ENVIRONMENT_VARIABLE_UNSET` or `CLOUDFLARE_API_REFUSED`.
 * @throws {TypeError} When `request` is not a JSON object, `request.accountId` is not 32 hexadecimal characters, or `request.tokenEnvironmentVariable` is not a non-empty string.
 */
export async function deriveCloudflareAccountInventory(request) {
  requireObject(request, "request");
  const accountId = requireNonEmptyString(request.accountId, "request.accountId");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new TypeError("derive-cloudflare-account-inventory: request.accountId must be exactly 32 hexadecimal characters");
  }
  const tokenEnvironmentVariable = requireNonEmptyString(request.tokenEnvironmentVariable, "request.tokenEnvironmentVariable");
  const fetchImpl = request.fetch ?? fetch;

  const token = process.env[tokenEnvironmentVariable];
  if (typeof token !== "string" || token.length === 0) {
    return refusal("TOKEN_ENVIRONMENT_VARIABLE_UNSET", { tokenEnvironmentVariable });
  }

  const verify = await cloudflareGet(fetchImpl, token, "/user/tokens/verify");
  if (!verify.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: verify.path, errors: verify.body?.errors ?? [] });
  const tokenStatus = verify.body.result?.status ?? null;

  const zonesResponse = await cloudflareGet(fetchImpl, token, "/zones?per_page=50");
  if (!zonesResponse.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: zonesResponse.path, errors: zonesResponse.body?.errors ?? [] });
  const rawZones = Array.isArray(zonesResponse.body.result) ? zonesResponse.body.result : [];

  const zones = [];
  let recordCount = 0;
  for (const zone of rawZones) {
    const recordsResponse = await cloudflareGet(fetchImpl, token, `/zones/${zone.id}/dns_records?per_page=500`);
    if (!recordsResponse.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: recordsResponse.path, errors: recordsResponse.body?.errors ?? [] });
    const records = (Array.isArray(recordsResponse.body.result) ? recordsResponse.body.result : []).map(mapDnsRecord);
    recordCount += records.length;
    zones.push({ id: zone.id, name: zone.name, status: zone.status, records });
  }

  const workersResponse = await cloudflareGet(fetchImpl, token, `/accounts/${accountId}/workers/scripts`);
  if (!workersResponse.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: workersResponse.path, errors: workersResponse.body?.errors ?? [] });
  const workers = (Array.isArray(workersResponse.body.result) ? workersResponse.body.result : []).map(mapWorkerScript);

  const domainsResponse = await cloudflareGet(fetchImpl, token, `/accounts/${accountId}/workers/domains`);
  if (!domainsResponse.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: domainsResponse.path, errors: domainsResponse.body?.errors ?? [] });
  const customDomains = (Array.isArray(domainsResponse.body.result) ? domainsResponse.body.result : []).map(mapCustomDomain);

  return Object.freeze({
    type: "CloudflareAccountInventory",
    version: 1,
    observedAt: new Date().toISOString(),
    accountId,
    tokenStatus,
    zones,
    workers,
    customDomains,
    counts: { zones: zones.length, records: recordCount, workers: workers.length, customDomains: customDomains.length },
  });
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "deriveCloudflareAccountInventory — Derives one CloudflareAccountInventory record -- zones, their DNS records, Workers scripts, and Workers custom domains -- for one Cloudflare account, reading the API token from the named environment variable and refusing rather than throwing on an unset token or a non-success API body.\n",
    );
  } else {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    for (const line of text.split("\n")) {
      if (line.length > 0) process.stdout.write(`${JSON.stringify(await deriveCloudflareAccountInventory(JSON.parse(line)))}\n`);
    }
  }
}
```
## Tests
```mjs path=test/derive-cloudflare-account-inventory.test.mjs
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
```
## Examples
```json name="refuses TOKEN_ENVIRONMENT_VARIABLE_UNSET when the named environment variable is unset"
{"input":{"accountId":"337e54ee6dc7d488933f473204a6d89e","tokenEnvironmentVariable":"CLOUDFLARE_API_TOKEN_UNSET_EXAMPLE"},"output":{"type":"CloudflareAccountInventoryRefusal","code":"TOKEN_ENVIRONMENT_VARIABLE_UNSET","tokenEnvironmentVariable":"CLOUDFLARE_API_TOKEN_UNSET_EXAMPLE"}}
```
## Traceability
- `reads-token-from-environment` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `handwritten-state-surveys-are-the-debt`
- `verifies-token` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `cloudflare-api-v4`
- `lists-zones-and-records` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `cloudflare-api-v4`, `primitives-exist-once`
- `lists-workers-and-domains` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `cloudflare-api-v4`, `primitives-exist-once`
- `returns-typed-inventory-record` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `handwritten-state-surveys-are-the-debt`
- `refuses-non-success-api-body` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `cloudflare-api-v4`
- `injectable-network-call` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `whatwg-fetch-standard`, `node-esm-operation`
- `never-discloses-the-token` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `handwritten-state-surveys-are-the-debt`
- `refuses-non-object-request` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `node-esm-operation`
- `refuses-malformed-account-id` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `cloudflare-api-v4`
- `refuses-empty-token-environment-variable-name` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `node-esm-operation`
- `unset-token-is-a-refusal-not-a-throw` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `handwritten-state-surveys-are-the-debt`
- `no-live-calls-in-tests` -> projection `jsnode-operation-package`; acceptance `jsnode-package-assays`; constraints `whatwg-fetch-standard`
