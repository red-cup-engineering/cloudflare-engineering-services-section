#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { completeEffect, proposeEffect, semanticBytesId, textNi } from "@red-cup-engineering/computer-inference-engine/fabric/effect-assay";
import { witnessJournalBindingFromArgv, recordWitnessedBoundaryAct } from "./boundary-witness.mjs";

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const ACTOR = "urn:ame:resource-brokerage-service-section";
const CUSTOMER = "urn:ame:koios.news";
const CONTRACT = "cloudflare-worker-aggregate-attention/v3";
const ACCOUNT = "337e54ee6dc7d488933f473204a6d89e";
const NAMESPACE = "48e3d0a57c014b0ebefdfd219fd49648";
const PREFIX = "article:";
const ADMITTED_CARRIER_CONTRACTS = new Set([
  "cloudflare-worker-aggregate-attention/v1",
  "cloudflare-worker-aggregate-attention/v2",
]);
const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const CAIP10 = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/u;
const NODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAW_PATH = join(NODE_ROOT, "lib/law/cloudflare-koios-attention.rml");
const DEFAULT_CREDENTIAL = join(NODE_ROOT, "content/resources/cloudflare-workers.env");
const API = "https://api.cloudflare.com/client/v4";
const EFFECTS = Object.freeze(["read-koios-aggregate-attention-namespace", "return-bounded-article-day-totals", "append-provider-local-witness-journal"]);
const WitnessJournal = witnessJournalBindingFromArgv();

