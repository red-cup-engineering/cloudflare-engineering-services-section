#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { artifactChecksum, completeEffect, proposeEffect, semanticBytesId, textNi } from "@red-cup-engineering/a2a-effect-assay-services-section/effect-assay";
import { witnessJournalBindingFromArgv, wasWitnessed, recordWitnessedBoundaryAct } from "./removed-witness-journal.mjs";

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const NODE_ID = "resource-brokerage-service-section";
const ACTOR = `urn:ame:${NODE_ID}`;
const CUSTOMER = "urn:ame:koios.news";
const CONTRACT = "cloudflare-primary-static-release/v3";
const NODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAW_PATH = join(NODE_ROOT, "lib", "law", "cloudflare-primary-static-release.rml");
const DEFAULT_CREDENTIAL = join(NODE_ROOT, "content/resources/cloudflare-workers.env");
const API = "https://api.cloudflare.com/client/v4";
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_OFFER_MS = 60 * 60 * 1000;
const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CAIP10 = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/u;
const TARGET = Object.freeze({
  accountId: "337e54ee6dc7d488933f473204a6d89e",
  zoneName: "koios.news",
  workerName: "koios-news-primary",
  routePattern: "koios.news/*",
  origin: "https://koios.news",
});
const ATTENTION = Object.freeze({
  namespaceId: "48e3d0a57c014b0ebefdfd219fd49648",
  binding: "KOIOS_ATTENTION",
  contract: "cloudflare-worker-aggregate-attention/v1",
});
const BASE_EFFECTS = Object.freeze([
  "read-one-customer-supplied-static-candidate",
  "append-provider-local-release-evidence",
]);
const LIVE_EFFECTS = Object.freeze([
  ...BASE_EFFECTS,
  "read-existing-cloudflare-worker-route",
  "snapshot-existing-cloudflare-worker-deployment",
  "deploy-one-digest-bound-static-worker-version",
  "bind-one-koios-aggregate-attention-namespace",
  "count-successful-article-loads-by-utc-day-without-reader-identifiers",
  "probe-digest-bound-public-routes",
  "restore-prior-cloudflare-worker-version-on-probe-failure",
]);
const WitnessJournal = witnessJournalBindingFromArgv();

function arg(flag) { const index = process.argv.indexOf(flag); return index === -1 ? undefined : process.argv[index + 1]; }
function atInstant() { return arg("--now") ?? new Date().toISOString(); }
function operation() { return arg("--operation") ?? "solicit-primary-release"; }
function input() { return JSON.parse(readFileSync(0, "utf8")); }
function literal(value) { return JSON.stringify(String(value)); }
function witness(activity, outcome, at, details = {}) { return recordWitnessedBoundaryAct(activity, outcome, at, CONTRACT, details, WitnessJournal); }
function witnessed(subject, outcome, at) { return wasWitnessed(subject, outcome, at, WitnessJournal); }
function response(type, source, object) { return { "@context": CONTEXT, id: `urn:uuid:${randomUUID()}`, type, actor: ACTOR, target: source?.actor ?? "urn:ame:unidentified-customer", inReplyTo: source?.id ?? "urn:activity:unidentified", object }; }
function emit(value, code = 0) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exitCode = code; }
async function reject(source, reason, at, details = {}) { const value = response("Reject", source, { type: "CloudflarePrimaryStaticReleaseRefusal", contract: CONTRACT, reason, ...details }); await witness(source, "primary-release.rejected", at, { reason, ...details }); emit(value, 2); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isDigest(value) { return typeof value === "string" && NI.test(value); }
function isInstant(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function attachments(note) { return Array.isArray(note?.attachment) ? note.attachment : note?.attachment === undefined ? [] : [note.attachment]; }

function treeReading(rootValue) {
  const root = resolve(rootValue);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("candidate must be a regular non-symlink directory");
  const files = [];
  let totalBytes = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`candidate contains a symlink: ${path}`);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile()) throw new Error(`candidate contains a non-file entry: ${path}`);
      const bytes = readFileSync(path);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`candidate file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      totalBytes += bytes.length;
      files.push(Object.freeze({ path: relative(root, path).split(sep).join("/"), bytes: bytes.length, digest: artifactChecksum(bytes) }));
      if (files.length > MAX_FILES) throw new Error(`candidate exceeds ${MAX_FILES} files`);
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`candidate exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
  }
  visit(root);
  const treeCarrier = files.map((file) => `<urn:path:${encodeURIComponent(file.path)}> <urn:rmn:bytes> ${literal(file.bytes)}; <urn:rmn:content> <${file.digest}> .`).join("\n");
  return Object.freeze({ root, files: Object.freeze(files), fileCount: files.length, totalBytes, treeDigest: artifactChecksum(Buffer.from(`${treeCarrier}\n`, "utf8")) });
}

