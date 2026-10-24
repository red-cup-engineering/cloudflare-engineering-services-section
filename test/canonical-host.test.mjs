import assert from "node:assert/strict";
import test from "node:test";
import { canonicalLocation, estateHosts, wwwAliases } from "../scripts/canonical-host.mjs";
import worker from "../scripts/canonical-host-worker.mjs";

test("only two-label estate hosts get a www alias", () => {
  const hosts = estateHosts({ nodes: [{ host: "koios.news" }, { host: "muse.561.group" }], doors: [{ host: "koios.news" }] });
  assert.deepEqual(wwwAliases(hosts).map(({ route }) => route), ["www.koios.news/*"]);
});

test("the alias redirects permanently to the apex, keeping path and query", async () => {
  assert.equal(canonicalLocation("http://www.koios.news/a/b?c=1"), "https://koios.news/a/b?c=1");
  const response = await worker.fetch(new Request("https://www.koios.news/feed.xml"));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://koios.news/feed.xml");
});

test("a non-alias host is refused rather than looped", async () => {
  assert.equal((await worker.fetch(new Request("https://koios.news/"))).status, 421);
});
