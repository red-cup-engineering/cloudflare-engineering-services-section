import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startWitnessJournalProviderProcess } from "@red-cup-engineering/witness-journal-document-service/test-provider";
import { serveWitTransitionAssay } from "@red-cup-engineering/computer-inference-engine/fabric/effect-assay";

let witnessJournalProvider, witProvider;
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
const PROVIDER = join(ROOT, "src/contract-cloudflare-koios-attention.js");
const CONTEXT = "https://www.w3.org/ns/activitystreams";
const CUSTOMER = "urn:ame:koios.news";
const ACTOR = "urn:ame:resource-brokerage-service-section";
const NOW = "2099-07-19T05:00:00.000Z";
const CUSTOMER_ACCOUNT = `eip155:31337:0x${"11".repeat(20)}`;
const PROVIDER_ACCOUNT = `eip155:31337:0x${"22".repeat(20)}`;

function solicitation(id) {
  const sourceActivity = {
    "@context": CONTEXT,
    id: `urn:test:${id}:source`,
    type: "Create",
    actor: CUSTOMER,
    target: ACTOR,
    object: { type: "Note", attachment: [{ type: "CloudflareAggregateAttentionRequest", fromDay: "2099-07-01", throughDay: "2099-07-19", pathPrefix: "/posts/", expiresAt: "2099-07-19T05:30:00.000Z", caller: CUSTOMER_ACCOUNT, parentEffect: null }] }
  };
  return { "@context": CONTEXT, id: `urn:test:${id}:solicitation`, type: "Offer", actor: CUSTOMER, target: ACTOR, object: { type: "ServiceSolicitation", sourceActivity } };
}
function invocation(offer) {
  return { "@context": CONTEXT, id: "urn:test:attention:invocation", type: "Accept", actor: CUSTOMER, target: ACTOR, object: { type: "ServiceContract", contract: offer.object.contract, offer, bindings: offer.object.bindings } };
}
function run(operation, activity, root, extraEnv = {}) {
  const result = spawnSync(process.execPath, [...process.execArgv.filter((flag) => !flag.startsWith("--test")), PROVIDER, "--operation", operation, "--now", NOW, "--witness-journal-data-root", join(root, "witnessJournal")], {
    input: JSON.stringify(activity),
    encoding: "utf8",
    env: { ...process.env, RESOURCE_BROKERAGE_TEAM_DATA_ROOT: join(root, "data"), SEN_SEMANTIC_CONFORMANCE_DATA_ROOT: join(root, "sen"), CLOUDFLARE_PRIMARY_RELEASE_CREDENTIAL_FILE: join(root, "absent-cloudflare-resource.env"), ...extraEnv }
  });
  return { ...result, value: JSON.parse(result.stdout) };
}

test("attention solicitation requires exact CAIP-10 provider identity before any credential access", () => {
  const root = mkdtempSync(join(tmpdir(), "attention-sen-test-"));
  try {
    const result = run("solicit-attention-service", solicitation("provider-absent"), root);
    assert.equal(result.status, 0);
    assert.equal(result.value.type, "Question");
    assert.match(result.value.object.missing[0], /CAIP-10/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("credential refusal is an SEN negative-evidence cover with one WIT", () => {
  const root = mkdtempSync(join(tmpdir(), "attention-sen-test-"));
  const env = { RESOURCE_BROKERAGE_PROVIDER_CAIP10: PROVIDER_ACCOUNT };
  try {
    const offered = run("solicit-attention-service", solicitation("credential-refusal"), root, env);
    assert.equal(offered.status, 0, offered.stderr);
    assert.equal(offered.value.object.contract, "cloudflare-worker-aggregate-attention/v3");
    assert.match(offered.value.object.effect.semanticId, /^ni:\/\/\/sha-256;/u);
    const refused = run("invoke-attention-service", invocation(offered.value), root, env);
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.value.object.reason, /resource carrier/u);
    assert.deepEqual(refused.value.object.effect.outcome, { positiveEvidence: false, negativeEvidence: true });
    assert.match(refused.value.object.effect.witness, /^ni:\/\/\/sha-256;/u);
    assert.equal(refused.value.object.authoritySeam, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