function normalizedRequest(activity) {
  const request = attachments(activity?.object?.sourceActivity?.object).find((value) => value?.type === "CloudflarePrimaryStaticReleaseRequest");
  return request ?? null;
}

function inspectRequest(request, at) {
  const problems = [];
  if (!isRecord(request) || !["dry-run", "live"].includes(request.executionMode)) problems.push("executionMode(dry-run|live)");
  if (!isRecord(request?.artifact) || typeof request.artifact.path !== "string" || !request.artifact.path.startsWith("/") || !isDigest(request.artifact.treeDigest) || !isDigest(request.artifact.manifestDigest) || !isDigest(request.artifact.deliveryPolicyDigest) || !isDigest(request.artifact.livePublicationWitnessDigest)) problems.push("artifact{path,treeDigest,manifestDigest,deliveryPolicyDigest,livePublicationWitnessDigest}");
  if (!isRecord(request?.publication) || typeof request.publication.assignmentId !== "string" || request.publication.assignmentId.length === 0 || typeof request.publication.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.publication.slug)) problems.push("publication{assignmentId,slug}");
  if (!isDeepStrictEqual(request?.target, TARGET)) problems.push("target(exact Koios Cloudflare authority)");
  if (!isInstant(request?.expiresAt)) problems.push("expiresAt(explicit UTC instant)");
  else {
    const remaining = Date.parse(request.expiresAt) - Date.parse(at);
    if (!(remaining > 0 && remaining <= MAX_OFFER_MS)) problems.push(`expiresAt(>now and <=${MAX_OFFER_MS}ms)`);
  }
  if (!CAIP10.test(request?.caller ?? "")) problems.push("caller(CAIP-10)");
  if (request?.parentEffect !== null && !NI.test(request?.parentEffect ?? "")) problems.push("parentEffect(RMN-ni-or-null)");
  if (!CAIP10.test(process.env.RESOURCE_BROKERAGE_PROVIDER_CAIP10 ?? "")) problems.push("provider(CAIP-10)");
  if (problems.length > 0) return { problems };
  try {
    const tree = treeReading(request.artifact.path);
    if (tree.treeDigest !== request.artifact.treeDigest) problems.push("candidate tree digest mismatch");
    const manifestBytes = readFileSync(join(tree.root, "manifest.json"));
    const headersBytes = readFileSync(join(tree.root, "_headers"));
    if (artifactChecksum(manifestBytes) !== request.artifact.manifestDigest) problems.push("candidate manifest digest mismatch");
    if (artifactChecksum(headersBytes) !== request.artifact.deliveryPolicyDigest) problems.push("candidate delivery-policy digest mismatch");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (manifest.kind !== "koios.static-publication-manifest" || manifest.node !== "koios-news" || manifest.profile !== "cutover-candidate" || manifest.authority !== "non-authoritative-cutover-candidate" || manifest.canonicalOrigin !== TARGET.origin) problems.push("candidate manifest is not the Koios production artifact profile");
    if (manifest.livePublicationWitnessDigest !== request.artifact.livePublicationWitnessDigest) problems.push("candidate live-publication witness mismatch");
    if (headersBytes.toString("utf8").includes("X-Robots-Tag")) problems.push("production candidate carries a preview noindex policy");
    const byPath = new Map(tree.files.map((file) => [file.path, file]));
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    if (artifacts.length === 0) problems.push("candidate manifest carries no artifacts");
    for (const artifact of artifacts) {
      const reading = byPath.get(artifact?.file);
      if (reading === undefined || reading.digest !== artifact.digest || reading.bytes !== artifact.bytes) problems.push(`candidate artifact mismatch: ${String(artifact?.file ?? "unidentified")}`);
    }
    const articleRoute = `/posts/${request.publication.slug}`;
    if (!artifacts.some((artifact) => artifact?.route === articleRoute)) problems.push(`candidate lacks the accepted article route ${articleRoute}`);
    return { problems: [...new Set(problems)], tree, manifest, manifestBytes, headersBytes, articleRoute };
  } catch (error) { return { problems: [error instanceof Error ? error.message : String(error)] }; }
}

