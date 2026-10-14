/**
 * Compile one source-bound Cloudflare Configuration Rule that exempts a site's
 * functional APIs and navigation from Pay Per Crawl. This is a pure projection,
 * not zone activation, merchant custody, customer permission, or a second catalog.
 *
 * A merchant supplies its existing marketCatalogReadout and a covering API
 * prefix: an admitted paid route must never escape that protection. An ordinary
 * publication, science or organizational site instead supplies only its
 * actual source-owned free paths, without fabricating an empty seller catalog.
 * The rule covers only paths the caller can justify; it does not activate PPC.
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
 * @param {object} [input.catalog] Existing marketCatalogReadout, when a seller.
 * @param {string} [input.apiPrefix] Required only for a seller; covers EVERY x402 route.
 * @param {string[]} input.freePaths Source-owned discovery/navigation/functional paths,
 *   with trailing slash meaning the complete prefix; no wildcard grammar.
 */
export function derivePayPerCrawlExclusion({
  origin, catalog, apiPrefix, freePaths = [],
} = {}) {
  if (typeof origin !== "string" || !HTTPS_ORIGIN.test(origin)) {
    throw new TypeError("Pay Per Crawl requires one exact public HTTPS origin without credentials, query, or port");
  }
  const seller = catalog !== undefined;
  if (seller && (catalog === null || catalog.market !== origin ||
      !Array.isArray(catalog.offers) || catalog.offers.length < 1 ||
      catalog.offers.length > 5000)) {
    throw new TypeError("the exclusion must consume the one existing admitted seller catalog and its origin");
  }
  if (!seller && apiPrefix !== undefined) {
    throw new TypeError("an API prefix requires the actual seller catalog, not a fabricated market");
  }
  const prefix = seller ? path(apiPrefix, "apiPrefix") : undefined;
  if (seller && (prefix === "/" || !prefix.endsWith("/"))) {
    throw new TypeError("the site API prefix must be bounded and narrower than the root");
  }
  if (!Array.isArray(freePaths) || freePaths.length > 32 ||
      (!seller && freePaths.length === 0)) {
    throw new TypeError("freePaths must be a bounded nonempty set for a nonmarket site");
  }
  for (const offer of seller ? catalog.offers : []) {
    if (typeof offer?.route !== "string" || !offer.route.startsWith(prefix) ||
        typeof offer.url !== "string" || !offer.url.startsWith(origin + offer.route) ||
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(offer.method)) {
      throw new TypeError("every x402 route must be covered by the admitted API exclusion prefix and merchant origin");
    }
  }
  const extra = [...new Set(freePaths.map(value => path(value, "free route")))].sort();
  const predicates = [
    ...(seller ? [`starts_with(http.request.uri.path, ${quoted(prefix)})`] : []),
    ...extra.map(item => item.endsWith("/") && item !== "/"
      ? `starts_with(http.request.uri.path, ${quoted(item)})`
      : `http.request.uri.path eq ${quoted(item)}`),
  ];
  const host = origin.slice("https://".length);
  const rule = Object.freeze({
    ref: (seller ? "x402_free_" : "ppc_free_") + host.replaceAll(".", "_"),
    description: seller
      ? "Avoid Pay Per Crawl double charging on admitted APIs, discovery and navigation"
      : "Preserve source-owned free navigation and functional routes during paid crawling",
    expression: `(http.host eq ${quoted(host)} and (${predicates.join(" or ")}))`,
    action: "set_config",
    action_parameters: Object.freeze({ disable_pay_per_crawl: true }),
    enabled: true,
  });
  return Object.freeze({
    type: "CloudflarePayPerCrawlExclusionCandidate",
    phase: "http_config_settings",
    origin, catalogOfferCount: seller ? catalog.offers.length : 0,
    source: seller ? "marketCatalogReadout" : "site-owned-free-route-policy",
    rule,
    providerInstalled: false,
    independentlyReceived: false,
  });
}
