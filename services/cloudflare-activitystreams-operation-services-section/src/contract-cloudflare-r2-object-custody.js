#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assayCloudflareR2FreeAllowance } from "@red-cup-engineering/cloudflare-r2-services-section/free-tier-admission";
import {
  CONTRACT,
  PROVIDER,
  issueReadCapability,
  storeGrantedObject,
  uuidFromSha256,
  validateKnowledge,
  validateStoreRequest,
} from "@red-cup-engineering/cloudflare-r2-services-section/object-custody";
import { createR2SigV4Client, r2Configuration } from "@red-cup-engineering/cloudflare-r2-services-section/r2-sigv4";
import { completeEffect, proposeEffect, semanticBytesId, textNi } from "@red-cup-engineering/a2a-effect-assay-services-section/effect-assay";
import { witnessJournalBindingFromArgv, recordWitnessedBoundaryAct } from "./removed-witness-journal.mjs";

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const CAIP10 = /^eip155:[1-9][0-9]*:0x[0-9a-fA-F]{40}$/u;
const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const NODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAW_PATH = join(NODE_ROOT, "lib/law/cloudflare-r2-object-custody.rml");
const STORE_EFFECTS = Object.freeze(["read-exact-granted-nonlegacy-file", "conditionally-store-standard-r2-object", "verify-object-metadata", "return-byte-free-object-knowledge", "append-provider-local-witness-journal"]);
const READ_EFFECTS = Object.freeze(["verify-custodied-object-metadata", "issue-short-lived-get-capability", "append-provider-local-witness-journal"]);
const WitnessJournal = witnessJournalBindingFromArgv();

