// cloudflare-router-561-group
//
// Minimal reverse-proxy Worker: maps each 561.group game subdomain to its origin (numeric-port
// Caddy blocks on cold-red-gate since 2026-09-05), rewrites the upstream Host, and passes the
// request through unmodified otherwise. Cloudflare custom domains attach the hostnames to
// this Worker; this script owns the hostname -> origin map and the proxy fetch.

// Map, not a plain object literal: request hostnames are untrusted external input, and a plain
// object would resolve a lookup like "__proto__" to Object.prototype instead of undefined.
export const ORIGIN_BY_HOST = new Map([
  ["flickering.561.group", "http://bare-cedar-fog.561.group:8088"],
  ["onestone.561.group", "http://bare-cedar-fog.561.group:8089"],
  ["ruinfold.561.group", "http://bare-cedar-fog.561.group:8083"],
  ["farstone.561.group", "http://bare-cedar-fog.561.group:8080"],
  ["durante.561.group", "http://bare-cedar-fog.561.group:8084"],
  ["aletheon.561.group", "http://bare-cedar-fog.561.group:8085"],
  ["casino.561.group", "http://bare-cedar-fog.561.group:8081"],
]);

export function upstreamRequestFor(request) {
  const url = new URL(request.url);
  const upstreamHost = ORIGIN_BY_HOST.get(url.hostname);
  if (!upstreamHost) return null;

  if (upstreamHost.includes("://")) {
    const origin = new URL(upstreamHost);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = origin.port;
  } else {
    url.protocol = "https:";
    url.hostname = upstreamHost;
    url.port = "";
  }

  const upstreamRequest = new Request(url, request);
  upstreamRequest.headers.set("Host", url.host);
  return upstreamRequest;
}

export default {
  async fetch(request) {
    const upstreamRequest = upstreamRequestFor(request);
    if (!upstreamRequest) return new Response("Not found", { status: 404 });
    return fetch(upstreamRequest);
  },
};