function terms(request, inspection) {
  const effects = request.executionMode === "live" ? LIVE_EFFECTS : BASE_EFFECTS;
  const bindings = Object.freeze({
    artifactTreeDigest: inspection.tree.treeDigest,
    artifactManifestDigest: artifactChecksum(inspection.manifestBytes),
    deliveryPolicyDigest: artifactChecksum(inspection.headersBytes),
    livePublicationWitnessDigest: request.artifact.livePublicationWitnessDigest,
    assignmentId: request.publication.assignmentId,
    slug: request.publication.slug,
    articleRoute: inspection.articleRoute,
    target: TARGET,
    expiresAt: request.expiresAt,
    effects,
    effectsIdentity: textNi(effects.join("\n")),
  });
  return Object.freeze({ effects, bindings });
}

function effectCell(request, bindings, outcome, evidenceRoot, witQuantity = "0") {
  return {
    law: semanticBytesId("resource-brokerage.primary-static-release-law", readFileSync(LAW_PATH)),
    caller: request.caller,
    provider: process.env.RESOURCE_BROKERAGE_PROVIDER_CAIP10,
    precondition: textNi(`primary-release:${bindings.artifactTreeDigest}:${bindings.expiresAt}`),
    operation: textNi(`cloudflare-primary-static-release:${request.executionMode}:${bindings.effectsIdentity}`),
    postcondition: textNi("CloudflarePrimaryStaticReleaseReceipt{disposition,effect}"),
    refusal: textNi("CloudflarePrimaryStaticReleaseRefusal{reason,effect}"),
    evidenceRoot,
    outcome,
    measures: [
      { dimension: "cloudflare-primary-release", quantity: request.executionMode === "live" ? "5" : "1", unit: "service-act" },
      { dimension: "wit", quantity: witQuantity, unit: "wit" }
    ],
    parent: request.parentEffect
  };
}

async function proposedEffect(sourceActivity, request, bindings, at) {
  const cell = effectCell(request, bindings, { positiveEvidence: false, negativeEvidence: false }, textNi(sourceActivity.id));
  return { cell, ...await proposeEffect(ACTOR, cell, at) };
}

async function solicit(activity, at) {
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Offer" || activity.actor !== CUSTOMER || activity.target !== ACTOR || activity.object?.type !== "ServiceSolicitation" || activity.object?.sourceActivity?.type !== "Create") { await reject(activity, "solicitation must be an ActivityStreams Offer<ServiceSolicitation> from Koios", at); return; }
  const request = normalizedRequest(activity);
  const inspection = inspectRequest(request, at);
  if (inspection.problems.length > 0) {
    const question = response("Question", activity, { type: "ServiceTermsRequired", contract: CONTRACT, missing: inspection.problems });
    await witness(activity, "primary-release.terms-requested", at, { missing: inspection.problems }); emit(question); return;
  }
  const settled = terms(request, inspection);
  let effect;
  try { effect = await proposedEffect(activity.object.sourceActivity, request, settled.bindings, at); }
  catch (error) { await reject(activity, "rmn-conformance-refused", at, { detail: error.message }); return; }
  const object = {
    type: "ExecutableServiceOffer",
    contract: CONTRACT,
    request,
    sourceActivity: activity.object.sourceActivity.id,
    operation: "invoke-primary-release",
    bindings: settled.bindings,
    effects: settled.effects,
    effect: { semanticId: effect.semanticId, evidence: effect.evidence, conformance: effect.conformance },
    exclusions: ["dns-mutation", "worker-route-mutation", "worker-deletion", "credential-egress", "vps-public-origin", "vps-origin-fallback", "editorial-mutation", "customer-ledger-mutation"],
  };
  const offer = response("Offer", activity, object);
  await witness(offer, "primary-release.offer-emitted", at, { effect: effect.semanticId, executionMode: request.executionMode });
  emit(offer);
}

