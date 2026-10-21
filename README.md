# Cloudflare Services Section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

## Scoped maintenance credentials

`scripts/with-cloudflare-token.mjs` runs a trusted command with an account-owned
API token created for that job. Keep `CLOUDFLARE_ACCOUNT_TOKEN_MANAGER` and
`CLOUDFLARE_ACCOUNT_ID` in the private local `.env` or the management process's
environment. The manager requires Account API Tokens Write for this account.
The command resolves permission IDs from Cloudflare, issues a token valid for
at most 60 minutes, passes it as `CLOUDFLARE_API_TOKEN`, and revokes it when the
child exits, including failure or a forwarded SIGINT/SIGTERM. A failed cleanup
is an error; expiry bounds access after a crash or lost network connection.

From this directory, for example:

```sh
node scripts/with-cloudflare-token.mjs --env-file /home/emsenn/info/.env \
  --account-permission 'Workers Editor' -- wrangler deployments list --name market-561-group
```

Repeat `--account-permission` or `--zone-permission` to request additional named
permissions. Zone permissions also require `--zone-id` and apply only to that
zone. No permissions or zones are granted by default. `--ttl-minutes` accepts
5–60. Child commands receive the account ID and optional zone ID as well.
The env file supplies only the manager and account ID; its other secrets are
not passed to the child. Inherited Cloudflare credentials are stripped before
the temporary token is injected, and token-management grants are refused.
Secrets are neither printed by this command nor written to disk. Child commands
must be trusted: this is credential lifecycle management, not a process sandbox.

Use this path for new maintenance operations instead of adding permanent keys.
It does not rotate or delete existing credentials used by deployed consumers,
and does not provide a background maintenance scheduler. Account tokens cannot
manage personal user tokens. Cloudflare also excludes some older APIs, including
Page Rules; use supported Configuration Rules for the market's hostname rule.

## Holdings

## Observing Worker storage responsibility

The existing `./derive-cloudflare-account-inventory` reader also exposes
`deriveCloudflareWorkerStorageBindings({accountId,tokenEnvironmentVariable})`.
The script-and-version settings GET enumerates per-Worker KV, Durable Object,
R2, D1 and Queue bindings as resource incidences, using the **real provider**
namespace ID, class/script identity, bucket name and jurisdiction, database ID
or queue name as appropriate. The projection includes the Worker's binding
variable name but never environment contents, plaintext/secret bindings or
account credentials. An incomplete identity, duplicate binding, unread settings
or incomplete Worker listing is **not** a complete or empty inventory.

The operation is a read-only account observation, not a cross-cloud machine
catalog, free-tier balance, storage-object listing, ownership claim, or right
to sell. Its outputs must be consumed by the existing resource-allocation and
economic-receiving owners with separate current quota, authority and cost evidence.
The API path is the [Cloudflare Worker script-and-version settings GET](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/);
the per-type identity fields come from its published Workers binding model.

## Free-first public receiver procedure

Cloudflare Worker Assets is the presently demonstrated free-cloud receiver for
the Group's browser-delivered sites.  It is not a synonym for arbitrary
Cloudflare compute: an asset-only receiver, a Worker that runs code on each
request, and a receiver that binds mutable storage are distinct capacity and
cost classes.

The common data and operation path is:

```
WebReleaseManifest -> verified release directory -> Worker Assets binding
  -> static-site remote-conformance transcript -> receiver acceptance
  -> separately receipt-bound retirement of a proven duplicate
```

`@red-cup-engineering/web-release-candidate-service` owns deterministic
artifact inventory and digest identity.  `@red-cup-engineering/static-site-
conformance-service` owns the independent local-link and remote-byte/media/
digest probe.  This section owns Cloudflare credentials, route observation,
and deployment effects; it must not become a second renderer or release
manifest format. Historical Google Cloud retirement receipts remain in the
retired provider data; Google deployment and retirement executables have been removed.

Before operating a public receiver, classify it exactly once:

- `static`: sealed Worker Assets only, with no Worker handler, fetch, cron, or
  Cloudflare storage binding.  It may use free static delivery only after the
  release directory has no links, has a bounded inventory, and its public
  transcript matches the manifest.
- `dynamic-stateless`: a Worker handler runs on requests, even when it only
  selects static assets.  It is not an unlimited-static-delivery claim; retain
  a current account-plan, request-budget, and CPU-budget observation before
  accepting it as free-cloud operation.
- `stateful`: any KV, D1, R2, Durable Object, Queue, AI, or unknown binding.
  Refuse free-cost admission until the named service's allowance and current
  account headroom are observed.

An accepted channel needs a custom-domain/route transcript whose requested
route is declared by the receiver, whose response bytes and normalized media
type match the `WebReleaseManifest` artifact, and whose release identity is
recorded in the deployment receipt.  A provider deploy response alone is not
receiver acceptance.  Keep the prior Worker version and any duplicate source
receiver through the stated observation window; only a subsequent,
receipt-bound retirement may remove it.

This procedure forbids GCP billing activation, paid Cloudflare products or
bindings, and VPS deployment.  A missing current free-capacity observation is
a refusal, not authorization to substitute a paid or VPS target.

- `services/cloudflare-tunnel-auth-service/` — validates a Cloudflare Tunnel
  token against its fixed protected path.
