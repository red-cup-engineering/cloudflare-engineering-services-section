#!/usr/bin/env node
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";
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

// List endpoints must finish their advertised page set before claiming coverage.
// Missing pagination metadata is accepted only for a short final page.
async function cloudflareList(fetchImpl, token, path, perPage, identity) {
  const values = [];
  const seen = new Set();
  for (let page = 1; page <= 1000; page += 1) {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    query.set("per_page", String(perPage));
    query.set("page", String(page));
    const response = await cloudflareGet(fetchImpl, token, `${path.split("?")[0]}?${query}`);
    if (!response.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: response.path, errors: response.body?.errors ?? [] });
    const items = response.body?.result;
    const info = response.body?.result_info;
    if (!Array.isArray(items) || (info?.page !== undefined && info.page !== page)) {
      return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
    }
    for (const item of items) {
      const id = identity(item);
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
        return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
      }
      seen.add(id);
      values.push(item);
    }
    const totalPages = info?.total_pages;
    if (totalPages !== undefined) {
      if (!Number.isSafeInteger(totalPages) || totalPages < 0 || totalPages > 1000 ||
          (totalPages < page && !(page === 1 && totalPages === 0 && items.length === 0)) ||
          (items.length === 0 && page < totalPages)) {
        return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
      }
      if (page >= totalPages) return { values };
    } else if (items.length < perPage) {
      return { values };
    }
  }
  return refusal("CLOUDFLARE_PAGINATION_LIMIT", { path });
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

  const zonesResponse = await cloudflareList(fetchImpl, token, `/zones?account.id=${accountId}`, 50, zone => zone?.id);
  if (zonesResponse.type) return zonesResponse;
  const rawZones = zonesResponse.values;
  if (rawZones.some(zone => zone.account?.id !== undefined && (typeof zone.account.id !== "string" || zone.account.id.toLowerCase() !== accountId.toLowerCase()))) {
    return refusal("CLOUDFLARE_ACCOUNT_SCOPE_MISMATCH", { accountId });
  }

  const zones = [];
  let recordCount = 0;
  for (const zone of rawZones) {
    const recordsResponse = await cloudflareList(fetchImpl, token, `/zones/${zone.id}/dns_records`, 500, record => record?.id);
    if (recordsResponse.type) return recordsResponse;
    const records = recordsResponse.values.map(mapDnsRecord);
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
  const result = await runJavascriptNodeOperation({ name: "derive-cloudflare-account-inventory", description: "Derives one CloudflareAccountInventory record -- zones, their DNS records, Workers scripts, and Workers custom domains -- for one Cloudflare account, reading the API token from the named environment variable and refusing rather than throwing on an unset token or a non-success API body.", operation: deriveCloudflareAccountInventory }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