async function validateInvocation(activity, at) {
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Accept" || activity.actor !== CUSTOMER || activity.target !== ACTOR) return { problem: "invocation must be an ActivityStreams Accept from Koios" };
  const contract = activity.object;
  const offer = contract?.offer;
  if (contract?.type !== "ServiceContract" || contract.contract !== CONTRACT || offer?.type !== "Offer" || offer.actor !== ACTOR || offer.object?.contract !== CONTRACT) return { problem: "invocation must accept this provider's exact release offer" };
  const inspection = inspectRequest(offer.object.request, at);
  if (inspection.problems.length > 0) return { problem: `accepted release request no longer satisfies terms: ${inspection.problems.join(", ")}` };
  const settled = terms(offer.object.request, inspection);
  if (!isDeepStrictEqual(settled.bindings, offer.object.bindings) || !isDeepStrictEqual(settled.effects, offer.object.effects) || !isDeepStrictEqual(contract.bindings, offer.object.bindings)) return { problem: "accepted offer no longer matches the exact release evidence" };
  let proposed;
  try { proposed = await proposedEffect({ id: offer.object.sourceActivity }, offer.object.request, settled.bindings, at); }
  catch (error) { return { problem: `rmn-conformance-refused: ${error.message}` }; }
  if (proposed.semanticId !== offer.object.effect?.semanticId) return { problem: "effect-commitment-drift" };
  return { offer, request: offer.object.request, inspection, proposed };
}

function providerCredential() {
  const path = resolve(process.env.CLOUDFLARE_PRIMARY_RELEASE_CREDENTIAL_FILE ?? DEFAULT_CREDENTIAL);
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new Error("provider Cloudflare resource carrier is absent"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("provider Cloudflare resource carrier must be a regular non-symlink file at mode 0600 or stricter");
  const name = "API_KEY_CLOUDFLARE_WORKERS_EDIT";
  const values = readFileSync(path, "utf8").split(/\r?\n/gu).flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || !trimmed.startsWith(`${name}=`)) return [];
    let value = trimmed.slice(name.length + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [value];
  });
  if (values.length !== 1 || values[0] === "") throw new Error(`provider resource carrier must contain exactly one ${name} assignment`);
  return values[0];
}

function wranglerExecutable() {
  const path = resolve(process.env.CLOUDFLARE_PRIMARY_RELEASE_WRANGLER ?? join(NODE_ROOT, "node_modules/.bin/wrangler"));
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("provider Wrangler executable is absent or non-executable");
  return path;
}

