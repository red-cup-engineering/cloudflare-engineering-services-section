#!/usr/bin/env node
// frontdoor-walk.mjs — the canonical live-deploy verifier (deploy runbook's own "Verifying a live
// deploy" section). Walks the REAL reference graph starting from the URL a human actually visits: the
// front door's HTML, its <script>/<link>/<img> tags, its inline <script type="importmap">, and every
// static import (and JSON-body URL-shaped string) reachable transitively from there — the same
// reference graph a real browser resolves, not a hand-picked list of paths already known to be correct.
//
// Reconstructed at this path (2026-08-20) per the deploy runbook's documented contract and the deploy
// log's own account of two bugs found and fixed in an earlier version of this file (see both docs,
// `content/text/documents/articles/notes/{2026-08-19-note-on-deploy-runbook.md,logs/2026-08-19-deploy-log.md}`):
// the walker no longer eagerly fetches every import-map entry (only ones an import specifier actually
// resolves through), and it checks the import map FIRST for every specifier — absolute-, relative-, and
// scheme-looking ("node:crypto") alike — before falling back to plain URL resolution, matching a real
// browser's own module-resolution order.
//
// Exit 0 with zero MISS/BADMIME lines means every reference the document (and everything it
// transitively imports) resolves to a real 2xx response with the correct content type, resolved
// against the fetching resource's own URL. Exit 1 otherwise.
//
// Usage: node frontdoor-walk.mjs <front-door-url>

const startUrl = process.argv[2];
if (!startUrl) {
  console.error("usage: node frontdoor-walk.mjs <front-door-url>");
  process.exit(2);
}

const EXPECTED_MIME = {
  ".html": ["text/html"],
  ".mjs": ["text/javascript", "application/javascript"],
  ".js": ["text/javascript", "application/javascript"],
  ".css": ["text/css"],
  ".json": ["application/json"],
  ".jsonl": ["application/x-ndjson", "application/json", "text/plain"],
  ".md": ["text/plain", "text/markdown"],
  ".svg": ["image/svg+xml"],
};

function extOf(pathname) {
  const dot = pathname.lastIndexOf(".");
  return dot === -1 ? "" : pathname.slice(dot);
}

function mimeOk(pathname, contentType) {
  const ext = extOf(pathname);
  const expected = EXPECTED_MIME[ext];
  if (!expected) return true; // no opinion on extensions we don't recognize (e.g. extensionless routes)
  const bare = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return expected.includes(bare);
}

// resolveSpecifier — a real browser's own order for a bare/relative/absolute specifier found inside a
// module: check the import map FIRST (exact key, then longest-prefix key ending in "/"), THEN fall back
// to resolving it as a plain URL against the importing document's own URL. This order is what the
// node:crypto bug (deploy log) was: an earlier version skipped the import-map check for anything that
// already looked like a syntactically valid absolute specifier.
// mapBaseUrl is the import map's OWN base URL (the containing document's URL for an inline map);
// moduleBaseUrl is the URL of whatever module is doing the importing. Per the HTML spec, an import
// map's "address" values are resolved against the map's own base URL, never against the referencing
// module's URL -- only the plain-URL fallback (a specifier not covered by the map at all) resolves
// against the referencing module. Collapsing these two into one baseUrl (the referencing module's) was
// itself a real bug: it silently passed for every top-level script (whose URL happens to equal the
// document's), then broke for any deeper import from a subdirectory like js/catalog.mjs.
function resolveSpecifier(specifier, importMap, mapBaseUrl, moduleBaseUrl) {
  if (importMap.imports?.[specifier]) {
    return new URL(importMap.imports[specifier], mapBaseUrl).href;
  }
  for (const [prefix, target] of Object.entries(importMap.imports ?? {})) {
    if (prefix.endsWith("/") && specifier.startsWith(prefix)) {
      return new URL(target + specifier.slice(prefix.length), mapBaseUrl).href;
    }
  }
  if (/^https?:\/\//.test(specifier) || specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) {
    return new URL(specifier, moduleBaseUrl).href;
  }
  return null; // an unresolved bare specifier — a real browser-resolution gap
}

// extractImports — static `import ... from "x"`, bare `import "x"`, dynamic `import("x")`, and
// `export ... from "x"` specifiers. A regex scan, not a real parser — matches this house's other
// import-map-completeness tests (server.test.mts's own "no browser-resolution gap" test uses the same
// static-scan approach), sufficient for ES module source that was never meant to be obfuscated.
function extractImports(source) {
  // Strip block and full-line `//` comments first — house source here documents subpath examples in
  // comments (e.g. "// import { settle } from '@lenticule-science/metrologic/bilattice/descent';"), which a naive
  // regex scan over raw source would misread as a real, unresolved bare import.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of stripped.matchAll(re)) specifiers.add(m[1]);
  }
  return [...specifiers];
}

