import assert from "node:assert/strict";
import test from "node:test";
import { derivePayPerCrawlExclusion } from "../scripts/derive-pay-per-crawl-exclusion.mjs";

const origin = "https://market.561.group";
const catalog = { market: origin, offers: [
  { method: "GET", route: "/v1/astronomy/positions/{date}", url: origin + "/v1/astronomy/positions/{date}" },
  { method: "POST", route: "/v1/sen/articulate", url: origin + "/v1/sen/articulate" },
  { method: "GET", route: "/v1/weather/nws-metar/{station}", url: origin + "/v1/weather/nws-metar/{station}", listed: false },
] };
const freePaths = ["/mcp", "/openapi.json", "/llms.txt", "/.well-known/", "/", "/healthz"];

test("one market projection yields the documented Cloudflare free-API rule", () => {
  const outcome = derivePayPerCrawlExclusion({ origin, catalog, apiPrefix: "/v1/", freePaths });
  assert.equal(outcome.type, "CloudflarePayPerCrawlExclusionCandidate");
  assert.equal(outcome.phase, "http_config_settings");
  assert.equal(outcome.source, "marketCatalogReadout");
  assert.equal(outcome.catalogOfferCount, 3);
  assert.equal(outcome.providerInstalled, false);
  assert.equal(outcome.independentlyReceived, false);
  assert.equal(outcome.rule.action, "set_config");
  assert.deepEqual(outcome.rule.action_parameters, { disable_pay_per_crawl: true });
  assert.match(outcome.rule.expression, /http.host eq "market\.561\.group"/u);
  assert.match(outcome.rule.expression, /starts_with\(http.request.uri.path, "\/v1\/"\)/u);
  assert.match(outcome.rule.expression, /http.request.uri.path eq "\/mcp"/u);
  assert.match(outcome.rule.expression, /starts_with\(http.request.uri.path, "\/\.well-known\/"\)/u);
  assert.match(outcome.rule.expression, /http.request.uri.path eq "\/"/u);
  assert.ok(!outcome.rule.expression.includes("payment-signature"));
  assert.deepEqual(derivePayPerCrawlExclusion({ origin, catalog, apiPrefix: "/v1/", freePaths: [...freePaths].reverse() }), outcome);
});

test("a newly marketed x402 route cannot evade the free-crawl prefix unnoticed", () => {
  const newRoot = { ...catalog, offers: [...catalog.offers, {
    method: "GET", route: "/paid-other-system", url: origin + "/paid-other-system"
  }] };
  assert.throws(() => derivePayPerCrawlExclusion({origin,catalog:newRoot,apiPrefix:"/v1/",freePaths}),/covered/u);
});

test("only one exact HTTPS site, owned paths and real seller rows enter the expression", () => {
  for(const untrusted of [
    {origin:"http://market.561.group"},
    {origin:"https://evil.example/mcp"},
    {origin:"https://user:secret@market.561.group"},
    {apiPrefix:"/"},
    {apiPrefix:"/v1/../"},
    {freePaths:["/mcp", "/mcp\" or true or \""]},
    {freePaths:["/mcp", "//unstable"]},
    {catalog:{...catalog,market:"https://unrelated.example"}},
    {catalog:{...catalog,offers:[{...catalog.offers[0],url:"https://other.example/v1/astronomy/positions/{date}"}]}},
  ]) {
    assert.throws(() => derivePayPerCrawlExclusion({origin,catalog,apiPrefix:"/v1/",freePaths,...untrusted}), TypeError);
  }
});

test("nonmarket science properties use the same exclusion compiler without inventing a merchant", () => {
  const site = { origin: "https://science.561.group",
    freePaths: ["/", "/search", "/.well-known/", "/api/"] };
  const result = derivePayPerCrawlExclusion(site);
  assert.equal(result.type, "CloudflarePayPerCrawlExclusionCandidate");
  assert.equal(result.source, "site-owned-free-route-policy");
  assert.equal(result.catalogOfferCount, 0);
  assert.equal(result.rule.ref, "ppc_free_science_561_group");
  assert.equal(result.rule.action, "set_config");
  assert.deepEqual(result.rule.action_parameters, { disable_pay_per_crawl: true });
  assert.match(result.rule.expression, /http\.host eq "science\.561\.group"/u);
  assert.match(result.rule.expression, /starts_with\(http\.request\.uri\.path, "\/api\/"\)/u);
  assert.match(result.rule.expression, /http\.request\.uri\.path eq "\/search"/u);
  assert.ok(!result.rule.expression.includes("/v1/"));
  assert.deepEqual(derivePayPerCrawlExclusion({
    ...site, freePaths: [...site.freePaths].reverse(),
  }), result, "same policy gives one deterministic rule");
  assert.equal(result.providerInstalled, false);
  assert.equal(result.independentlyReceived, false);
});

test("nonmarket site policy must be explicit and cannot smuggle a fabricated seller or unsafe path", () => {
  const site = { origin: "https://engineering.561.group", freePaths: ["/"] };
  for (const bad of [
    { freePaths: [] },
    { apiPrefix: "/v1/" },
    { catalog: {market: site.origin, offers: []}, apiPrefix: "/v1/" },
    { freePaths: ["/", "//evil"] },
    { freePaths: ["/", "/api/../private"] },
    { freePaths: ["/", "/mcp\" or true or \""] },
    { origin: "http://engineering.561.group" },
    { origin: "https://user:password@engineering.561.group" },
  ]) {
    assert.throws(() => derivePayPerCrawlExclusion({...site, ...bad}), TypeError);
  }
});
