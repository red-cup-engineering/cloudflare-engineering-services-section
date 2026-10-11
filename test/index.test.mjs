import test from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_BY_HOST, upstreamRequestFor } from "../scripts/index.mjs";
import worker from "../scripts/index.mjs";

test("rewrites Host and URL to the matching numeric-port origin", () => {
  for (const [host, origin] of ORIGIN_BY_HOST) {
    const request = new Request(`https://${host}/some/path?x=1`, {
      method: "POST",
      headers: { "x-test": "yes" },
      body: "payload",
    });
    const upstream = upstreamRequestFor(request);
    assert.ok(upstream, `expected an upstream request for ${host}`);
    const expected = origin.includes("://") ? new URL(origin) : new URL(`https://${origin}`);
    assert.equal(new URL(upstream.url).hostname, expected.hostname);
    assert.equal(new URL(upstream.url).port, expected.port);
    assert.equal(new URL(upstream.url).protocol, expected.protocol);
    assert.equal(new URL(upstream.url).pathname, "/some/path");
    assert.equal(new URL(upstream.url).search, "?x=1");
    assert.equal(upstream.headers.get("Host"), expected.host);
    assert.equal(upstream.method, "POST");
    assert.equal(upstream.headers.get("x-test"), "yes");
  }
});

test("returns null for a hostname with no mapping", () => {
  const request = new Request("https://unknown.561.group/");
  assert.equal(upstreamRequestFor(request), null);
});

test("a plain-object prototype key is not mistaken for a mapped host", () => {
  const request = new Request("https://__proto__/");
  assert.equal(upstreamRequestFor(request), null);
});

test("worker.fetch returns 404 for an unmapped host", async () => {
  const request = new Request("https://unknown.561.group/");
  const response = await worker.fetch(request);
  assert.equal(response.status, 404);
});

test("worker.fetch proxies to the rewritten origin for a mapped host", async (t) => {
  const originalFetch = globalThis.fetch;
  let seenRequest = null;
  globalThis.fetch = async (request) => {
    seenRequest = request;
    return new Response("ok", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const request = new Request("https://casino.561.group/lobby");
  const response = await worker.fetch(request);

  assert.equal(response.status, 200);
  assert.equal(new URL(seenRequest.url).hostname, "bare-cedar-fog.561.group");
  assert.equal(new URL(seenRequest.url).port, "8081");
});