function subprocess(executable, args, cwd, token, timeout = 180_000) {
  const stdoutPath = join(cwd, `stdout-${createHash("sha256").update(args.join("\0")).digest("hex").slice(0, 12)}.txt`);
  const stderrPath = join(cwd, `stderr-${createHash("sha256").update(args.join("\0")).digest("hex").slice(0, 12)}.txt`);
  const stdoutFd = openSync(stdoutPath, "w+"); const stderrFd = openSync(stderrPath, "w+");
  let result;
  try {
    // GNU timeout owns a process group, so a timed-out Wrangler cannot leave
    // an orphaned Node child saturating the persistent host. Lower priority
    // and a finite heap keep SSH, ScheduleDelivery, and LISS responsive while the
    // release scans its asset set.
    const timeoutExecutable = "/usr/bin/timeout";
    const niceExecutable = "/usr/bin/nice";
    if (!existsSync(timeoutExecutable) || !existsSync(niceExecutable)) throw new Error("bounded release execution requires /usr/bin/timeout and /usr/bin/nice");
    // Keep to the option subset shared by GNU coreutils and Cold Red Gate's
    // uutils coreutils. uutils 0.2.2 rejects --kill-after with status 125;
    // ScheduleDelivery's systemd cgroup supplies the independent hard-stop bound.
    const boundedArgs = ["--signal=TERM", `${Math.max(1, Math.ceil(timeout / 1000))}s`, niceExecutable, "-n", "10", executable, ...args];
    result = spawnSync(timeoutExecutable, boundedArgs, { cwd, stdio: ["ignore", stdoutFd, stderrFd], timeout: timeout + 20_000, env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, NODE_OPTIONS: "--max-old-space-size=512", UV_THREADPOOL_SIZE: "2", CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", XDG_CONFIG_HOME: join(cwd, "xdg"), ...(token === undefined ? {} : { CLOUDFLARE_API_TOKEN: token }) } });
  } finally { closeSync(stdoutFd); closeSync(stderrFd); }
  const stdout = readFileSync(stdoutPath, "utf8"); const stderr = readFileSync(stderrPath, "utf8");
  const clean = (value) => (token ? value.replaceAll(token, "[REDACTED]") : value).replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]").slice(-4000);
  return Object.freeze({ status: result.status, signal: result.signal, errorCode: result.error?.code, stdout, stderr, evidence: { status: result.status, signal: result.signal, errorCode: result.error?.code, stdoutDigest: textNi(stdout), stderrDigest: textNi(stderr), ...(result.status === 0 ? {} : { stdoutExcerpt: clean(stdout), stderrExcerpt: clean(stderr) }) } });
}

async function cloudflare(token, path) {
  const result = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const envelope = await result.json();
  if (!result.ok || envelope?.success !== true) throw new Error(`Cloudflare read ${path} refused (${result.status})`);
  return envelope.result;
}

async function inspectRoute(token) {
  const zones = await cloudflare(token, `/zones?name=${encodeURIComponent(TARGET.zoneName)}&account.id=${encodeURIComponent(TARGET.accountId)}&status=active&match=all`);
  if (!Array.isArray(zones) || zones.length !== 1 || typeof zones[0]?.id !== "string") throw new Error("Cloudflare did not return exactly one active Koios zone");
  const routes = await cloudflare(token, `/zones/${zones[0].id}/workers/routes`);
  const exact = Array.isArray(routes) ? routes.filter((route) => route?.pattern === TARGET.routePattern) : [];
  if (exact.length !== 1 || exact[0]?.script !== TARGET.workerName) throw new Error("Cloudflare primary route is not already bound to koios-news-primary");
  return Object.freeze({ zoneId: zones[0].id, route: exact[0] });
}

function priorVersion(status) {
  const candidates = [];
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isRecord(value)) return;
    const id = value.version_id ?? value.versionId;
    if (typeof id === "string") candidates.push({ id, percentage: Number(value.percentage ?? value.traffic ?? 0) });
    Object.values(value).forEach(visit);
  }
  visit(status);
  return candidates.sort((a, b) => b.percentage - a.percentage)[0]?.id;
}

