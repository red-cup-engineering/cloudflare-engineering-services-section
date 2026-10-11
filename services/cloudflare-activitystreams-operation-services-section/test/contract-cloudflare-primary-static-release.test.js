import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { startWitnessJournalProviderProcess } from "@red-cup-engineering/witness-journal-document-service/test-provider";
import { serveWitTransitionAssay } from "@red-cup-engineering/computer-inference-engine/fabric/effect-assay";

let witnessJournalProvider, witProvider;
const rawNi = (bytes) => makeNiUri(Buffer.from(bytes));
test.before(async () => {
  witnessJournalProvider = await startWitnessJournalProviderProcess();
  witProvider = await serveWitTransitionAssay({ providerAccount: "eip155:31337:0x0aadad1c6a71d34f89dad0cb41a75603433a6071" });
  process.env.WITNESS_JOURNAL_RDF_AGENT = witnessJournalProvider.agentCardUrl;
  process.env.WIT_TRANSITION_ASSAY_AGENT = witProvider.baseUrl;
});
test.after(async () => {
  delete process.env.WITNESS_JOURNAL_RDF_AGENT;
  delete process.env.WIT_TRANSITION_ASSAY_AGENT;
  await witProvider?.close();
  await witnessJournalProvider?.close();
});
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER = join(ROOT, "src/contract-cloudflare-primary-static-release.js");
const CONTEXT = "https://www.w3.org/ns/activitystreams";
const ACTOR = "urn:ame:resource-brokerage-service-section";
const CUSTOMER = "urn:ame:koios.news";
const NOW = "2099-07-19T04:00:00.000Z";
const EXPIRES = "2099-07-19T04:30:00.000Z";
const CALLER = "eip155:31337:0x1111111111111111111111111111111111111111";
const PROVIDER_ACCOUNT = "eip155:31337:0x2222222222222222222222222222222222222222";
const TARGET = Object.freeze({ accountId: "337e54ee6dc7d488933f473204a6d89e", zoneName: "koios.news", workerName: "koios-news-primary", routePattern: "koios.news/*", origin: "https://koios.news" });

const WITNESS = rawNi(Buffer.from("publication-witness", "utf8"));
function treeDigest(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        const bytes = readFileSync(path);
        files.push({ path: relative(root, path).split(sep).join("/"), bytes: bytes.length, digest: rawNi(bytes) });
      }
    }
  }
  visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const rows = files.map((file) => `<urn:path:${encodeURIComponent(file.path)}> <urn:sen:bytes> ${JSON.stringify(String(file.bytes))}; <urn:sen:content> <${file.digest}> .`).join("\n");
  return rawNi(Buffer.from(`${rows}\n`, "utf8"));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "primary-release-test-"));
  const artifact = join(root, "artifact");
  mkdirSync(join(artifact, "posts", "fresh-story"), { recursive: true });
  const index = "<h1>Koios</h1>\n";
  const article = "<article>Fresh story.</article>\n";
  const headers = "/*\n  Referrer-Policy: no-referrer\n";
  writeFileSync(join(artifact, "index.html"), index);
  writeFileSync(join(artifact, "posts", "fresh-story", "index.html"), article);
  writeFileSync(join(artifact, "_headers"), headers);
  const manifest = {
    kind: "koios.static-publication-manifest",
    node: "koios-news",
    canonicalOrigin: "https://koios.news",
    profile: "cutover-candidate",
    authority: "non-authoritative-cutover-candidate",
    livePublicationWitnessDigest: WITNESS,
    artifacts: [
      { route: "/", file: "index.html", mediaType: "text/html", bytes: Buffer.byteLength(index), digest: rawNi(Buffer.from(index, "utf8")) },
      { route: "/posts/fresh-story", file: "posts/fresh-story/index.html", mediaType: "text/html", bytes: Buffer.byteLength(article), digest: rawNi(Buffer.from(article, "utf8")) },
      { route: "urn:cloudflare-pages:_headers", file: "_headers", mediaType: "text/plain", bytes: Buffer.byteLength(headers), digest: rawNi(Buffer.from(headers, "utf8")) },
    ],
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(artifact, "manifest.json"), manifestBytes);
  const marker = join(root, "wrangler-called.json");
  const wrangler = join(root, "wrangler.mjs");
  writeFileSync(wrangler, `#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
if (process.env.CLOUDFLARE_API_TOKEN) process.exit(91);
const argv = process.argv.slice(2);
const config = JSON.parse(readFileSync(argv[argv.indexOf("--config") + 1], "utf8"));
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
  argv,
  credential: false,
  noBundle: config.no_bundle,
  stableIndex: existsSync(config.assets.directory + "/index.html"),
  releasePrefixDirectories: readdirSync(config.assets.directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith("release-")).map((entry) => entry.name),
}));
process.stdout.write("dry package ready\\n");
`, "utf8");
  chmodSync(wrangler, 0o755);
  return { root, artifact, marker, wrangler, manifestBytes, headers };
}

function request(found, executionMode = "dry-run") {
  return {
    type: "CloudflarePrimaryStaticReleaseRequest",
    executionMode,
    artifact: { path: found.artifact, treeDigest: treeDigest(found.artifact), manifestDigest: rawNi(Buffer.from(found.manifestBytes, "utf8")), deliveryPolicyDigest: rawNi(Buffer.from(found.headers, "utf8")), livePublicationWitnessDigest: WITNESS },
    publication: { assignmentId: "urn:koios:assignment:fresh-story", slug: "fresh-story" },
    target: { ...TARGET },
    expiresAt: EXPIRES,
    caller: CALLER,
    parentEffect: null,
  };
}