- `services/cloudflare-tunnel-config-checker-service/` — checks a tunnel's
  routing config matches its declared hostname and local service.
- `services/linux-cloudflare-authentication-service/` — authenticates a
  Linux host with Cloudflare (own repo).
- `services/cloudflare-r2-services-section/` — R2 clients, custody rules,
  verified reads, and free-tier admission.
- `services/cloudflare-activitystreams-operation-services-section/` — R2 and
  Worker operations exposed through ActivityStreams adapters.

## Pay Per Crawl receiving

The existing `./pay-per-crawl-exclusion` export derives the market's free-API exception directly from its admitted seller readout. The SAME pure compiler now also receives **ordinary publishing, science, engineering and organizational sites**, using their owner's explicit `{origin, freePaths}` policy with no fabricated seller catalog, API prefix, SKU or new registry. A marketplace must continue to supply its actual catalog and encompassing `apiPrefix` so paid routes cannot escape the exclusion. For nonmarket sites the rule excludes only the owner's admitted discovery, navigation and functional paths; which article bodies are charged remains a separate zone-specific pricing and customer-policy choice. No account/zone is activated, no author permission is inferred and no money is booked by compiling either policy. `./receive-pay-per-crawl-exclusion` is the **only effectful receiver**: it checks zone ID and name, reads the existing `http_config_settings` phase, adds or patches only the named rule, then reads back the independently installed rule. An absent `http_config_settings` phase now returns `phase-create-required` on the default read-only call; under `apply:true`, the same receiver uses Cloudflare's official zone-level ruleset-creation operation exactly once, with the source-derived rule, and independently reads back the complete created phase. If another actor creates the phase first or any provider write/readback fails, stop and re-read; never overwrite a possibly existing phase. For an existing phase it still adds or patches **only** the named rule. It never `PUT`s a whole ruleset, edits unrelated rules, enables charging, changes crawler policy, or claims payout. Default `apply:false` only reports required change. Scoped `CLOUDFLARE_API_TOKEN` comes from this section's existing short-lived token-custody mechanism; no token is persisted in the receipt. The consumer is `causeway-services/market.561.group`, through `npm run receive:crawler-exemptions` (read-only) or `-- --apply` (rule mutation). Account/zone beta eligibility, charging configuration and actual Stripe payouts require separate independent receiving.



Pay Per Crawl is a separate Cloudflare edge billing protocol from the x402 EVM
resource boundary. As checked against Cloudflare's documentation on 2026-10-13,
it is a closed beta. An origin price header alone proves neither enrollment,
charging configuration nor settlement.

Operate the existing account-owned receiver and credentials. First derive this
section's account inventory. Zone enumeration is filtered by the requested
account and follows every advertised zone and DNS page; malformed, repeated or
incomplete pages refuse the inventory instead of silently accepting partial
coverage. Its record still describes observed routing, not Pay Per Crawl
eligibility. Account visibility, Payments settings and crawler actions must be
observed through the supported Cloudflare controls.

For each owned zone and every property route it covers:

1. An account Administrator or Super Administrator sets the zone's Pay Per Crawl
   visibility to Visible in Manage Account > Settings. Visibility exposes the
   controls; it does not enable charging or change security.
2. In AI Crawl Control > Payments, enable Pay Per Crawl and select the accepted
   per-crawl price (minimum USD 0.001). Keep crawlers that supply discovery,
   citations or contracted access on their appropriate Allow terms. Record the
   selected Charge action separately from WAF and Bot Management: a prior block
   overrides Charge and prevents paid access.
3. Keep homepage/navigation, functional APIs and each existing x402 purchase or
   compute endpoint outside crawl charging through Configuration Rules as
   appropriate to the owning content terms. Cloudflare always excludes
   /robots.txt, /sitemap.xml, /security.txt, /.well-known/security.txt and
   /crawlers.json. Preserve unrelated security rules.
4. Dynamic pricing requires the zone's Enable dynamic pricing control plus an
   origin or Worker response carrying crawler-price: USD <decimal>. The incoming
   cf-pay-per-crawl header identifies protocol=cloudflare and pricing=in-band,
   zone-default or bypass. Snippets response transformations cannot select an
   actionable crawl price. This header is an edge pricing input and must never
   be accepted as x402 payment or a local entitlement.
5. Retain independent evidence for configuration, actual HTTP 402 discovery,
   successful charged HTTP 200 delivery and a corresponding Cloudflare charge
   event. A crawler-price header, deployment job or an origin's successful HTTP
   response proves none of the later steps. Error responses are not billable.
6. Reconcile provider events into the customer-owned shared actor/evidence
   channel using existing semantic record writers. Keep Cloudflare crawl billing
   distinct from EVM transaction settlement and retain their source identities;
   do not count an origin request as revenue.

Payout readiness is separate. Cloudflare currently requires a dedicated Stripe
Connect account created through its dashboard; a pre-existing Stripe account is
not compatible. Observe an existing connection first. Creating an account,
onboarding a legal entity or choosing financial terms follows the actual
customer's authority and is not an inventory or source-repair effect.

Official operating references:
- https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/
- https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/enable-in-account-settings/
- https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/set-a-pay-per-crawl-price/
- https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/advanced-configuration/
- https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/use-pay-per-crawl-as-site-owner/manage-payouts/
