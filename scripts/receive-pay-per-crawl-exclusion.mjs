import { derivePayPerCrawlExclusion } from "./derive-pay-per-crawl-exclusion.mjs";

const API = "https://api.cloudflare.com/client/v4";
const ZONE = /^[a-fA-F0-9]{32}$/u;
const RULE = /^[a-fA-F0-9]{32}$/u;

async function readJson(fetchImpl, url, token, options = {}, { allowMissingPhase = false } = {}) {
  const response = await fetchImpl(url, {
    ...options, redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  // Only an explicit 404 from the caller's exact phase entrypoint can mean
  // no zone-level configuration ruleset exists. No other resource permits this
  // interpretation; access-denied, network and malformed responses still fail.
  if (allowMissingPhase && response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare rule receiving refused: HTTP ${response.status}`);
  const data = await response.json();
  if (data?.success !== true || !data.result || !Array.isArray(data.errors)) {
    throw new TypeError("Cloudflare ruleset response must carry a successful structured result");
  }
  return data.result;
}

function sameRule(actual, expected) {
  return actual?.ref === expected.ref && actual?.action === expected.action &&
    actual?.expression === expected.expression && actual?.enabled === true &&
    actual?.description === expected.description &&
    actual?.action_parameters?.disable_pay_per_crawl === true &&
    Object.keys(actual.action_parameters ?? {}).length === 1;
}

function stage(result, candidate, zoneId, zoneName, status) {
  return Object.freeze({
    type: "CloudflarePayPerCrawlExclusionReceiving",
    origin: candidate.origin, zoneId, zoneName, status,
    phase: candidate.phase,
    source: candidate.source,
    catalogOfferCount: candidate.catalogOfferCount,
    ruleRef: candidate.rule.ref,
    rulesetId: result.id, rulesetVersion: result.version ?? null,
    ruleId: result.rules.find(row => row.ref === candidate.rule.ref)?.id ?? null,
    // The rule receiving does not itself enable charging or validate payouts.
    ppcChargingEnabled: "unassayed",
    ppcPayoutReceived: false,
  });
}

/** 
 * Operate one configured zone's *existing* ruleset, never PUT it wholesale.
 * Inputs come directly from the existing seller catalog and pure rule compiler.
 * The caller supplies already scoped Cloudflare credentials through the house
 * token manager; no token is printed or persisted, and dryRun is read-only.
 */
export async function receivePayPerCrawlExclusion({
  origin, catalog, apiPrefix, freePaths,
  zoneId, zoneName, token, apply = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const candidate = derivePayPerCrawlExclusion({ origin, catalog, apiPrefix, freePaths });
  if (!ZONE.test(zoneId ?? "") || typeof zoneName !== "string" ||
      zoneName !== zoneName.toLowerCase() || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(zoneName) ||
      typeof token !== "string" || token.trim() === "" || typeof fetchImpl !== "function") {
    throw new TypeError("Cloudflare receiving requires explicit zone identity, scoped token and HTTP reader");
  }
  const host = new URL(origin).hostname;
  if (host !== zoneName && !host.endsWith(`.${zoneName}`)) {
    throw new TypeError("market hostname is outside the admitted Cloudflare zone");
  }
  if (apply !== true && apply !== false) throw new TypeError("apply must be an explicit boolean");
  const path = `${API}/zones/${zoneId}`;
  const zone = await readJson(fetchImpl, path, token);
  if (zone.id !== zoneId || zone.name !== zoneName) {
    throw new TypeError("Cloudflare zone identifier and zone name disagree with owner authority");
  }
  const entry = `${path}/rulesets/phases/http_config_settings/entrypoint`;
  const before = await readJson(fetchImpl, entry, token, {}, { allowMissingPhase: true });
  if (before === null) {
    // Cloudflare's Rulesets API officially supports creating a zone phase
    // entrypoint with POST /zones/{id}/rulesets, kind:"zone", phase. This
    // is the only missing-phase mutation: never PUT a whole existing ruleset.
    if (!apply) return stage({ id: null, version: null, rules: [] }, candidate,
      zoneId, zoneName, "phase-create-required");
    await readJson(fetchImpl, `${path}/rulesets`, token, {
      method: "POST",
      body: JSON.stringify({
        name: "561 Group agent API crawl exclusions",
        kind: "zone", phase: "http_config_settings",
        rules: [candidate.rule],
      }),
    });
    const installed = await readJson(fetchImpl, entry, token);
    const matching = installed.rules?.filter(row => row.ref === candidate.rule.ref);
    if (!RULE.test(installed.id ?? "") ||
        installed.phase !== "http_config_settings" ||
        !Array.isArray(installed.rules) || matching?.length !== 1 ||
        !sameRule(matching[0], candidate.rule)) {
      throw new Error("Cloudflare newly created configuration phase failed independent readback");
    }
    return stage(installed, candidate, zoneId, zoneName, "received");
  }
  if (!RULE.test(before.id ?? "") || before.phase !== "http_config_settings" ||
      !Array.isArray(before.rules)) {
    throw new TypeError("Cloudflare existing configuration ruleset is not an admitted phase");
  }
  const found = before.rules.filter(row => row.ref === candidate.rule.ref);
  if (found.length > 1) throw new TypeError("Cloudflare already has duplicate house PPC exclusion rules");
  if (found.length === 1 && sameRule(found[0], candidate.rule)) {
    return stage(before, candidate, zoneId, zoneName, "received");
  }
  if (!apply) return stage(before, candidate, zoneId, zoneName, "change-required");
  if (found.length && !RULE.test(found[0].id ?? "")) {
    throw new TypeError("existing Cloudflare exclusion rule lacks an exact rule identity");
  }
  const rulePath = `${path}/rulesets/${before.id}/rules${found.length ? "/"+found[0].id : ""}`;
  await readJson(fetchImpl, rulePath, token, {
    method: found.length ? "PATCH" : "POST",
    body: JSON.stringify(candidate.rule),
  });
  // A successful provider write response is not independent receiving.
  // Read the current phase back, refusing missing, divergent or duplicate rules.
  const after = await readJson(fetchImpl, entry, token);
  const matching = after.rules?.filter(row => row.ref === candidate.rule.ref);
  if (!Array.isArray(matching) || matching.length !== 1 ||
      !sameRule(matching[0], candidate.rule)) {
    throw new Error("Cloudflare installed PPC exclusion did not pass independent ruleset readback");
  }
  return stage(after, candidate, zoneId, zoneName, "received");
}