function solicitation(found, executionMode = "dry-run") {
  const sourceActivity = { "@context": CONTEXT, id: `urn:test:${process.pid}:source:${executionMode}`, type: "Create", actor: CUSTOMER, target: ACTOR, object: { type: "Note", attachment: [request(found, executionMode)] } };
  return { "@context": CONTEXT, id: `urn:test:${process.pid}:solicitation:${executionMode}`, type: "Offer", actor: CUSTOMER, target: ACTOR, object: { type: "ServiceSolicitation", sourceActivity } };
}

function run(operation, activity, found, extra = {}) {
  const exchange = mkdtempSync(join(tmpdir(), "primary-release-exchange-"));
  const inputPath = join(exchange, "input.json"); const outputPath = join(exchange, "output.json"); const errorPath = join(exchange, "error.txt");
  writeFileSync(inputPath, JSON.stringify(activity));
  const inputFd = openSync(inputPath, "r"); const outputFd = openSync(outputPath, "w+"); const errorFd = openSync(errorPath, "w+");
  try {
    const result = spawnSync(process.execPath, [...process.execArgv.filter((flag) => !flag.startsWith("--test")), PROVIDER, "--operation", operation, "--now", NOW, "--witness-journal-data-root", join(found.root, "witnessJournal")], {
      stdio: [inputFd, outputFd, errorFd],
      env: { ...process.env, RESOURCE_BROKERAGE_TEAM_DATA_ROOT: join(found.root, "data"), RESOURCE_BROKERAGE_PROVIDER_CAIP10: PROVIDER_ACCOUNT, CLOUDFLARE_PRIMARY_RELEASE_WRANGLER: found.wrangler, ...extra },
    });
    return { ...result, stdout: readFileSync(outputPath, "utf8"), stderr: readFileSync(errorPath, "utf8") };
  } finally { closeSync(inputFd); closeSync(outputFd); closeSync(errorFd); rmSync(exchange, { recursive: true, force: true }); }
}

function invocation(offer) {
  return {
    "@context": CONTEXT,
    id: `urn:test:${process.pid}:primary-release:invocation`,
    type: "Accept",
    actor: CUSTOMER,
    target: ACTOR,
    object: {
      type: "ServiceContract",
      contract: offer.object.contract,
      offer,
      bindings: offer.object.bindings,
    },
  };
}

test("Koios can contract a credential-free dry-run of an exact primary candidate", () => {
  const found = fixture();
  try {
    const offered = run("solicit-primary-release", solicitation(found), found);
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    assert.equal(offer.type, "Offer", offered.stdout);
    assert.equal(offer.object.contract, "cloudflare-primary-static-release/v3");
    assert.equal(offer.object.bindings.slug, "fresh-story");
    assert.deepEqual(offer.object.effects, ["read-one-customer-supplied-static-candidate", "append-provider-local-release-evidence"]);
    const invoked = run("invoke-primary-release", invocation(offer), found);
    assert.equal(invoked.status, 0, invoked.stderr || invoked.stdout);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.type, "Accept");
    assert.equal(result.object.disposition, "packaged");
    assert.equal(result.object.execution.networkCalls, 0);
    assert.equal(result.object.execution.credentialRead, false);
    assert.deepEqual(result.object.effect.outcome, { positiveEvidence: true, negativeEvidence: false });
    assert.match(result.object.effect.witness, /^ni:\/\/\/sha-256;/u);
    const marker = JSON.parse(readFileSync(found.marker, "utf8"));
    assert.equal(marker.argv.includes("--dry-run"), true);
    assert.equal(marker.argv.includes("--no-bundle"), true);
    assert.equal(marker.argv.includes("--assets"), false);
    assert.equal(marker.argv.includes("--outdir"), false);
    assert.equal(marker.credential, false);
    assert.equal(marker.noBundle, true);
    assert.equal(marker.stableIndex, true);
    assert.deepEqual(marker.releasePrefixDirectories, []);
    const replay = run("invoke-primary-release", invocation(offer), found);
    assert.equal(replay.status, 2, replay.stderr || replay.stdout);
    assert.equal(JSON.parse(replay.stdout).object.reason, "offer-already-consumed");
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("the provider refuses a different account or route before any executable starts", () => {
  const found = fixture();
  try {
    const demand = solicitation(found);
    demand.object.sourceActivity.object.attachment[0].target.routePattern = "koios.news/admin/*";
    const offered = run("solicit-primary-release", demand, found);
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const result = JSON.parse(offered.stdout);
    assert.equal(result.type, "Question");
    assert.equal(result.object.missing.includes("target(exact Koios Cloudflare authority)"), true);
    assert.throws(() => readFileSync(found.marker));
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});

test("live release reaches provider-owned credential custody before Cloudflare network effects", () => {
  const found = fixture();
  try {
    const offered = run("solicit-primary-release", solicitation(found, "live"), found);
    assert.equal(offered.status, 0, offered.stderr || offered.stdout);
    const offer = JSON.parse(offered.stdout);
    assert.equal(offer.type, "Offer", offered.stdout);
    const invoked = run("invoke-primary-release", invocation(offer), found, { CLOUDFLARE_PRIMARY_RELEASE_CREDENTIAL_FILE: join(found.root, "absent-resource.env") });
    assert.equal(invoked.status, 2, invoked.stderr || invoked.stdout);
    const result = JSON.parse(invoked.stdout);
    assert.equal(result.type, "Reject");
    assert.match(result.object.reason, /resource carrier/u);
    assert.equal(result.object.credentialRecorded, false);
    assert.deepEqual(result.object.effect.outcome, { positiveEvidence: false, negativeEvidence: true });
    assert.throws(() => readFileSync(found.marker));
  } finally { rmSync(found.root, { recursive: true, force: true }); }
});
