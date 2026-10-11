# Cloudflare Services Section

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
