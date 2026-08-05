import assert from "node:assert/strict";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startRmnProviderProcess } from "@red-cup-engineering/rmn-semantic-conformance/test-provider";
import { makeNiUri } from "@red-cup-engineering/ni-uri-services-section";
import { startWitnessJournalProviderProcess } from "@lenticule-science/witness-journal-rdf-projection-service/test-provider";
import { startWitTransitionAssayProcess } from "@lenticule-science/wit-transition-assay/test-provider";
import { queryWitnessJournalDocumentsByCategory } from "@lenticule-science/witness-journal-rdf-projection-service/client";
import { createWitnessJournalDataRootBinding } from "../src/witness-journal-binding.js";

let rmnProvider, witnessJournalProvider, witProvider;
const rawNi = (bytes) => makeNiUri(Buffer.from(bytes));
const WITNESS_JOURNAL_DATA_ROOT = mkdtempSync(join(tmpdir(), "resource-brokerage-witness-journal-test-"));
test.before(async () => {
  rmnProvider = await startRmnProviderProcess();
  witnessJournalProvider = await startWitnessJournalProviderProcess();
  witProvider = await startWitTransitionAssayProcess({ witnessJournalAgentUrl: witnessJournalProvider.agentCardUrl });
  process.env.RMN_CONFORMANCE_AGENT = rmnProvider.agentCardUrl;
  process.env.WITNESS_JOURNAL_RDF_AGENT = witnessJournalProvider.agentCardUrl;
  process.env.WIT_TRANSITION_ASSAY_AGENT = witProvider.agentCardUrl;
});
test.after(async () => {
  delete process.env.RMN_CONFORMANCE_AGENT;
  delete process.env.WITNESS_JOURNAL_RDF_AGENT;
  delete process.env.WIT_TRANSITION_ASSAY_AGENT;
  await witProvider?.close();
  await witnessJournalProvider?.close();
  await rmnProvider?.close();
  rmSync(WITNESS_JOURNAL_DATA_ROOT, { recursive: true, force: true });
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER = join(ROOT, "src", "contract-cloudflare-static-delivery.js");
const CONTEXT = "https://www.w3.org/ns/activitystreams";
const ACTOR = "urn:ame:resource-brokerage-service-section";
const CUSTOMER = "urn:ame:leader-movement-team";
const NOW = "2099-07-18T12:00:00.000Z";
const EXPIRES = "2099-07-18T12:30:00.000Z";
const CALLER = "eip155:31337:0x1111111111111111111111111111111111111111";
const PROVIDER_ACCOUNT = "eip155:31337:0x2222222222222222222222222222222222222222";

const WITNESS_DIGEST = rawNi(Buffer.from("publication-witness", "utf8"));
function treeDigest(root, entries) {
  const files = entries.map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path: path.split(sep).join("/"), bytes: bytes.length, digest: rawNi(bytes) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const rows = files.map((file) => `<urn:path:${encodeURIComponent(file.path)}> <urn:rmn:bytes> ${JSON.stringify(String(file.bytes))}; <urn:rmn:content> <${file.digest}> .`).join("\n");
  return rawNi(Buffer.from(`${rows}\n`, "utf8"));
}
function cleanupEvidence() { rmSync(WITNESS_JOURNAL_DATA_ROOT, { recursive: true, force: true }); }
function fixture(profile = "shadow") {
  const root = mkdtempSync(join(tmpdir(), "resource-brokerage-test-"));
  const artifact = join(root, "artifact"); mkdirSync(join(artifact, "posts", "one"), { recursive: true });
  writeFileSync(join(artifact, "index.html"), "<h1>static</h1>\n", "utf8");
  writeFileSync(join(artifact, "posts", "one", "index.html"), "<p>one</p>\n", "utf8");
  const manifest = `${JSON.stringify({ kind: "koios.static-publication-manifest", profile, livePublicationWitnessDigest: WITNESS_DIGEST }, null, 2)}\n`;
  const headers = profile === "shadow"
    ? "/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Referrer-Policy: no-referrer\n"
    : "/*\n  Referrer-Policy: no-referrer\n";
  writeFileSync(join(artifact, "manifest.json"), manifest, "utf8");
  writeFileSync(join(artifact, "_headers"), headers, "utf8");
  const artifactEntries = ["_headers", "index.html", "manifest.json", "posts/one/index.html"];
  const config = join(root, "wrangler.jsonc");
  writeFileSync(config, `${JSON.stringify({ name: "test-preview", compatibility_date: "2099-07-18", workers_dev: true, preview_urls: true, assets: { directory: artifact, html_handling: "drop-trailing-slash", not_found_handling: "404-page" } }, null, 2)}\n`, "utf8");
  const marker = join(root, "live-network-capable-subprocess-started");
  const wrangler = join(root, "fake-wrangler.mjs");
  writeFileSync(wrangler, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--outdir");
if (outIndex < 0 || !args[outIndex + 1]) process.exit(21);
const outdir = args[outIndex + 1];
if (args.includes("--dry-run")) {
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_API_KEY) process.exit(31);
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const assetsIndex = args.indexOf("--assets");
  const headers = assetsIndex < 0 ? "" : readFileSync(args[assetsIndex + 1] + "/_headers", "utf8");
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args, headers }) + "\\n", "utf8");
  if (!process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ACCOUNT_ID !== "account_one") process.exit(32);
}
mkdirSync(outdir, { recursive: true });
writeFileSync(outdir + "/worker.js", "export default {}\\n", "utf8");
process.stdout.write(args.includes("--dry-run") ? "dry package ready\\n" : "https://test-preview.example.workers.dev/\\n");
`, "utf8");
  chmodSync(wrangler, 0o755);
  return {
    root, artifact, config, wrangler, marker, profile,
    pins: {
      wrangler: rawNi(readFileSync(wrangler)),
      config: rawNi(readFileSync(config)),
      artifact: treeDigest(artifact, artifactEntries),
      manifest: rawNi(Buffer.from(manifest, "utf8")),
      deliveryPolicy: rawNi(Buffer.from(headers, "utf8")),
    },
  };
}
function realScaleFixture() {
  const found = fixture();
  const routes = join(found.artifact, "routes"); mkdirSync(routes, { recursive: true });
  const entries = ["_headers", "index.html", "manifest.json", "posts/one/index.html"];
  const body = Buffer.alloc(22 * 1024, 0x61);
  for (let index = 0; index < 701; index += 1) {
    const name = `route-${String(index).padStart(3, "0")}.html`;
    writeFileSync(join(routes, name), body);
    entries.push(`routes/${name}`);
  }
  found.pins.artifact = treeDigest(found.artifact, entries);
  return found;
}
function source(id, executionMode, found) {
  return {
    "@context": CONTEXT,
    id: `urn:test:${process.pid}:${id}:source`,
    type: "Create",
    actor: CUSTOMER,
    target: ACTOR,
    object: {
      type: "Note",
      content: "Package static assets for a Cloudflare preview.",
      attachment: [{
        type: "CloudflareStaticDeliveryRequest",
        executionMode,
        wrangler: { executable: found.wrangler, digest: found.pins.wrangler, version: "4.102.0-test" },
        config: { path: found.config, digest: found.pins.config },
        artifact: {
          path: found.artifact,
          digest: found.pins.artifact,
          profile: found.profile,
          manifestDigest: found.pins.manifest,
          livePublicationWitnessDigest: WITNESS_DIGEST,
        },
        deliveryPolicy: { digest: found.pins.deliveryPolicy },
        hostname: "test-preview.example.workers.dev",
        expiresAt: EXPIRES,
        timeoutMilliseconds: 10_000,
        caller: CALLER,
        parentEffect: null,
        ...(executionMode === "live-preview" ? { cloudflare: { accountId: "account_one", workerName: "test-preview" } } : {}),
      }],
    },
  };
}
function solicitation(id, mode, found) {
  const sourceActivity = source(id, mode, found);
  return { "@context": CONTEXT, id: `urn:test:${process.pid}:${id}:solicitation`, type: "Offer", actor: CUSTOMER, target: ACTOR, object: { type: "ServiceSolicitation", sourceActivity } };
}
function run(operation, value, env = {}, now = NOW) {
  const processEnv = { ...process.env, RESOURCE_BROKERAGE_PROVIDER_CAIP10: PROVIDER_ACCOUNT, ...env };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!(key in env)) delete processEnv[key];
  }
  const exchange = mkdtempSync(join(tmpdir(), "resource-brokerage-test-exchange-"));
  const inputPath = join(exchange, "input.json");
  const stdoutPath = join(exchange, "stdout.json");
  const stderrPath = join(exchange, "stderr.txt");
  writeFileSync(inputPath, JSON.stringify(value), "utf8");
  const inputFd = openSync(inputPath, "r");
  const stdoutFd = openSync(stdoutPath, "w+");
  const stderrFd = openSync(stderrPath, "w+");
  try {
    const result = spawnSync(process.execPath, [PROVIDER, "--operation", operation, "--now", now, "--witness-journal-data-root", WITNESS_JOURNAL_DATA_ROOT], {
      env: processEnv,
      stdio: [inputFd, stdoutFd, stderrFd],
    });
    return {
      ...result,
      stdout: readFileSync(stdoutPath, "utf8"),
      stderr: readFileSync(stderrPath, "utf8"),
    };
  } finally {
    closeSync(inputFd);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    rmSync(exchange, { recursive: true, force: true });
  }
}
function contractFor(offer, id) {
  return {
    "@context": CONTEXT,
    id: `urn:test:${process.pid}:${id}:invocation`,
    type: "Accept",
    actor: CUSTOMER,
    target: ACTOR,
    inReplyTo: offer.id,
    object: {
      type: "ServiceContract",
      contract: offer.object.contract,
      offer,
      bindings: offer.object.bindings,
    },
  };
}

test.beforeEach(cleanupEvidence);
test.afterEach(cleanupEvidence);

test("strict solicitation remains bounded for a 705-file fifteen-megabyte publication", () => {
  const found = realScaleFixture();
  try {
    const started = performance.now();
    const offered = run("solicit-service", solicitation("real-scale", "dry-run", found));
    const elapsed = performance.now() - started;
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    assert.equal(offer.type, "Offer");
    assert.equal(offer.object.scope.artifact.fileCount, 705);
    assert.equal(offer.object.scope.artifact.totalBytes > 15 * 1024 * 1024, true);
    assert.equal(offer.object.scope.artifact.totalBytes < 17 * 1024 * 1024, true);
    assert.equal(elapsed < 5_000, true, `strict solicitation took ${elapsed}ms`);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("provider requests missing publication bindings without starting Wrangler", () => {
  const found = fixture("cutover-candidate");
  try {
    const demand = solicitation("missing-publication-binding", "live-preview", found);
    delete demand.object.sourceActivity.object.attachment[0].artifact.manifestDigest;
    const offered = run("solicit-service", demand, { CLOUDFLARE_API_TOKEN: "must-not-reach-terms-check" });
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const terms = JSON.parse(offered.stdout);
    assert.equal(terms.type, "Question");
    assert.equal(terms.object.missing.includes("artifact{path,digest,profile,manifestDigest,livePublicationWitnessDigest}"), true);
    assert.equal(existsSync(found.marker), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("dry-run offer executes the pinned Wrangler package without credentials or network authority", async () => {
  const found = fixture();
  try {
    const offered = run("solicit-service", solicitation("dry", "dry-run", found));
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    assert.equal(offer.type, "Offer");
    assert.deepEqual(offer.object.effects, ["customer-read-only-filesystem", "local-subprocess", "provider-local-append-only-evidence"]);
    assert.equal(offer.object.scope.wrangler.digest, found.pins.wrangler);
    assert.equal(offer.object.scope.artifact.digest, found.pins.artifact);
    assert.equal(offer.object.bindings.artifactProfile, "shadow");
    assert.equal(offer.object.bindings.artifactManifestDigest, found.pins.manifest);
    assert.equal(offer.object.bindings.livePublicationWitnessDigest, WITNESS_DIGEST);
    assert.equal(offer.object.bindings.deliveryPolicyDigest, found.pins.deliveryPolicy);
    assert.equal(offer.object.bindings.hostname, "test-preview.example.workers.dev");
    assert.equal(offer.object.bindings.expiresAt, EXPIRES);

    const invoked = run("invoke-service", contractFor(offer, "dry"), { CLOUDFLARE_API_TOKEN: "must-not-reach-dry-run" });
    assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.type, "Accept");
    assert.equal(result.object.type, "CloudflareStaticPackagingResult");
    assert.equal(result.object.observations.networkCalls, 0);
    assert.equal(result.object.observations.cloudflareCredentialsInjected, false);
    assert.equal(result.object.packaging.execution.status, 0);
    assert.equal(result.object.packaging.artifact.digest, found.pins.artifact);
    assert.deepEqual(result.object.effect.outcome, { positiveEvidence: true, negativeEvidence: false });
    assert.match(result.object.effect.witness, /^ni:\/\/\/sha-256;/u);
    assert.equal(existsSync(found.marker), false);

    const evidence = await queryWitnessJournalDocumentsByCategory("resource-brokerage.boundary-act", createWitnessJournalDataRootBinding(WITNESS_JOURNAL_DATA_ROOT));
    assert.equal(evidence.some(({ value }) => value?.outcome === "contract.completed"), true);
    assert.equal(JSON.stringify(evidence).includes("must-not-reach-dry-run"), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("live-preview offer names exact account, Worker, hostname, network, and upload effects", () => {
  const found = fixture("cutover-candidate");
  try {
    const offered = run("solicit-service", solicitation("live-effects", "live-preview", found));
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    assert.deepEqual(offer.object.effects, [
      "customer-read-only-filesystem",
      "local-subprocess",
      "provider-local-append-only-evidence",
      "preview-noindex-overlay",
      "external-network",
      "cloudflare-account:account_one",
      "cloudflare-worker:test-preview",
      "cloudflare-hostname:test-preview.example.workers.dev",
      "cloudflare-preview-upload",
    ]);
    assert.equal(offer.object.bindings.accountId, "account_one");
    assert.equal(offer.object.bindings.workerName, "test-preview");
    assert.equal(offer.object.bindings.hostname, "test-preview.example.workers.dev");
    assert.equal(offer.object.bindings.artifactProfile, "cutover-candidate");
    assert.equal(offer.object.bindings.effectsIdentity, rawNi(Buffer.from(offer.object.effects.join("\n"), "utf8")));
    assert.deepEqual(offer.object.exclusions, ["credential-custody", "dns", "custom-domain", "route-binding", "cutover", "primary-delivery-authority"]);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("live-preview refuses the obsolete Pages project binding before starting Wrangler", () => {
  const found = fixture("cutover-candidate");
  try {
    const demand = solicitation("obsolete-project-binding", "live-preview", found);
    demand.object.sourceActivity.object.attachment[0].cloudflare.projectId = "obsolete_pages_project";
    const offered = run("solicit-service", demand, { CLOUDFLARE_API_TOKEN: "must-not-reach-obsolete-binding" });
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const terms = JSON.parse(offered.stdout);
    assert.equal(terms.type, "Question");
    assert.equal(terms.object.missing.includes("cloudflare{accountId,workerName only}"), true);
    assert.equal(existsSync(found.marker), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("solicitation refuses an absent CAIP-10 caller before starting Wrangler", () => {
  const found = fixture();
  try {
    const demand = solicitation("missing-caller", "live-preview", found);
    delete demand.object.sourceActivity.object.attachment[0].caller;
    const offered = run("solicit-service", demand, { CLOUDFLARE_API_TOKEN: "must-not-reach-missing-caller" });
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const terms = JSON.parse(offered.stdout);
    assert.equal(terms.type, "Question");
    assert.equal(terms.object.missing.includes("caller(CAIP-10)"), true);
    assert.equal(existsSync(found.marker), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("live preview records a false FOUR receipt when credential injection fails after seam closure", () => {
  const found = fixture();
  try {
    const offered = run("solicit-service", solicitation("missing-credential", "live-preview", found));
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    const invoked = run("invoke-service", contractFor(offer, "missing-credential"));
    assert.equal(invoked.status, 2, invoked.stderr || invoked.stdout);
    const refusal = JSON.parse(invoked.stdout);
    assert.equal(refusal.type, "Reject");
    assert.deepEqual(refusal.object.unmet, ["cloudflare-credential-injection"]);
    assert.deepEqual(refusal.object.effect.outcome, { positiveEvidence: false, negativeEvidence: true });
    assert.match(refusal.object.effect.witness, /^ni:\/\/\/sha-256;/u);
    assert.equal(refusal.object.networkCalls, 0);
    assert.equal(refusal.object.subprocessesStarted, 0);
    assert.equal(existsSync(found.marker), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("live preview refuses effect-cell commitment drift before starting Wrangler", () => {
  const found = fixture("cutover-candidate");
  try {
    const offered = run("solicit-service", solicitation("cell-drift", "live-preview", found));
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    const contract = contractFor(offer, "cell-drift");
    contract.object.offer.object.effect.semanticId = rawNi(Buffer.from("tampered-effect", "utf8"));
    const invoked = run("invoke-service", contract, { CLOUDFLARE_API_TOKEN: "injected-after-cell-drift" });
    assert.equal(invoked.status, 2, invoked.stderr || invoked.stdout);
    const refusal = JSON.parse(invoked.stdout);
    assert.equal(refusal.type, "Reject");
    assert.equal(refusal.object.reason, "effect-commitment-drift");
    assert.deepEqual(refusal.object.unmet, ["accepted-rmn-effect"]);
    assert.equal(refusal.object.networkCalls, 0);
    assert.equal(refusal.object.subprocessesStarted, 0);
    assert.equal(existsSync(found.marker), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("cutover-candidate live preview uploads an ephemeral noindex overlay without mutating customer bytes", () => {
  const found = fixture("cutover-candidate");
  try {
    const sourceHeaders = readFileSync(join(found.artifact, "_headers"), "utf8");
    assert.equal(sourceHeaders.includes("X-Robots-Tag"), false);
    const offered = run("solicit-service", solicitation("candidate-overlay", "live-preview", found));
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    const invoked = run("invoke-service", contractFor(offer, "candidate-overlay"), { CLOUDFLARE_API_TOKEN: "invocation-only-token" });
    assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.type, "Accept");
    assert.equal(result.object.bindings.artifactProfile, "cutover-candidate");
    assert.equal(result.object.packaging.execution.uploadArtifact.overlay.effect, "preview-noindex-overlay");
    assert.equal(result.object.packaging.execution.uploadArtifact.overlay.customerArtifactMutated, false);
    assert.equal(result.object.packaging.execution.uploadArtifact.overlay.sourceDeliveryPolicyDigest, found.pins.deliveryPolicy);
    const started = JSON.parse(readFileSync(found.marker, "utf8"));
    assert.match(started.headers, /X-Robots-Tag: noindex, nofollow, noarchive/u);
    assert.equal(readFileSync(join(found.artifact, "_headers"), "utf8"), sourceHeaders);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("expired bound invocation is refused before starting Wrangler", () => {
  const found = fixture("cutover-candidate");
  try {
    const offered = run("solicit-service", solicitation("expired", "live-preview", found));
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    const invoked = run(
      "invoke-service",
      contractFor(offer, "expired"),
      { CLOUDFLARE_API_TOKEN: "injected-but-expired" },
      "2099-07-18T12:31:00.000Z",
    );
    assert.equal(invoked.status, 2, invoked.stderr || invoked.stdout);
    const refusal = JSON.parse(invoked.stdout);
    assert.equal(refusal.type, "Reject");
    assert.equal(refusal.object.networkCalls, 0);
    assert.equal(refusal.object.subprocessesStarted, 0);
    assert.equal(existsSync(found.marker), false);
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});