// extractJsonUrls — URL-shaped string VALUES inside a parsed JSON body (the catalog.json bug from the
// deploy log: a JSON document can itself name resources the front door depends on).
function extractJsonUrls(value, baseUrl, found = new Set()) {
  if (typeof value === "string") {
    if (/^\/[\w.\-/]+\.(mjs|json|jsonl|css|md)$/.test(value) || /^https?:\/\//.test(value)) {
      found.add(new URL(value, baseUrl).href);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) extractJsonUrls(v, baseUrl, found);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) extractJsonUrls(v, baseUrl, found);
  }
  return found;
}

function extractHtmlRefs(html, baseUrl) {
  const refs = [];
  let importMap = { imports: {} };
  const imRe = /<script\b[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i;
  const imMatch = imRe.exec(html);
  if (imMatch) {
    try { importMap = JSON.parse(imMatch[1]); } catch { /* left empty on parse failure — reported below */ }
  }
  const tagRe = /<(script|link|img)\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrs] = m;
    const srcMatch = /\bsrc=["']([^"']+)["']/i.exec(attrs);
    const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(attrs);
    const url = srcMatch?.[1] ?? hrefMatch?.[1];
    if (!url || url.startsWith("data:")) continue;
    if (tag.toLowerCase() === "link") {
      const rel = /\brel=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
      if (!/^(stylesheet|icon)$/i.test(rel)) continue;
    }
    refs.push(new URL(url, baseUrl).href);
  }
  return { refs, importMap };
}

const visited = new Set();
const misses = [];
const badmimes = [];
const ok = [];

async function fetchAndReport(url) {
  if (visited.has(url)) return null;
  visited.add(url);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    misses.push(`MISS ${url} (network error: ${err.message})`);
    return null;
  }
  const pathname = new URL(url).pathname;
  if (!res.ok) {
    misses.push(`MISS ${url} (HTTP ${res.status})`);
    return null;
  }
  const contentType = res.headers.get("content-type");
  if (!mimeOk(pathname, contentType)) {
    badmimes.push(`BADMIME ${url} (got "${contentType}")`);
  }
  ok.push(`OK   ${res.status} ${contentType ?? "(no content-type)"}  ${url}`);
  return res;
}

async function walk(startUrl) {
  const entryRes = await fetchAndReport(startUrl);
  if (!entryRes) return;
  let docUrl = entryRes.url; // fetch() follows redirects by default — the doc's REAL final URL, the
  // base every relative reference in its body resolves against (the exact "resolved against the
  // fetching resource's own URL" contract this walker exists to enforce).
  if (entryRes.url !== startUrl) {
    ok.push(`OK   redirected: ${startUrl} -> ${entryRes.url}`);
  }
  const html = await entryRes.text();
  const { refs, importMap } = extractHtmlRefs(html, docUrl);

  const queue = [...refs];
  const jsQueue = [];
  for (const ref of refs) {
    if (ref.endsWith(".mjs") || ref.endsWith(".js")) jsQueue.push(ref);
  }

  while (queue.length > 0) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    const res = await fetchAndReport(url);
    if (!res) continue;
    const pathname = new URL(url).pathname;
    if (pathname.endsWith(".mjs") || pathname.endsWith(".js")) {
      const src = await res.text();
      for (const spec of extractImports(src)) {
        const resolved = resolveSpecifier(spec, importMap, docUrl, url);
        if (!resolved) {
          misses.push(`MISS (unresolved specifier) "${spec}" imported from ${url}`);
          continue;
        }
        if (!visited.has(resolved)) queue.push(resolved);
      }
    } else if (pathname.endsWith(".json")) {
      try {
        const parsed = JSON.parse(await (await fetch(url)).text());
        for (const jurl of extractJsonUrls(parsed, url)) {
          if (!visited.has(jurl)) queue.push(jurl);
        }
      } catch { /* malformed JSON is its own MISS-worthy problem, but not this walker's concern here */ }
    }
  }
}

await walk(startUrl);

for (const line of ok) console.log(line);
for (const line of badmimes) console.log(line);
for (const line of misses) console.log(line);

console.log("");
console.log(`frontdoor-walk: ${visited.size} URL(s) visited, ${misses.length} MISS, ${badmimes.length} BADMIME`);
process.exit(misses.length === 0 && badmimes.length === 0 ? 0 : 1);
