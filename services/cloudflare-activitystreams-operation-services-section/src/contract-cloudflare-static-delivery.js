#!/usr/bin/env node

import { randomUUID } from "node:crypto";
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { artifactChecksum, completeEffect, proposeEffect, semanticBytesId, textNi } from "@red-cup-engineering/a2a-effect-assay-services-section/effect-assay";
import { witnessJournalBindingFromArgv, wasWitnessed, recordWitnessedBoundaryAct } from "./removed-witness-journal.mjs";

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const NODE_ID = "resource-brokerage-service-section";
const ACTOR = `urn:ame:${NODE_ID}`;
const CONTRACT = "cloudflare-static-delivery/v2";
const NODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAW_PATH = join(NODE_ROOT, "lib", "law", "cloudflare-static-delivery.rml");
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OFFER_LIFETIME_MS = 60 * 60 * 1000;
const ARTIFACT_PROFILES = Object.freeze(["shadow", "cutover-candidate"]);
const PREVIEW_NOINDEX = "X-Robots-Tag: noindex, nofollow, noarchive";
const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CAIP10 = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/u;
const LOCAL_EFFECTS = Object.freeze([
  "customer-read-only-filesystem",
  "local-subprocess",
  "provider-local-append-only-evidence",
]);
const WitnessJournal = witnessJournalBindingFromArgv();

function arg(flag) { const index = process.argv.indexOf(flag); return index === -1 ? undefined : process.argv[index + 1]; }
function operation() { return arg("--operation") ?? "solicit-service"; }
function instant() { return arg("--now") ?? new Date().toISOString(); }
function input() { return JSON.parse(readFileSync(0, "utf8")); }
function literal(value) { return JSON.stringify(String(value)); }
function witness(activity, outcome, at, details = {}) { return recordWitnessedBoundaryAct(activity, outcome, at, CONTRACT, details, WitnessJournal); }
function witnessed(subject, outcome, at) { return wasWitnessed(subject, outcome, at, WitnessJournal); }
function response(type, source, object) {
  return {
    "@context": CONTEXT,
    id: `urn:uuid:${randomUUID()}`,
    type,
    actor: ACTOR,
    target: source?.actor ?? "urn:ame:unidentified-customer",
    inReplyTo: source?.id ?? "urn:activity:unidentified",
    object,
  };
}
function emit(value, code = 0) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exitCode = code; }
async function reject(source, reason, at, details = {}) {
  const value = response("Reject", source, { type: "Refusal", contract: CONTRACT, reason, ...details });
  await witness(source, "activity.rejected", at, { reason, unmet: details.unmet ?? [] }); emit(value, 2);
}
function attachments(note) { return Array.isArray(note?.attachment) ? note.attachment : note?.attachment === undefined ? [] : [note.attachment]; }
function isSha256(value) { return typeof value === "string" && NI.test(value); }
function safeId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value); }
function safeHostname(value) {
  return typeof value === "string"
    && value.length <= 253
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value);
}
function validInstant(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)
    && !Number.isNaN(Date.parse(value));
}

function stripJsonComments(source) {
  let result = ""; let quoted = false; let escaped = false; let line = false; let block = false;
  for (let index = 0; index < source.length; index += 1) {
    const here = source[index]; const next = source[index + 1];
    if (line) { if (here === "\n") { line = false; result += here; } continue; }
    if (block) { if (here === "*" && next === "/") { block = false; index += 1; } continue; }
    if (!quoted && here === "/" && next === "/") { line = true; index += 1; continue; }
    if (!quoted && here === "/" && next === "*") { block = true; index += 1; continue; }
    result += here;
    if (quoted) {
      if (escaped) escaped = false;
      else if (here === "\\") escaped = true;
      else if (here === "\"") quoted = false;
    } else if (here === "\"") quoted = true;
  }
  return result.replace(/,\s*([}\]])/gu, "$1");
}

