/**
 * Compile one source-bound Cloudflare Configuration Rule that exempts a site's
 * functional x402/agent endpoints from Pay Per Crawl. This is a pure projection,
 * not zone activation, merchant custody, customer permission, or a second catalog.
 *
 * The caller supplies the seller's existing marketCatalogReadout (source of
 * routes), and explicit site policy (API prefix and public navigation routes).
 * A new payable route outside the nominated prefix fails source receiving.
 * Cloudflare Rulesets API: phase http_config_settings, set_config with
 * disable_pay_per_crawl: true. Never PUT the whole ruleset from this library.
 */
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~!$&'()+,;=:@%-]+\/?)*$/u;

function path(value, label) {
  if (typeof value !== "string" || value.length > 200 || !SAFE_PATH.test(value)
      || value.includes("//") || value.includes("/../") || value.includes("/./")) {
    throw new TypeError(label + " must be one unambiguous, bounded URI path");
  }
  return value;
}
function quoted(value) {
  // Inputs are ASCII names/paths under strict validation, so no Cloudflare
  // expression escape sequence or user-supplied predicate can enter this rule.
  return JSON.stringify(value);
}

/**
 * @param {object} input
 * @param {string} input.origin Exact HTTPS site origin.
 * @param {object} input.catalog The existing marketCatalogReadout, not a clone.
 * @param {string} input.apiPrefix Site-owned prefix containing EVERY x402 route.
 * @param {string[]} input.freePaths Additional existing discovery/navigation paths,
 *   with trailing slash meaning the complete prefix; no wildcard grammar.
 */
export function derivePayPerCrawlExclusion({
  origin, catalog, apiPrefix, freePaths = [],
} = {}) {
  if (typeof origin !== "string" || !HTTPS_ORIGIN.test(origin)) {
    throw new TypeError("Pay Per Crawl requires one exact public HTTPS origin without credentials, query, or port");
  }
  if (!catalog || catalog.market !== origin || !Array.isArray(catalog.offers)
      || catalog.offers.length < 1 || catalog.offers.length > 5000) {
    throw new TypeError("the exclusion must consume the one existing admitted seller catalog and its origin");
  }
  const prefix = path(apiPrefix, "apiPrefix");
  if (prefix === "/" || !prefix.endsWith("/")) {
    throw new TypeError("the site API prefix must be bounded and narrower than the root");
  }
  if (!Array.isArray(freePaths) || freePaths.length > 32) {
    throw new TypeError("freePaths must be a bounded set of site-owned routes");
  }
  for (const offer of catalog.offers) {
    if (typeof offer?.route !== "string" || !offer.route.startsWith(prefix) ||
        typeof offer.url !== "string" || !offer.url.startsWith(origin + offer.route) ||
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(offer.method)) {
      throw new TypeError("every x402 route must be covered by the admitted API exclusion prefix and merchant origin");
    }
  }
  const extra = [...new Set(freePaths.map(value => path(value, "free route")))].sort();
  const predicates = [
    `starts_with(http.request.uri.path, ${quoted(prefix)})`,
    ...extra.map(item => item.endsWith("/") && item !== "/"
      ? `starts_with(http.request.uri.path, ${quoted(item)})`
      : `http.request.uri.path eq ${quoted(item)}`),
  ];
  const host = origin.slice("https://".length);
  const rule = Object.freeze({
    ref: "x402_free_" + host.replaceAll(".", "_"),
    description: "Avoid Pay Per Crawl double charging on admitted APIs, discovery and navigation",
    expression: `(http.host eq ${quoted(host)} and (${predicates.join(" or ")}))`,
    action: "set_config",
    action_parameters: Object.freeze({ disable_pay_per_crawl: true }),
    enabled: true,
  });
  return Object.freeze({
    type: "CloudflarePayPerCrawlExclusionCandidate",
    phase: "http_config_settings",
    origin, catalogOfferCount: catalog.offers.length,
    source: "marketCatalogReadout",
    rule,
    providerInstalled: false,
    independentlyReceived: false,
  });
}