function argument(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
function instant() { return argument("--now") ?? new Date().toISOString(); }
function operation() { return argument("--operation") ?? "solicit-custody-service"; }
function input() { return JSON.parse(readFileSync(0, "utf8")); }
function response(type, source, object) { return { "@context": CONTEXT, id: `urn:uuid:${randomUUID()}`, type, actor: PROVIDER, target: source?.actor, inReplyTo: source?.id, object }; }
function emit(value, status = 0) { process.stdout.write(`${JSON.stringify(value)}\n`); process.exitCode = status; }
function requestOf(activity) {
  const attachment = activity?.object?.sourceActivity?.object?.attachment;
  const values = Array.isArray(attachment) ? attachment : attachment === undefined ? [] : [attachment];
  return values.find((value) => value?.type === "CloudflareR2ObjectCustodyRequest" || value?.type === "CloudflareR2ObjectReadCapabilityRequest") ?? null;
}
async function reject(source, reason, at, details = {}) {
  const refusal = response("Reject", source, { type: "CloudflareR2ObjectCustodyRefusal", contract: CONTRACT, reason, credentialRecorded: false, customerMutation: false, legacyAssetTouched: false, ...details });
  await recordWitnessedBoundaryAct(refusal, "r2-custody.refused", at, CONTRACT, { reason }, WitnessJournal);
  emit(refusal, 2);
}
function allowanceRequest(request) {
  const store = request.operation === "store";
  return {
    type: "CloudflareR2FreeAllowanceAdmissionRequest",
    storageClass: "Standard",
    accountWideBillableUsage: request.accountWideBillableUsage,
    proposedMaximumUsage: {
      standardStorageGbMonth: store ? request.sourceGrant.byteLength / 1_000_000_000 : 0,
      classAOperations: store ? 1 : 0,
      classBOperations: store ? 2 : 1,
    },
  };
}
function validateReadRequest(request, at) {
  const refusals = [];
  if (request?.type !== "CloudflareR2ObjectReadCapabilityRequest" || request?.operation !== "issue-read-capability") refusals.push("typed-read-capability-request-required");
  if (typeof request?.customer !== "string" || !/^urn:ame:[a-z0-9][a-z0-9.-]*$/u.test(request.customer)) refusals.push("customer-actor-required");
  if (!CAIP10.test(request?.caller ?? "")) refusals.push("caller-caip10-required");
  if (!CAIP10.test(process.env.CLOUDFLARE_R2_PROVIDER_CAIP10 ?? "")) refusals.push("provider-caip10-required");
  if (!validateKnowledge(request?.knowledge, { customer: request?.caller })) refusals.push("caller-bound-verified-bucket-object-knowledge-required");
  if (!Number.isSafeInteger(request?.expiresInSeconds) || request.expiresInSeconds < 1 || request.expiresInSeconds > 900) refusals.push("read-capability-expiry-1-through-900-seconds-required");
  const expires = Date.parse(request?.expiresAt ?? "");
  const now = Date.parse(at);
  if (!Number.isFinite(expires) || !Number.isFinite(now) || expires <= now || expires - now > 3_600_000) refusals.push("request-expiry-within-one-hour-required");
  if (request?.parentEffect !== null && !NI.test(request?.parentEffect ?? "")) refusals.push("parent-effect-must-be-ni-or-null");
  return Object.freeze(refusals);
}
function validate(request, at) {
  const refusals = request?.operation === "store"
    ? validateStoreRequest(request, { now: at })
    : validateReadRequest(request, at);
  if (refusals.length !== 0) return refusals;
  const allowance = assayCloudflareR2FreeAllowance(allowanceRequest(request), { now: at });
  return allowance.admitted ? Object.freeze([]) : allowance.refusals;
}
function bindings(request) {
  if (request.operation === "store") return Object.freeze({ operation: request.operation, objectId: `urn:uuid:${uuidFromSha256(request.sourceGrant.sha256)}`, sha256: request.sourceGrant.sha256, byteLength: request.sourceGrant.byteLength, mediaType: request.mediaType, expiresAt: request.expiresAt, storageClass: "Standard" });
  return Object.freeze({ operation: request.operation, objectId: request.knowledge.id, expiresInSeconds: request.expiresInSeconds, expiresAt: request.expiresAt });
}
function effectCell(request, outcome, evidenceRoot, measure = 0) {
  const store = request.operation === "store";
  return {
    law: semanticBytesId("resource-brokerage.r2-custody-law", readFileSync(LAW_PATH)),
    caller: request.caller,
    provider: process.env.CLOUDFLARE_R2_PROVIDER_CAIP10,
    precondition: textNi(`${request.operation}:${request.expiresAt}:${store ? request.sourceGrant.sha256 : request.knowledge.contentDigest}`),
    operation: textNi(store ? "cloudflare-r2-standard-conditional-put" : "cloudflare-r2-presigned-get-capability"),
    postcondition: textNi(store ? "BucketObjectKnowledge{uuid,digest,byteLength,mediaType,custody}" : "EphemeralBucketObjectReadCapability{uuid,expiry}"),
    refusal: textNi("CloudflareR2ObjectCustodyRefusal{reason,effect}"),
    evidenceRoot,
    outcome,
    measures: [{ dimension: store ? "bytes-custodied" : "read-capabilities", quantity: String(measure), unit: store ? "byte" : "capability" }, { dimension: "wit", quantity: "1", unit: "wit" }],
    parent: request.parentEffect,
  };
}
async function proposal(sourceActivity, request, at) {
  const cell = effectCell(request, { positiveEvidence: false, negativeEvidence: false }, textNi(sourceActivity.id), 0);
  return { cell, ...await proposeEffect(PROVIDER, cell, at) };
}
async function solicit(activity, at) {
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Offer" || activity.target !== PROVIDER || activity.object?.type !== "ServiceSolicitation") return await reject(activity, "solicitation must be an ActivityStreams Offer<ServiceSolicitation> to the resource broker", at);
  const request = requestOf(activity);
  if (request?.customer !== activity.actor) return emit(response("Question", activity, { type: "ServiceTermsRequired", contract: CONTRACT, missing: ["request customer must equal the soliciting ActivityStreams actor"] }));
  const refusals = validate(request, at);
  if (refusals.length !== 0) return emit(response("Question", activity, { type: "ServiceTermsRequired", contract: CONTRACT, missing: refusals }));
  let effect;
  try { effect = await proposal(activity.object.sourceActivity, request, at); }
  catch (error) { return await reject(activity, "rmn-conformance-refused", at, { detail: error.message }); }
  const offer = response("Offer", activity, { type: "ExecutableServiceOffer", contract: CONTRACT, sourceActivity: activity.object.sourceActivity.id, request, bindings: bindings(request), effects: request.operation === "store" ? STORE_EFFECTS : READ_EFFECTS, effect: { semanticId: effect.semanticId, evidence: effect.evidence, conformance: effect.conformance }, operation: "invoke-custody-service", exclusions: ["legacy-assets", "delete", "list", "bucket-coordinate-disclosure", "credential-egress", "customer-ledger-mutation"] });
  await recordWitnessedBoundaryAct(offer, "r2-custody.offer-emitted", at, CONTRACT, { operation: request.operation, object: offer.object.bindings.objectId, effect: effect.semanticId }, WitnessJournal);
  emit(offer);
}
async function invoke(activity, at) {
  const offer = activity?.object?.offer;
  if (activity?.["@context"] !== CONTEXT || activity.type !== "Accept" || activity.target !== PROVIDER || activity.object?.type !== "ServiceContract" || activity.object.contract !== CONTRACT || offer?.actor !== PROVIDER || offer?.object?.contract !== CONTRACT || activity.actor !== offer.target || offer.target !== offer.object?.request?.customer) return await reject(activity, "invocation must accept the exact provider offer as its bound customer", at);
  const request = offer.object.request;
  const refusals = validate(request, at);
  const expectedEffects = request?.operation === "store" ? STORE_EFFECTS : READ_EFFECTS;
  if (refusals.length !== 0 || !isDeepStrictEqual(activity.object.bindings, offer.object.bindings) || !isDeepStrictEqual(offer.object.bindings, bindings(request)) || !isDeepStrictEqual(offer.object.effects, expectedEffects)) return await reject(activity, refusals[0] ?? "accepted offer changed after solicitation", at);
  let proposed;
  try { proposed = await proposal({ id: offer.object.sourceActivity }, request, at); }
  catch (error) { return await reject(activity, "rmn-conformance-refused", at, { detail: error.message }); }
  if (proposed.semanticId !== offer.object.effect?.semanticId) return await reject(activity, "effect-commitment-drift", at);
  try {
    const client = createR2SigV4Client(r2Configuration());
    const result = request.operation === "store"
      ? await storeGrantedObject(request, { client, now: at })
      : await issueReadCapability(request.knowledge, { client, caller: request.caller, expiresInSeconds: request.expiresInSeconds, now: new Date(at) });
    const evidence = request.operation === "store" ? result.contentDigest : textNi(`${result.object}:${result.expiresAt}`);
    const amount = request.operation === "store" ? result.byteLength : 1;
    const completion = await completeEffect(PROVIDER, proposed.cell, effectCell(request, { positiveEvidence: true, negativeEvidence: false }, evidence, amount), evidence, at);
    const payload = { ...result, effect: completion, credentialRead: true, credentialRecorded: false, customerMutation: false, legacyAssetTouched: false };
    await recordWitnessedBoundaryAct(activity, "r2-custody.completed", at, CONTRACT, { operation: request.operation, object: offer.object.bindings.objectId, evidence, witness: completion.witness, ephemeralCapabilityOmitted: request.operation !== "store" }, WitnessJournal);
    emit(response("Accept", activity, payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const evidence = textNi(`r2-custody-refusal:${message}`);
    let effect;
    try { effect = await completeEffect(PROVIDER, proposed.cell, effectCell(request, { positiveEvidence: false, negativeEvidence: true }, evidence, 0), evidence, at); }
    catch (transitionError) { return await reject(activity, "rmn-completion-refused", at, { detail: transitionError.message }); }
    await reject(activity, message, at, { effect });
  }
}

const at = instant();
let activity;
try { activity = input(); } catch (error) { await reject({}, `invalid JSON input: ${error instanceof Error ? error.message : String(error)}`, at); }
if (activity !== undefined) {
  if (operation() === "solicit-custody-service") await solicit(activity, at);
  else if (operation() === "invoke-custody-service") await invoke(activity, at);
  else await reject(activity, `unknown custody operation ${operation()}`, at);
}