function fileReading(path) {
  const resolved = resolve(path); const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${resolved} must be a regular non-symlink file`);
  const bytes = readFileSync(resolved);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${resolved} exceeds the ${MAX_FILE_BYTES}-byte file bound`);
  return Object.freeze({ path: resolved, digest: artifactChecksum(bytes), bytes: bytes.length, raw: bytes });
}

function treeReading(rootPath) {
  const root = resolve(rootPath); const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`${root} must be a regular non-symlink directory`);
  const files = []; let totalBytes = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${path}`);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile()) throw new Error(`artifact tree contains a non-file entry: ${path}`);
      const reading = fileReading(path); const rel = relative(root, path).split(sep).join("/");
      totalBytes += reading.bytes;
      files.push(Object.freeze({ path: rel, bytes: reading.bytes, digest: reading.digest }));
      if (files.length > MAX_FILES) throw new Error(`artifact tree exceeds the ${MAX_FILES}-file bound`);
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`artifact tree exceeds the ${MAX_TOTAL_BYTES}-byte total bound`);
    }
  }
  visit(root);
  const carrier = files.map((file) => `<urn:path:${encodeURIComponent(file.path)}> <urn:rmn:bytes> ${literal(file.bytes)}; <urn:rmn:content> <${file.digest}> .`).join("\n");
  return Object.freeze({ path: root, digest: artifactChecksum(Buffer.from(`${carrier}\n`, "utf8")), fileCount: files.length, totalBytes, largestFileBytes: Math.max(0, ...files.map((file) => file.bytes)), files: Object.freeze(files) });
}

function configReading(path) {
  const reading = fileReading(path); let config;
  try { config = JSON.parse(stripJsonComments(reading.raw.toString("utf8"))); }
  catch (error) { throw new Error(`Wrangler configuration is not valid JSONC: ${error.message}`); }
  const allowedTop = new Set(["$schema", "name", "compatibility_date", "workers_dev", "preview_urls", "assets", "send_metrics"]);
  const forbidden = Object.keys(config).filter((key) => !allowedTop.has(key));
  if (forbidden.length) throw new Error(`Wrangler configuration exceeds static-preview scope: ${forbidden.join(", ")}`);
  if (config.workers_dev !== true || config.preview_urls !== true) throw new Error("Wrangler configuration must enable workers_dev and preview_urls");
  if (!config.assets || typeof config.assets !== "object" || Array.isArray(config.assets)) throw new Error("Wrangler configuration must carry static assets");
  const allowedAssets = new Set(["directory", "html_handling", "not_found_handling"]);
  const forbiddenAssets = Object.keys(config.assets).filter((key) => !allowedAssets.has(key));
  if (forbiddenAssets.length) throw new Error(`Wrangler assets configuration exceeds static-preview scope: ${forbiddenAssets.join(", ")}`);
  return Object.freeze({ path: reading.path, digest: reading.digest, bytes: reading.bytes, config });
}

function normalizedRequest(sourceActivity) {
  const request = attachments(sourceActivity?.object).find((item) => item?.type === "CloudflareStaticDeliveryRequest");
  if (!request) return null;
  return {
    executionMode: request.executionMode,
    wrangler: request.wrangler,
    config: request.config,
    artifact: request.artifact,
    deliveryPolicy: request.deliveryPolicy,
    hostname: request.hostname,
    expiresAt: request.expiresAt,
    timeoutMilliseconds: request.timeoutMilliseconds ?? 60_000,
    caller: request.caller,
    parentEffect: request.parentEffect ?? null,
    ...(request.cloudflare === undefined ? {} : { cloudflare: request.cloudflare }),
  };
}

function inspectRequest(request, at) {
  const problems = [];
  if (!request || !["dry-run", "live-preview"].includes(request.executionMode)) problems.push("executionMode(dry-run|live-preview)");
  if (!request?.wrangler || !isAbsolute(request.wrangler.executable ?? "") || !isSha256(request.wrangler.digest) || typeof request.wrangler.version !== "string" || request.wrangler.version.length === 0) problems.push("wrangler{executable,digest,version}");
  if (!request?.config || !isAbsolute(request.config.path ?? "") || !isSha256(request.config.digest)) problems.push("config{path,digest}");
  if (!request?.artifact
    || !isAbsolute(request.artifact.path ?? "")
    || !isSha256(request.artifact.digest)
    || !ARTIFACT_PROFILES.includes(request.artifact.profile)
    || !isSha256(request.artifact.manifestDigest)
    || !isSha256(request.artifact.livePublicationWitnessDigest)) {
    problems.push("artifact{path,digest,profile,manifestDigest,livePublicationWitnessDigest}");
  }
  if (!request?.deliveryPolicy || !isSha256(request.deliveryPolicy.digest)) problems.push("deliveryPolicy{digest}");
  if (!safeHostname(request?.hostname)) problems.push("hostname");
  if (!validInstant(request?.expiresAt)) problems.push("expiresAt(explicit-UTC-instant)");
  else {
    const remaining = Date.parse(request.expiresAt) - Date.parse(at);
    if (!(remaining > 0 && remaining <= MAX_OFFER_LIFETIME_MS)) problems.push(`expiresAt(>now and <=${MAX_OFFER_LIFETIME_MS}ms)`);
  }
  if (!Number.isInteger(request?.timeoutMilliseconds) || request.timeoutMilliseconds < 1 || request.timeoutMilliseconds > MAX_TIMEOUT_MS) problems.push(`timeoutMilliseconds(1..${MAX_TIMEOUT_MS})`);
  if (!CAIP10.test(request?.caller ?? "")) problems.push("caller(CAIP-10)");
  if (request?.parentEffect !== null && !NI.test(request?.parentEffect ?? "")) problems.push("parentEffect(RMN-ni-or-null)");
  if (!CAIP10.test(process.env.RESOURCE_BROKERAGE_PROVIDER_CAIP10 ?? "")) problems.push("provider(CAIP-10)");
  if (request?.executionMode === "live-preview") {
    if (!request.cloudflare || !safeId(request.cloudflare.accountId)) problems.push("cloudflare.accountId");
    if (!request.cloudflare || !safeId(request.cloudflare.workerName)) problems.push("cloudflare.workerName");
    if (request.cloudflare && (
      typeof request.cloudflare !== "object"
      || Array.isArray(request.cloudflare)
      || Object.keys(request.cloudflare).some((key) => !["accountId", "workerName"].includes(key))
    )) problems.push("cloudflare{accountId,workerName only}");
  }
  if (problems.length) return { problems: [...new Set(problems)] };
  try {
    const executable = fileReading(request.wrangler.executable);
    if ((lstatSync(executable.path).mode & 0o111) === 0) problems.push("wrangler executable is not executable");
    if (executable.digest !== request.wrangler.digest) problems.push("wrangler executable digest mismatch");
    const config = configReading(request.config.path);
    if (config.digest !== request.config.digest) problems.push("Wrangler configuration digest mismatch");
    if (request.executionMode === "live-preview" && config.config.name !== request.cloudflare.workerName) problems.push("Wrangler configuration name does not match cloudflare.workerName");
    const artifact = treeReading(request.artifact.path);
    if (artifact.digest !== request.artifact.digest) problems.push("artifact tree digest mismatch");
    const manifest = fileReading(join(artifact.path, "manifest.json")); let manifestValue;
    try { manifestValue = JSON.parse(manifest.raw.toString("utf8")); }
    catch (error) { problems.push(`artifact manifest is not valid JSON: ${error.message}`); }
    if (manifest.digest !== request.artifact.manifestDigest) problems.push("artifact manifest digest mismatch");
    if (manifestValue?.profile !== request.artifact.profile) problems.push("artifact manifest profile mismatch");
    if (manifestValue?.livePublicationWitnessDigest !== request.artifact.livePublicationWitnessDigest) problems.push("artifact live-publication-witness digest mismatch");
    const deliveryPolicy = fileReading(join(artifact.path, "_headers"));
    if (deliveryPolicy.digest !== request.deliveryPolicy.digest) problems.push("delivery policy digest mismatch");
    const policyText = deliveryPolicy.raw.toString("utf8");
    if (!/^\/\*\r?\n/u.test(policyText)) problems.push("delivery policy must begin with a Cloudflare wildcard header rule");
    const hasNoindex = /X-Robots-Tag:\s*[^\n]*noindex/iu.test(policyText);
    if (request.artifact.profile === "shadow" && !hasNoindex) problems.push("shadow delivery policy lacks noindex");
    if (request.artifact.profile === "cutover-candidate" && hasNoindex) problems.push("cutover-candidate delivery policy already carries noindex instead of requiring the preview overlay");
    return { problems, readings: { executable, config, artifact, manifest, deliveryPolicy } };
  } catch (error) { problems.push(error.message); return { problems }; }
}

function recognizes(sourceActivity) {
  const content = sourceActivity?.object?.content;
  return normalizedRequest(sourceActivity) !== null || (typeof content === "string" && /cloudflare.+static|static.+cloudflare/iu.test(content));
}
function offeredEffects(request) {
  return Object.freeze([
    ...LOCAL_EFFECTS,
    ...(request.artifact.profile === "cutover-candidate" ? ["preview-noindex-overlay"] : []),
    ...(request.executionMode === "live-preview" ? [
      "external-network",
      `cloudflare-account:${request.cloudflare.accountId}`,
      `cloudflare-worker:${request.cloudflare.workerName}`,
      `cloudflare-hostname:${request.hostname}`,
      "cloudflare-preview-upload",
    ] : []),
  ]);
}

function settledTerms(request, readings) {
  const effects = offeredEffects(request);
  const bindings = Object.freeze({
    artifactProfile: request.artifact.profile,
    artifactTreeDigest: readings.artifact.digest,
    artifactManifestDigest: readings.manifest.digest,
    livePublicationWitnessDigest: request.artifact.livePublicationWitnessDigest,
    deliveryPolicyDigest: readings.deliveryPolicy.digest,
    hostname: request.hostname,
    ...(request.cloudflare === undefined ? {} : {
      accountId: request.cloudflare.accountId,
      workerName: request.cloudflare.workerName,
    }),
    expiresAt: request.expiresAt,
    effects,
    effectsIdentity: textNi(effects.join("\n")),
  });
  const scope = Object.freeze({
    executionMode: request.executionMode,
    wrangler: { executable: readings.executable.path, digest: readings.executable.digest, version: request.wrangler.version },
    config: { path: readings.config.path, digest: readings.config.digest },
    artifact: {
      path: readings.artifact.path,
      digest: readings.artifact.digest,
      fileCount: readings.artifact.fileCount,
      totalBytes: readings.artifact.totalBytes,
      profile: request.artifact.profile,
      manifestDigest: readings.manifest.digest,
      livePublicationWitnessDigest: request.artifact.livePublicationWitnessDigest,
    },
    deliveryPolicy: { digest: readings.deliveryPolicy.digest },
    hostname: request.hostname,
    expiresAt: request.expiresAt,
    effectsIdentity: bindings.effectsIdentity,
    timeoutMilliseconds: request.timeoutMilliseconds,
    ...(request.cloudflare === undefined ? {} : {
      cloudflare: {
        accountId: request.cloudflare.accountId,
        workerName: request.cloudflare.workerName,
      },
    }),
  });
  return Object.freeze({ effects, bindings, scope });
}

function effectCell(request, bindings, outcome, evidenceRoot, witQuantity = "0") {
  return {
    law: semanticBytesId("resource-brokerage.static-delivery-law", readFileSync(LAW_PATH)),
    caller: request.caller,
    provider: process.env.RESOURCE_BROKERAGE_PROVIDER_CAIP10,
    precondition: textNi(`static-delivery:${bindings.artifactTreeDigest}:${bindings.expiresAt}`),
    operation: textNi(`cloudflare-static-delivery:${request.executionMode}:${bindings.effectsIdentity}`),
    postcondition: textNi("CloudflareStaticDeliveryResult{disposition,effect}"),
    refusal: textNi("CloudflareStaticDeliveryRefusal{reason,effect}"),
    evidenceRoot,
    outcome,
    measures: [
      { dimension: "cloudflare-static-delivery", quantity: request.executionMode === "live-preview" ? "2" : "1", unit: "service-act" },
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
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Offer" || activity.target !== ACTOR || activity.object?.type !== "ServiceSolicitation") {
    await reject(activity, "solicitation must be an ActivityStreams Offer<ServiceSolicitation> addressed to this provider", at); return;
  }
  const sourceActivity = activity.object.sourceActivity;
  if (!recognizes(sourceActivity)) { await reject(activity, "source intent does not request Cloudflare static delivery", at); return; }
  const request = normalizedRequest(sourceActivity); const inspection = inspectRequest(request, at);
  if (inspection.problems.length) {
    const question = response("Question", activity, { type: "ServiceTermsRequired", contract: CONTRACT, sourceActivity: sourceActivity?.id, missing: inspection.problems });
    await witness(activity, "terms.requested", at, { missing: inspection.problems }); emit(question); return;
  }
  const { effects, bindings, scope } = settledTerms(request, inspection.readings);
  let effect;
  try { effect = await proposedEffect(sourceActivity, request, bindings, at); }
  catch (error) { await reject(activity, "rmn-conformance-refused", at, { detail: error.message }); return; }
  const object = {
    type: "ExecutableServiceOffer",
    contract: CONTRACT,
    sourceActivity: sourceActivity.id,
    request,
    scope,
    bindings,
    operation: "invoke-service",
    effects,
    effect: { semanticId: effect.semanticId, evidence: effect.evidence, conformance: effect.conformance },
    evidence: ["provider-authored-packaging-or-preview-result", "pinned-input-digests", "bounded-subprocess-observation", "provider-local-causal-events"],
    exclusions: ["credential-custody", "dns", "custom-domain", "route-binding", "cutover", "primary-delivery-authority"],
  };
  const offer = response("Offer", activity, object);
  await witness(offer, "offer.emitted", at, {
    offer: offer.id,
    executionMode: request.executionMode,
    artifactProfile: bindings.artifactProfile,
    hostname: bindings.hostname,
    expiresAt: bindings.expiresAt,
    effect: effect.semanticId,
  }); emit(offer);
}

async function validateInvocation(activity, at) {
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Accept" || activity.target !== ACTOR) return { problem: "invocation must be an ActivityStreams Accept addressed to this provider" };
  const contract = activity.object;
  if (contract?.type !== "ServiceContract" || contract.contract !== CONTRACT) return { problem: `invocation must accept ${CONTRACT}` };
  const offer = contract.offer;
  if (offer?.type !== "Offer" || offer.actor !== ACTOR || offer.object?.type !== "ExecutableServiceOffer" || offer.object?.contract !== CONTRACT) return { problem: "ServiceContract must carry this provider's executable Offer" };
  const request = offer.object.request;
  const inspection = inspectRequest(request, at);
  if (inspection.problems.length) return { problem: `accepted request no longer satisfies provider terms: ${inspection.problems.join(", ")}` };
  const expected = settledTerms(request, inspection.readings);
  if (!isDeepStrictEqual(expected.scope, offer.object.scope)) return { problem: "provider scope no longer matches the pinned filesystem evidence" };
  if (!isDeepStrictEqual(expected.bindings, offer.object.bindings)) return { problem: "provider bindings no longer match the pinned publication and delivery evidence" };
  if (!isDeepStrictEqual(expected.effects, offer.object.effects)) return { problem: "provider effects no longer match the bounded request" };
  if (!isDeepStrictEqual(contract.bindings, offer.object.bindings)) return { problem: "invocation does not preserve the provider-authored bindings" };
  let proposed;
  try { proposed = await proposedEffect({ id: offer.object.sourceActivity }, request, expected.bindings, at); }
  catch (error) { return { problem: `rmn-conformance-refused: ${error.message}` }; }
  if (proposed.semanticId !== offer.object.effect?.semanticId) return { problem: "effect-commitment-drift" };
  return { offer, request, proposed };
}

function subprocessEnvironment(request, temp) {
  const env = {
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH,
    CI: "true",
    NO_COLOR: "1",
    WRANGLER_SEND_METRICS: "false",
    XDG_CONFIG_HOME: join(temp, "xdg-config"),
  };
  if (request.executionMode === "live-preview") {
    env.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    env.CLOUDFLARE_ACCOUNT_ID = request.cloudflare.accountId;
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

function preparedArtifact(request, source, temp) {
  if (request.artifact.profile !== "cutover-candidate") {
    return Object.freeze({
      path: source.path,
      digest: source.digest,
      fileCount: source.fileCount,
      totalBytes: source.totalBytes,
      largestFileBytes: source.largestFileBytes,
      overlay: null,
    });
  }
  const path = join(temp, "preview-noindex-assets");
  cpSync(source.path, path, { recursive: true, dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true });
  const headersPath = join(path, "_headers");
  const sourceHeaders = readFileSync(headersPath, "utf8");
  if (!/^\/\*\r?\n/u.test(sourceHeaders)) throw new Error("cutover-candidate delivery policy cannot receive a wildcard preview overlay");
  if (/X-Robots-Tag:\s*[^\n]*noindex/iu.test(sourceHeaders)) throw new Error("cutover-candidate already carries preview noindex");
  const overlaidHeaders = sourceHeaders.replace(/^\/\*\r?\n/u, `/*\n  ${PREVIEW_NOINDEX}\n`);
  writeFileSync(headersPath, overlaidHeaders, "utf8");
  const reading = treeReading(path);
  return Object.freeze({
    path: reading.path,
    digest: reading.digest,
    fileCount: reading.fileCount,
    totalBytes: reading.totalBytes,
    largestFileBytes: reading.largestFileBytes,
    overlay: Object.freeze({
      effect: "preview-noindex-overlay",
      sourceDeliveryPolicyDigest: textNi(sourceHeaders),
      previewDeliveryPolicyDigest: textNi(overlaidHeaders),
      header: PREVIEW_NOINDEX,
      customerArtifactMutated: false,
    }),
  });
}

function execute(request) {
  const temp = mkdtempSync(join(tmpdir(), "resource-brokerage-cloudflare-")); const outdir = join(temp, "wrangler-output");
  const started = Date.now();
  try {
    const sourceArtifact = treeReading(request.artifact.path);
    const uploadArtifact = preparedArtifact(request, sourceArtifact, temp);
    const args = [
      "deploy",
      "--config", request.config.path,
      "--assets", uploadArtifact.path,
      "--outdir", outdir,
      ...(request.executionMode === "dry-run" ? ["--dry-run"] : ["--name", request.cloudflare.workerName]),
    ];
    const stdoutPath = join(temp, "wrangler.stdout");
    const stderrPath = join(temp, "wrangler.stderr");
    const stdoutFd = openSync(stdoutPath, "w+");
    const stderrFd = openSync(stderrPath, "w+");
    let result;
    try {
      result = spawnSync(request.wrangler.executable, args, {
        cwd: temp,
        stdio: ["ignore", stdoutFd, stderrFd],
        timeout: request.timeoutMilliseconds,
        env: subprocessEnvironment(request, temp),
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    const stdout = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8");
    const redactDiagnostic = (value) => {
      const credential = process.env.CLOUDFLARE_API_TOKEN;
      const withoutCredential = typeof credential === "string" && credential.length > 0
        ? value.replaceAll(credential, "[REDACTED]")
        : value;
      return withoutCredential
        .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]")
        .slice(-4_000);
    };
    const output = treeReading(outdir);
    return {
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code,
      wallTimeMilliseconds: Date.now() - started,
      stdoutDigest: textNi(stdout),
      stderrDigest: textNi(stderr),
      ...(result.status === 0 ? {} : {
        stdoutExcerpt: redactDiagnostic(stdout),
        stderrExcerpt: redactDiagnostic(stderr),
      }),
      output: { digest: output.digest, fileCount: output.fileCount, totalBytes: output.totalBytes, largestFileBytes: output.largestFileBytes },
      uploadArtifact: {
        digest: uploadArtifact.digest,
        fileCount: uploadArtifact.fileCount,
        totalBytes: uploadArtifact.totalBytes,
        largestFileBytes: uploadArtifact.largestFileBytes,
        overlay: uploadArtifact.overlay,
      },
      command: { executable: request.wrangler.executable, args, timeoutMilliseconds: request.timeoutMilliseconds },
      previewUrls: request.executionMode === "live-preview" ? [...`${stdout}\n${stderr}`.matchAll(/https:\/\/[a-z0-9.-]+\.(?:workers\.dev|pages\.dev)\/?/giu)].map((match) => match[0]) : [],
    };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function invoke(activity, at) {
  const validated = await validateInvocation(activity, at);
  if (validated.problem) {
    const live = activity?.object?.offer?.object?.request?.executionMode === "live-preview";
    await reject(activity, validated.problem, at, {
      unmet: ["accepted-rmn-effect"],
      ...(live ? { networkCalls: 0, subprocessesStarted: 0 } : {}),
    }); return;
  }
  const { offer, request, proposed } = validated;
  if (await witnessed(offer.id, "offer.consumed", at)) { await reject(activity, "offer-already-consumed", at, { networkCalls: 0, subprocessesStarted: 0 }); return; }
  await witness(offer, "offer.consumed", at, { invocation: activity.id, effect: proposed.semanticId });
  if (request.executionMode === "live-preview") {
    if (typeof process.env.CLOUDFLARE_API_TOKEN !== "string" || process.env.CLOUDFLARE_API_TOKEN.length === 0) {
      const evidence = textNi("static-delivery-refusal:cloudflare-credential-injection");
      let effect;
      try { effect = await completeEffect(ACTOR, proposed.cell, effectCell(request, offer.object.bindings, { positiveEvidence: false, negativeEvidence: true }, evidence, "1"), evidence, at); }
      catch (error) { await reject(activity, "rmn-completion-refused", at, { detail: error.message }); return; }
      await reject(activity, "the contracted Cloudflare account operation has no credential injected into this provider process", at, {
        unmet: ["cloudflare-credential-injection"],
        networkCalls: 0,
        subprocessesStarted: 0,
        effect,
      }); return;
    }
  }
  let execution;
  try { execution = execute(request); }
  catch (error) {
    const evidence = textNi(`static-delivery-refusal:execution-threw:${error.message}`);
    let effect;
    try { effect = await completeEffect(ACTOR, proposed.cell, effectCell(request, offer.object.bindings, { positiveEvidence: false, negativeEvidence: true }, evidence, "1"), evidence, at); }
    catch (transitionError) { await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message }); return; }
    await reject(activity, "Cloudflare delivery execution failed before producing a bounded subprocess result", at, {
      effect,
      networkCalls: request.executionMode === "dry-run" ? 0 : "bounded-by-wrangler",
    }); return;
  }
  if (execution.status !== 0) {
    const evidence = textNi(`static-delivery-refusal:subprocess:${execution.status}:${execution.output.digest}`);
    let effect;
    try { effect = await completeEffect(ACTOR, proposed.cell, effectCell(request, offer.object.bindings, { positiveEvidence: false, negativeEvidence: true }, evidence, "1"), evidence, at); }
    catch (transitionError) { await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message }); return; }
    await reject(activity, request.executionMode === "dry-run" ? "Wrangler dry-run packaging failed" : "Cloudflare live-preview upload failed", at, {
      execution: { ...execution, previewUrls: undefined },
      effect,
      networkCalls: request.executionMode === "dry-run" ? 0 : "bounded-by-wrangler",
    }); return;
  }
  if (request.executionMode === "live-preview") {
    const expectedHost = request.hostname.toLowerCase();
    const matched = execution.previewUrls.some((value) => {
      try { return new URL(value).hostname.toLowerCase() === expectedHost; }
      catch { return false; }
    });
    if (!matched) {
      const evidence = textNi(`static-delivery-refusal:hostname:${request.hostname}:${execution.previewUrls.length}`);
      let effect;
      try { effect = await completeEffect(ACTOR, proposed.cell, effectCell(request, offer.object.bindings, { positiveEvidence: false, negativeEvidence: true }, evidence, "1"), evidence, at); }
      catch (transitionError) { await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message }); return; }
      await reject(activity, "Cloudflare live-preview result did not witness the exactly bound preview hostname", at, {
        unmet: ["bound-preview-hostname"],
        execution: { ...execution, previewUrls: undefined },
        expectedHostname: request.hostname,
        networkCalls: "bounded-by-wrangler",
        effect,
      }); return;
    }
  }
  const artifact = treeReading(request.artifact.path);
  const common = {
    contract: CONTRACT,
    sourceActivity: offer.object.sourceActivity,
    providerScope: offer.object.scope,
    bindings: offer.object.bindings,
    packaging: {
      wrangler: request.wrangler,
      config: request.config,
      artifact: { path: artifact.path, digest: artifact.digest, fileCount: artifact.fileCount, totalBytes: artifact.totalBytes, largestFileBytes: artifact.largestFileBytes },
      execution,
    },
    exclusions: offer.object.exclusions,
  };
  const object = request.executionMode === "dry-run"
    ? { type: "CloudflareStaticPackagingResult", ...common, disposition: "packaged", dryRun: true, observations: { networkCalls: 0, cloudflareCredentialsInjected: false, providerLocalRecordsAppended: true } }
    : { type: "CloudflareStaticPreviewResult", ...common, disposition: "preview-uploaded", dryRun: false, observations: { networkCalls: "bounded-by-wrangler", cloudflareCredentialsInjected: true, credentialRecorded: false, providerLocalRecordsAppended: true } };
  const evidence = textNi(`static-delivery:${request.executionMode}:${artifact.digest}:${execution.output.digest}:${execution.uploadArtifact.digest}:${request.hostname}`);
  try { object.effect = await completeEffect(ACTOR, proposed.cell, effectCell(request, offer.object.bindings, { positiveEvidence: true, negativeEvidence: false }, evidence, "1"), evidence, at); }
  catch (transitionError) { await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message }); return; }
  await witness(activity, "contract.completed", at, {
    executionMode: request.executionMode,
    artifactProfile: request.artifact.profile,
    artifactDigest: artifact.digest,
    artifactManifestDigest: request.artifact.manifestDigest,
    livePublicationWitnessDigest: request.artifact.livePublicationWitnessDigest,
    deliveryPolicyDigest: request.deliveryPolicy.digest,
    hostname: request.hostname,
    expiresAt: request.expiresAt,
    effectsIdentity: offer.object.bindings.effectsIdentity,
    packagingOutputDigest: execution.output.digest,
    previewUploadArtifactDigest: execution.uploadArtifact.digest,
    effectWitness: object.effect.witness,
  });
  emit(response("Accept", activity, object));
}

const at = instant(); let activity;
try { activity = input(); } catch (error) { await reject({}, `invalid JSON input: ${error.message}`, at); }
if (activity !== undefined) {
  if (operation() === "solicit-service") await solicit(activity, at);
  else if (operation() === "invoke-service") await invoke(activity, at);
  else await reject(activity, `unknown provider operation ${operation()}`, at);
}