function argument(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
function instant() { return argument("--now") ?? new Date().toISOString(); }
function operation() { return argument("--operation") ?? "solicit-attention-service"; }
function input() { return JSON.parse(readFileSync(0, "utf8")); }
function response(type, source, object) { return { "@context": CONTEXT, id: `urn:uuid:${randomUUID()}`, type, actor: ACTOR, target: source?.actor ?? CUSTOMER, inReplyTo: source?.id, object }; }
function emit(value, status = 0) { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = status; }
function literal(value) { return JSON.stringify(String(value)); }
function witness(activity, act, at, data = {}) { return recordWitnessedBoundaryAct(activity, act, at, CONTRACT, data, WitnessJournal); }
async function reject(source, reason, at, details = {}) {
  const value = response("Reject", source, { type: "CloudflareAggregateAttentionRefusal", contract: CONTRACT, reason, credentialRecorded: false, customerMutation: false, ...details });
  await witness(value, "attention.refused", at, { reason });
  emit(value, 2);
}
function attachments(activity) {
  const value = activity?.object?.sourceActivity?.object?.attachment;
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}
function date(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)); }
function normalizedRequest(activity) { return attachments(activity).find((value) => value?.type === "CloudflareAggregateAttentionRequest") ?? null; }
function validateRequest(request, at) {
  if (!request || !date(request.fromDay) || !date(request.throughDay)) return "request requires fromDay and throughDay UTC dates";
  const days = Math.floor((Date.parse(`${request.throughDay}T00:00:00.000Z`) - Date.parse(`${request.fromDay}T00:00:00.000Z`)) / 86_400_000) + 1;
  if (days < 1 || days > 31) return "attention window must contain 1 through 31 UTC days";
  if (request.pathPrefix !== "/posts/") return "attention request pathPrefix must be /posts/";
  if (typeof request.expiresAt !== "string" || !Number.isFinite(Date.parse(request.expiresAt))) return "attention request requires an explicit UTC expiry";
  const remaining = Date.parse(request.expiresAt) - Date.parse(at);
  if (!(remaining > 0 && remaining <= 3_600_000)) return "attention request expiry must be after now and no more than one hour away";
  if (!CAIP10.test(request.caller ?? "")) return "attention request requires one CAIP-10 caller";
  if (request.parentEffect !== null && !NI.test(request.parentEffect ?? "")) return "attention request parentEffect must be an SEN ni identity or null";
  if (!CAIP10.test(process.env.RESOURCE_BROKERAGE_PROVIDER_CAIP10 ?? "")) return "resource broker CAIP-10 identity is absent";
  return undefined;
}
function bindings(request) { return Object.freeze({ accountId: ACCOUNT, namespaceId: NAMESPACE, keyPrefix: PREFIX, fromDay: request.fromDay, throughDay: request.throughDay, pathPrefix: request.pathPrefix, maxKeys: 1000, expiresAt: request.expiresAt }); }
function effectCell(sourceActivity, request, outcome, evidenceRoot, readingCount = 0) {
  return {
    law: semanticBytesId("resource-brokerage.koios-attention-law", readFileSync(LAW_PATH)),
    caller: request.caller,
    provider: process.env.RESOURCE_BROKERAGE_PROVIDER_CAIP10,
    precondition: textNi(`attention-window:${request.fromDay}:${request.throughDay}:${request.pathPrefix}:${request.expiresAt}`),
    operation: textNi(`cloudflare-kv-read:${ACCOUNT}:${NAMESPACE}:${PREFIX}`),
    postcondition: textNi("CloudflareAggregateAttentionReceipt{readings,effect}"),
    refusal: textNi("CloudflareAggregateAttentionRefusal{reason,effect}"),
    evidenceRoot,
    outcome,
    measures: [{ dimension: "cloudflare-readings", quantity: String(readingCount), unit: "reading" }, { dimension: "wit", quantity: "1", unit: "wit" }],
    parent: request.parentEffect
  };
}
async function proposal(sourceActivity, request, at) {
  const evidence = textNi(sourceActivity.id);
  const cell = effectCell(sourceActivity, request, { positiveEvidence: false, negativeEvidence: false }, evidence, 0);
  return { cell, ...await proposeEffect(ACTOR, cell, at) };
}
function credential() {
  const path = resolve(process.env.CLOUDFLARE_PRIMARY_RELEASE_CREDENTIAL_FILE ?? DEFAULT_CREDENTIAL);
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error("provider Cloudflare resource carrier is absent"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("provider Cloudflare resource carrier must be a private regular file");
  const name = "API_KEY_CLOUDFLARE_WORKERS_EDIT";
  const values = readFileSync(path, "utf8").split(/\r?\n/gu).flatMap((line) => line.startsWith(`${name}=`) ? [line.slice(name.length + 1).trim().replace(/^['"]|['"]$/gu, "")] : []);
  if (values.length !== 1 || values[0] === "") throw new Error("provider Cloudflare resource carrier lacks its exact token");
  return values[0];
}
async function cloudflare(token, path) {
  const result = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await result.json();
  if (!result.ok || body?.success !== true) throw new Error(`Cloudflare attention read refused (${result.status})`);
  return body;
}
async function readings(token, request) {
  const found = [];
  let cursor;
  do {
    const query = new URLSearchParams({ prefix: PREFIX, limit: "1000", ...(cursor === undefined ? {} : { cursor }) });
    const page = await cloudflare(token, `/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/keys?${query}`);
    for (const key of Array.isArray(page.result) ? page.result : []) {
      const match = /^article:(\d{4}-\d{2}-\d{2}):/u.exec(key?.name ?? "");
      if (match?.[1] === undefined || match[1] < request.fromDay || match[1] > request.throughDay) continue;
      const result = await fetch(`${API}/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/values/${encodeURIComponent(key.name)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!result.ok) throw new Error(`Cloudflare attention value read refused (${result.status})`);
      const value = await result.json();
      if (!ADMITTED_CARRIER_CONTRACTS.has(value?.contract) || typeof value.path !== "string" || !value.path.startsWith("/posts/") || value.day !== match[1] || !Number.isSafeInteger(value.observedLoads) || value.observedLoads < 1 || value.storesReaderIdentifiers !== false || value.storesReferrers !== false) throw new Error("Cloudflare attention cell violates its aggregate carrier contract");
      found.push(Object.freeze({ path: value.path, day: value.day, observedLoads: value.observedLoads, firstObservedAt: value.firstObservedAt, lastObservedAt: value.lastObservedAt, excludesRecognizedAutomatedUserAgents: value.excludesRecognizedAutomatedUserAgents === true, storesReaderIdentifiers: false, storesReferrers: false }));
    }
    cursor = typeof page.result_info?.cursor === "string" && page.result_info.cursor !== "" ? page.result_info.cursor : undefined;
    if (found.length > 1000) throw new Error("Cloudflare attention reading exceeded its bounded key ceiling");
  } while (cursor !== undefined);
  return Object.freeze(found.sort((left, right) => `${left.day}:${left.path}`.localeCompare(`${right.day}:${right.path}`)));
}
function evidenceFor(readingValues) {
  const rows = readingValues.map((value) => `<urn:koios:path:${encodeURIComponent(value.path)}> <urn:koios:observedLoads> ${literal(value.observedLoads)} <urn:koios:attention:${value.day}> .`).join("\n");
  return textNi(`${rows}\n`, "resource-brokerage.koios-attention-observation");
}
async function solicit(activity, at) {
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Offer" || activity.actor !== CUSTOMER || activity.target !== ACTOR || activity.object?.type !== "ServiceSolicitation") return await reject(activity, "solicitation must be an ActivityStreams Offer<ServiceSolicitation> from Koios", at);
  const request = normalizedRequest(activity);
  const problem = validateRequest(request, at);
  if (problem) return emit(response("Question", activity, { type: "ServiceTermsRequired", contract: CONTRACT, missing: [problem] }));
  let effect;
  try { effect = await proposal(activity.object.sourceActivity, request, at); } catch (error) { return await reject(activity, "sen-conformance-refused", at, { detail: error.message }); }
  const offer = response("Offer", activity, { type: "ExecutableServiceOffer", contract: CONTRACT, sourceActivity: activity.object.sourceActivity.id, request, bindings: bindings(request), effects: EFFECTS, effect: { semanticId: effect.semanticId, evidence: effect.evidence, conformance: effect.conformance }, operation: "invoke-attention-service", exclusions: ["reader-identifiers", "referrers", "customer-ledger-mutation", "credential-egress", "content-mutation"] });
  await witness(offer, "attention.offer-emitted", at, { effect: effect.semanticId });
  emit(offer);
}
async function invoke(activity, at) {
  const offer = activity?.object?.offer;
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Accept" || activity.actor !== CUSTOMER || activity.target !== ACTOR || activity.object?.type !== "ServiceContract" || activity.object.contract !== CONTRACT || offer?.actor !== ACTOR || offer?.object?.contract !== CONTRACT) return await reject(activity, "invocation must accept the exact provider offer", at);
  const request = offer.object.request;
  const problem = validateRequest(request, at);
  if (problem || !isDeepStrictEqual(activity.object.bindings, offer.object.bindings) || !isDeepStrictEqual(offer.object.bindings, bindings(request)) || !isDeepStrictEqual(offer.object.effects, EFFECTS)) return await reject(activity, problem ?? "accepted offer changed after solicitation", at);
  let proposed;
  try { proposed = await proposal({ id: offer.object.sourceActivity }, request, at); } catch (error) { return await reject(activity, "sen-conformance-refused", at, { detail: error.message }); }
  if (proposed.semanticId !== offer.object.effect?.semanticId) return await reject(activity, "effect-commitment-drift", at);
  try {
    const values = await readings(credential(), request);
    const evidence = evidenceFor(values);
    const completionCell = effectCell({ id: offer.object.sourceActivity }, request, { positiveEvidence: true, negativeEvidence: false }, evidence, values.length);
    const effect = await completeEffect(ACTOR, proposed.cell, completionCell, evidence, at);
    const payload = { type: "CloudflareAggregateAttentionReceipt", contract: CONTRACT, disposition: "observed", readings: values, evidence, effect, credentialRead: true, credentialRecorded: false, customerMutation: false };
    await witness(activity, "attention.observed", at, { readingCount: values.length, evidence, witness: effect.witness });
    emit(response("Accept", activity, payload));
  } catch (error) {
    const evidence = textNi(`attention-refusal:${error instanceof Error ? error.message : String(error)}`);
    let effect;
    try { effect = await completeEffect(ACTOR, proposed.cell, effectCell({ id: offer.object.sourceActivity }, request, { positiveEvidence: false, negativeEvidence: true }, evidence, 0), evidence, at); }
    catch (transitionError) { return await reject(activity, "sen-completion-refused", at, { detail: transitionError.message }); }
    await reject(activity, error instanceof Error ? error.message : String(error), at, { effect });
  }
}

const at = instant();
let activity;
try { activity = input(); } catch (error) { await reject({}, `invalid JSON input: ${error instanceof Error ? error.message : String(error)}`, at); }
if (activity !== undefined) {
  if (operation() === "solicit-attention-service") await solicit(activity, at);
  else if (operation() === "invoke-attention-service") await invoke(activity, at);
  else await reject(activity, `unknown attention operation ${operation()}`, at);
}