function withoutBrowserInsights(value) { return value.replace(/<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^"]+"[^>]*data-cf-beacon='[^']*' crossorigin="anonymous"><\/script>\n?/gu, ""); }

function attentionWorkerSource(releaseDigest) {
  return `const ARTICLE = /^\\/posts\\/[a-z0-9]+(?:-[a-z0-9]+)*\\/?$/u;
const AUTOMATED = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|curl|wget|koios-|cloudflare-healthchecks/iu;
const RELEASE = ${JSON.stringify(releaseDigest)};

function assetRequest(request) {
  const url = new URL(request.url);
  const publicPath = url.pathname;
  const file = publicPath === "/"
    ? "/index.html"
    : publicPath.endsWith("/")
      ? \`\${publicPath}index.html\`
      : /\\.[a-z0-9]+$/iu.test(publicPath)
        ? publicPath
        : \`\${publicPath}/index.html\`;
  url.pathname = file;
  return new Request(url, request);
}

function releaseResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Koios-Release", RELEASE);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function countArticleLoad(request, response, env) {
  if (request.method !== "GET" || response.status !== 200 || !ARTICLE.test(new URL(request.url).pathname)) return;
  if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) return;
  if (AUTOMATED.test(request.headers.get("user-agent") || "")) return;
  const path = new URL(request.url).pathname.replace(/\\/$/u, "");
  const observedAt = new Date().toISOString();
  const day = observedAt.slice(0, 10);
  const key = \`article:\${day}:\${encodeURIComponent(path)}\`;
  const prior = await env.${ATTENTION.binding}.get(key, "json");
  const observedLoads = Number.isSafeInteger(prior?.observedLoads) && prior.observedLoads >= 0 ? prior.observedLoads + 1 : 1;
  await env.${ATTENTION.binding}.put(key, JSON.stringify({
    contract: "${ATTENTION.contract}",
    path,
    day,
    observedLoads,
    firstObservedAt: typeof prior?.firstObservedAt === "string" ? prior.firstObservedAt : observedAt,
    lastObservedAt: observedAt,
    excludesRecognizedAutomatedUserAgents: true,
    storesReaderIdentifiers: false,
    storesReferrers: false,
  }));
}

export default {
  async fetch(request, env, ctx) {
    let response = await env.ASSETS.fetch(assetRequest(request));
    if (response.status === 404) {
      const fallback = new URL(request.url);
      fallback.pathname = "/404.html";
      const notFound = await env.ASSETS.fetch(new Request(fallback, request));
      if (notFound.status === 200) response = new Response(notFound.body, { status: 404, headers: notFound.headers });
    }
    ctx.waitUntil(countArticleLoad(request, response, env));
    return releaseResponse(response);
  },
};
`;
}

async function probeOne(artifact, attempt, releaseDigest) {
  const url = new URL(artifact.route, TARGET.origin);
  url.searchParams.set("__koios_release", `${artifact.digest.slice(7, 23)}-${attempt}`);
  const result = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Koios-Primary-Static-Release/1.0", Accept: artifact.mediaType, "Cache-Control": "no-cache" } });
  const bytes = new Uint8Array(await result.arrayBuffer());
  const observed = artifactChecksum(bytes);
  const text = artifact.mediaType.startsWith("text/html") ? Buffer.from(bytes).toString("utf8") : "";
  const normalized = text === "" ? null : withoutBrowserInsights(text);
  const equivalent = observed === artifact.digest || normalized !== null && normalized !== text && textNi(normalized) === artifact.digest;
  const releaseMatched = result.headers.get("x-koios-release") === releaseDigest;
  const noindex = result.headers.get("x-robots-tag")?.toLowerCase().includes("noindex") === true;
  return Object.freeze({ route: artifact.route, status: result.status, expectedDigest: artifact.digest, observedDigest: observed, providerEquivalent: equivalent, releaseMatched, noindex, ok: result.status === 200 && equivalent && releaseMatched && !noindex });
}

async function publicProbes(manifest, articleRoute, releaseDigest) {
  const routes = ["/", "/feed.json", "/sitemap.xml", "/standards", "/corrections", articleRoute];
  const artifacts = routes.map((route) => manifest.artifacts.find((artifact) => artifact.route === route)).filter(Boolean);
  if (artifacts.length !== routes.length) throw new Error("candidate lacks one or more required public probe artifacts");
  let probes = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    probes = await Promise.all(artifacts.map((artifact) => probeOne(artifact, attempt, releaseDigest)));
    if (probes.every((probe) => probe.ok)) return Object.freeze(probes);
    if (attempt < 59) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  return Object.freeze(probes);
}

async function executeRelease(request, inspection) {
  const executable = wranglerExecutable();
  const temp = mkdtempSync(join(tmpdir(), "resource-brokerage-primary-release-"));
  const config = join(temp, "wrangler.json");
  const worker = join(temp, "koios-primary-worker.mjs");
  const assetsRoot = join(temp, "assets");
  // Worker versions already bind an immutable asset manifest atomically.
  // Stable public paths let Wrangler/Cloudflare reuse unchanged content hashes
  // between issues instead of manufacturing a wholly new 20+ MB namespace.
  cpSync(inspection.tree.root, assetsRoot, { recursive: true });
  writeFileSync(worker, attentionWorkerSource(request.artifact.manifestDigest), { encoding: "utf8", mode: 0o600 });
  writeFileSync(config, JSON.stringify({
    name: TARGET.workerName,
    account_id: TARGET.accountId,
    compatibility_date: "2026-07-18",
    main: worker,
    no_bundle: true,
    workers_dev: false,
    preview_urls: false,
    assets: { directory: assetsRoot, binding: "ASSETS", run_worker_first: true, html_handling: "none", not_found_handling: "none" },
    kv_namespaces: [{ binding: ATTENTION.binding, id: ATTENTION.namespaceId }],
  }), { encoding: "utf8", mode: 0o600 });
  try {
    if (request.executionMode === "dry-run") {
      const packaged = subprocess(executable, ["deploy", "--config", config, "--dry-run", "--no-bundle"], temp, undefined, 120_000);
      if (packaged.status !== 0) throw new Error(`provider dry-run packaging failed: ${packaged.evidence.stderrExcerpt ?? packaged.evidence.errorCode ?? packaged.status}`);
      return Object.freeze({ disposition: "packaged", networkCalls: 0, credentialRead: false, packaging: packaged.evidence });
    }
    const token = providerCredential();
    const routeBefore = await inspectRoute(token);
    const statusReading = subprocess(executable, ["deployments", "status", "--name", TARGET.workerName, "--json"], temp, token, 120_000);
    if (statusReading.status !== 0) throw new Error(`could not snapshot current Cloudflare deployment: ${statusReading.evidence.stderrExcerpt ?? statusReading.status}`);
    let status;
    try { status = JSON.parse(statusReading.stdout); } catch { throw new Error("Wrangler returned an unreadable current deployment snapshot"); }
    const rollbackVersion = priorVersion(status);
    if (rollbackVersion === undefined) throw new Error("current Cloudflare deployment snapshot contains no rollback version");
    const deployed = subprocess(executable, ["deploy", "--config", config, "--no-bundle", "--name", TARGET.workerName, "--message", `Koios ${request.publication.assignmentId} ${request.artifact.manifestDigest}`], temp, token);
    if (deployed.status !== 0) throw new Error(`Cloudflare static Worker deployment failed: ${deployed.evidence.stderrExcerpt ?? deployed.status}`);
    const routeAfter = await inspectRoute(token);
    const probes = await publicProbes(inspection.manifest, inspection.articleRoute, request.artifact.manifestDigest);
    if (!probes.every((probe) => probe.ok)) {
      const rolledBack = subprocess(executable, ["rollback", rollbackVersion, "--name", TARGET.workerName, "--message", `Automatic rollback after failed Koios probes for ${request.artifact.manifestDigest}`, "--yes"], temp, token);
      if (rolledBack.status !== 0) throw new Error(`public probes failed and Cloudflare rollback also failed: ${rolledBack.evidence.stderrExcerpt ?? rolledBack.status}`);
      return Object.freeze({ disposition: "rolled-back", routeBefore, routeAfter, priorDeploymentDigest: textNi(statusReading.stdout), rollbackVersion, deployment: deployed.evidence, rollback: rolledBack.evidence, failedCandidateProbes: probes, credentialRead: true, credentialRecorded: false });
    }
    return Object.freeze({ disposition: "released", routeBefore, routeAfter, priorDeploymentDigest: textNi(statusReading.stdout), rollbackVersion, deployment: deployed.evidence, probes, credentialRead: true, credentialRecorded: false });
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function invoke(activity, at) {
  const validated = await validateInvocation(activity, at);
  if (validated.problem) { await reject(activity, validated.problem, at, { networkCalls: 0, credentialRead: false }); return; }
  if (await witnessed(validated.offer.id, "primary-release.offer-consumed", at)) { await reject(activity, "offer-already-consumed", at, { networkCalls: 0, credentialRead: false }); return; }
  await witness(validated.offer, "primary-release.offer-consumed", at, { invocation: activity.id, effect: validated.proposed.semanticId, executionMode: validated.request.executionMode });
  let execution;
  try { execution = await executeRelease(validated.request, validated.inspection); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const evidence = textNi(`primary-release-refusal:${validated.request.executionMode}:${reason}`);
    let effect;
    try {
      effect = await completeEffect(ACTOR, validated.proposed.cell, effectCell(validated.request, validated.offer.object.bindings, { positiveEvidence: false, negativeEvidence: true }, evidence, "1"), evidence, at);
    } catch (transitionError) {
      await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message, networkCalls: 0, credentialRead: false });
      return;
    }
    await reject(activity, reason, at, {
      networkCalls: validated.request.executionMode === "live" ? "bounded-by-contract" : 0,
      credentialRecorded: false,
      effect,
    }); return;
  }
  if (execution.disposition === "rolled-back") {
    const deploymentEvidence = textNi(`primary-release-deployed:${validated.offer.object.bindings.artifactTreeDigest}:${execution.deployment.stdoutDigest}`);
    const rollbackEvidence = textNi(`primary-release-contradicted-and-restored:${validated.offer.object.bindings.artifactTreeDigest}:${execution.rollback.stdoutDigest}`);
    let deploymentEffect;
    let rollbackEffect;
    try {
      const deployedCell = effectCell(validated.request, validated.offer.object.bindings, { positiveEvidence: true, negativeEvidence: false }, deploymentEvidence, "1");
      deploymentEffect = await completeEffect(ACTOR, validated.proposed.cell, deployedCell, deploymentEvidence, at);
      const rolledBackCell = effectCell(validated.request, validated.offer.object.bindings, { positiveEvidence: true, negativeEvidence: true }, rollbackEvidence, "2");
      rollbackEffect = await completeEffect(ACTOR, deployedCell, rolledBackCell, rollbackEvidence, at);
    } catch (transitionError) {
      await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message, credentialRecorded: false });
      return;
    }
    await reject(activity, "candidate failed public probes and the prior Cloudflare Worker version was restored", at, {
      execution,
      publicAuthority: "prior-cloudflare-worker-version",
      vpsPublicOrigin: false,
      effects: [deploymentEffect, rollbackEffect],
    }); return;
  }
  const evidence = textNi(`primary-release:${execution.disposition}:${validated.offer.object.bindings.artifactTreeDigest}`);
  let effect;
  try { effect = await completeEffect(ACTOR, validated.proposed.cell, effectCell(validated.request, validated.offer.object.bindings, { positiveEvidence: true, negativeEvidence: false }, evidence, "1"), evidence, at); }
  catch (transitionError) { await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message }); return; }
  const object = { type: execution.disposition === "released" ? "CloudflarePrimaryStaticReleaseReceipt" : "CloudflarePrimaryStaticPackagingResult", contract: CONTRACT, disposition: execution.disposition, bindings: validated.offer.object.bindings, execution, effect, publicAuthority: execution.disposition === "released" ? "cloudflare-worker:koios-news-primary" : "unchanged", routeMutated: false, dnsMutated: false, vpsPublicOrigin: false, credentialRecorded: false };
  await witness(activity, "primary-release.completed", at, { disposition: execution.disposition, witness: effect.witness, publicAuthority: object.publicAuthority });
  emit(response("Accept", activity, object));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = atInstant();
  let activity;
  try { activity = input(); } catch (error) { await reject({}, `invalid JSON input: ${error instanceof Error ? error.message : String(error)}`, at); }
  if (activity !== undefined) {
    if (operation() === "solicit-primary-release") await solicit(activity, at);
    else if (operation() === "invoke-primary-release") await invoke(activity, at);
    else await reject(activity, `unknown primary-release operation ${operation()}`, at);
  }
}
