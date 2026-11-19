# cloudflare-router

Cloudflare Worker that reverse-proxies the game subdomains under
`561.group` to their matching Cloud Run services. It carries no
application logic of its own: it rewrites the upstream `Host` and
forwards everything else (method, path, query, headers, body)
unchanged.

This exists because a plain proxied CNAME to `*.run.app` does not
work: Cloudflare forwards the browser's original `Host` header
unchanged, but Cloud Run's shared regional frontend
(`us-central1.run.app`) dispatches to a specific service by matching
Host/SNI against that service's own `run.app` hostname. An
unrecognized Host gets Google's 404 at the TLS/SNI layer, so the
Worker rewrites the Host to the right `*.run.app` origin before
forwarding.

## Install

```sh
npm install
```

## Test

```sh
npm test
```

## Deploy

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy
```

`npm run deploy` runs `wrangler deploy`. `npm run dev` runs `wrangler
dev` for a local preview.

## Routing table

`src/index.mjs` exports `ORIGIN_BY_HOST`, a `Map` from subdomain to
Cloud Run origin:

2026-08-31 free-tier pivot: a migrated game gets its own dedicated
Worker with its own Custom Domain and leaves this table (GCP billing
on `five-six-one-group-dev` is permanently off, so every remaining
entry below proxies to a dead Cloud Run origin -- kept only for route
continuity until each one migrates too).

| Subdomain                     | Cloud Run origin                                     |
|--------------------------------|-------------------------------------------------------|
| `ruinfold.561.group`           | `ruinfold-1019481907460.us-central1.run.app`         |
| `farstone.play.561.group`      | `farstone-1019481907460.us-central1.run.app`         |
| `durante.561.group`            | `durante-1019481907460.us-central1.run.app`          |
| `aletheon.561.group`           | `aletheon-1019481907460.us-central1.run.app`         |
| `casino.play.561.group`         | `http://ops.561.group:8081` (revived onto cold-red-gate) |

`wrangler.jsonc`'s `routes` array is what actually attaches each
hostname to this Worker as a Workers Custom Domain (which also
auto-manages that hostname's DNS record). Adding or removing a
subdomain means updating both `ORIGIN_BY_HOST` and `routes` — if they
disagree, the mismatched hostname 404s inside the Worker even though
Cloudflare delivers the request to it.

A request to a hostname not in `ORIGIN_BY_HOST` gets a plain 404 from
the Worker itself.

## Teardown

Remove one hostname: delete its entry from both `ORIGIN_BY_HOST` and
`routes`, then `npm run deploy`.

Remove the whole Worker (all routes, all Custom-Domain-managed DNS
records): `node_modules/.bin/wrangler delete`.
