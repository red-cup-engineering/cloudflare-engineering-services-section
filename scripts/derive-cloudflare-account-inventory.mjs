#!/usr/bin/env node
const API_BASE = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`derive-cloudflare-account-inventory: ${label} must be a JSON object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`derive-cloudflare-account-inventory: ${label} must be a non-empty string`);
  }
  return value;
}

const refusal = (code, detail) => ({ type: "CloudflareAccountInventoryRefusal", code, ...detail });

async function cloudflareGet(fetchImpl, token, path) {
  const response = await fetchImpl(`${API_BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await response.json();
  return { ok: response.ok === true && body?.success === true, body, path };
}

// List endpoints must finish their advertised page set before claiming coverage.
// Missing pagination metadata is accepted only for a short final page.
async function cloudflareList(fetchImpl, token, path, perPage, identity) {
  const values = [];
  const seen = new Set();
  for (let page = 1; page <= 1000; page += 1) {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    query.set("per_page", String(perPage));
    query.set("page", String(page));
    const response = await cloudflareGet(fetchImpl, token, `${path.split("?")[0]}?${query}`);
    if (!response.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: response.path, errors: response.body?.errors ?? [] });
    const items = response.body?.result;
    const info = response.body?.result_info;
    if (!Array.isArray(items) || (info?.page !== undefined && info.page !== page)) {
      return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
    }
    for (const item of items) {
      const id = identity(item);
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
        return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
      }
      seen.add(id);
      values.push(item);
    }
    const actualPerPage = info?.per_page ?? perPage;
    const totalCount = info?.total_count;
    if (!Number.isSafeInteger(actualPerPage) || actualPerPage < 1 || actualPerPage > perPage ||
        (info?.count !== undefined && info.count !== items.length) ||
        (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || totalCount < values.length))) {
      return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
    }
    const totalPages = info?.total_pages;
    if (totalPages !== undefined) {
      if (!Number.isSafeInteger(totalPages) || totalPages < 0 || totalPages > 1000 ||
          (totalPages < page && !(page === 1 && totalPages === 0 && items.length === 0)) ||
          (items.length === 0 && page < totalPages)) {
        return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
      }
      if (page >= totalPages) {
        if (totalCount !== undefined && values.length !== totalCount) {
          return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
        }
        return { values };
      }
    } else if (totalCount !== undefined) {
      if (values.length === totalCount) return { values };
      if (items.length === 0) return refusal("CLOUDFLARE_PAGINATION_INVALID", { path: response.path });
    } else if (items.length < actualPerPage) {
      return { values };
    }
  }
  return refusal("CLOUDFLARE_PAGINATION_LIMIT", { path });
}

function mapDnsRecord(record) {
  return { type: record.type, name: record.name, content: record.content, proxied: record.proxied === true, ttl: record.ttl, id: record.id };
}

function mapWorkerScript(script) {
  return { id: script.id, modifiedOn: script.modified_on ?? script.modifiedOn ?? null };
}

function mapCustomDomain(domain) {
  return { hostname: domain.hostname, service: domain.service, zoneName: domain.zone_name ?? domain.zoneName ?? null };
}

/** Observe one zone's actual Worker ownership with an existing bearer login.
 * Zone/account reads establish scope; this does not require an unrelated
 * token-management or DNS permission, and also accepts native Wrangler OAuth.
 */
export async function observeCloudflareZoneRouting(request, { environment = process.env } = {}) {
  requireObject(request, "request");
  const accountId = requireNonEmptyString(request.accountId, "request.accountId");
  const zoneName = requireNonEmptyString(request.zoneName, "request.zoneName");
  const variable = requireNonEmptyString(request.tokenEnvironmentVariable, "request.tokenEnvironmentVariable");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new TypeError("Cloudflare account ID must be 32 hexadecimal characters");
  const token = environment[variable];
  if (!token) return refusal("TOKEN_ENVIRONMENT_VARIABLE_UNSET", { tokenEnvironmentVariable: variable });
  const read = (url, options) => (request.fetch ?? fetch)(url, {
    ...options, signal: AbortSignal.timeout(15000),
  });
  const selected = await cloudflareList(read, token,
    `/zones?account.id=${accountId}&name=${encodeURIComponent(zoneName)}`, 50, zone => zone?.id);
  if (selected.type) return selected;
  if (selected.values.length !== 1 || selected.values[0].name !== zoneName ||
      selected.values[0].account?.id !== accountId) {
    return refusal("CLOUDFLARE_ZONE_SCOPE_MISMATCH", { accountId, zoneName });
  }
  const zone = selected.values[0];
  const [routes, domains] = await Promise.all([
    cloudflareGet(read, token, `/zones/${zone.id}/workers/routes`),
    cloudflareGet(read, token, `/accounts/${accountId}/workers/domains`),
  ]);
  for (const observation of [routes, domains]) {
    if (!observation.ok) return refusal("CLOUDFLARE_API_REFUSED", {
      path: observation.path, errors: observation.body?.errors ?? [],
    });
    if (!Array.isArray(observation.body.result)) return refusal("CLOUDFLARE_LIST_INVALID", { path: observation.path });
  }
  return Object.freeze({
    type: "CloudflareZoneRouting", version: 1,
    observedAt: new Date().toISOString(), accountId, zoneId: zone.id, zoneName,
    routes: routes.body.result.map(route => ({ id: route.id, pattern: route.pattern, script: route.script })),
    customDomains: domains.body.result
      .filter(domain => domain.zone_id === zone.id || domain.zone_name === zoneName)
      .map(domain => ({ id: domain.id, hostname: domain.hostname, service: domain.service, environment: domain.environment })),
  });
}

/**
 * Derives one CloudflareAccountInventory record -- zones, their DNS records, Workers scripts, and Workers custom domains -- for one Cloudflare account, reading the API token from the named environment variable and refusing rather than throwing on an unset token or a non-success API body.
 * @param {object} request A DeriveCloudflareAccountInventoryRequest.
 * @param {string} request.accountId The Cloudflare account id, exactly 32 hexadecimal characters.
 * @param {string} request.tokenEnvironmentVariable The name of the environment variable holding the Cloudflare API token (e.g. "CLOUDFLARE_API_TOKEN"); the token itself is read from `process.env`, never accepted directly.
 * @param {typeof fetch} [request.fetch] An injectable fetch implementation, defaulting to the global fetch, for deterministic tests.
 * @returns {Promise<object>} A CloudflareAccountInventory record on success, or a CloudflareAccountInventoryRefusal datum carrying code `TOKEN_ENVIRONMENT_VARIABLE_UNSET` or `CLOUDFLARE_API_REFUSED`.
 * @throws {TypeError} When `request` is not a JSON object, `request.accountId` is not 32 hexadecimal characters, or `request.tokenEnvironmentVariable` is not a non-empty string.
 */
export async function deriveCloudflareAccountInventory(request, { environment = process.env } = {}) {
  requireObject(request, "request");
  const accountId = requireNonEmptyString(request.accountId, "request.accountId");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new TypeError("derive-cloudflare-account-inventory: request.accountId must be exactly 32 hexadecimal characters");
  }
  const tokenEnvironmentVariable = requireNonEmptyString(request.tokenEnvironmentVariable, "request.tokenEnvironmentVariable");
  const fetchImpl = request.fetch ?? fetch;

  const token = environment[tokenEnvironmentVariable];
  if (typeof token !== "string" || token.length === 0) {
    return refusal("TOKEN_ENVIRONMENT_VARIABLE_UNSET", { tokenEnvironmentVariable });
  }

  const verify = await cloudflareGet(fetchImpl, token, "/user/tokens/verify");
  if (!verify.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: verify.path, errors: verify.body?.errors ?? [] });
  const tokenStatus = verify.body.result?.status ?? null;

  const zonesResponse = await cloudflareList(fetchImpl, token, `/zones?account.id=${accountId}`, 50, zone => zone?.id);
  if (zonesResponse.type) return zonesResponse;
  const rawZones = zonesResponse.values;
  if (rawZones.some(zone => zone.account?.id !== undefined && (typeof zone.account.id !== "string" || zone.account.id.toLowerCase() !== accountId.toLowerCase()))) {
    return refusal("CLOUDFLARE_ACCOUNT_SCOPE_MISMATCH", { accountId });
  }

  const zones = [];
  let recordCount = 0;
  for (const zone of rawZones) {
    const recordsResponse = await cloudflareList(fetchImpl, token, `/zones/${zone.id}/dns_records`, 500, record => record?.id);
    if (recordsResponse.type) return recordsResponse;
    const records = recordsResponse.values.map(mapDnsRecord);
    recordCount += records.length;
    zones.push({ id: zone.id, name: zone.name, status: zone.status, records });
  }

  const workersResponse = await cloudflareGet(fetchImpl, token, `/accounts/${accountId}/workers/scripts`);
  if (!workersResponse.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: workersResponse.path, errors: workersResponse.body?.errors ?? [] });
  if (!Array.isArray(workersResponse.body.result)) return refusal("CLOUDFLARE_LIST_INVALID", { path: workersResponse.path });
  const workers = workersResponse.body.result.map(mapWorkerScript);

  const domainsResponse = await cloudflareGet(fetchImpl, token, `/accounts/${accountId}/workers/domains`);
  if (!domainsResponse.ok) return refusal("CLOUDFLARE_API_REFUSED", { path: domainsResponse.path, errors: domainsResponse.body?.errors ?? [] });
  if (!Array.isArray(domainsResponse.body.result)) return refusal("CLOUDFLARE_LIST_INVALID", { path: domainsResponse.path });
  const customDomains = domainsResponse.body.result.map(mapCustomDomain);

  return Object.freeze({
    type: "CloudflareAccountInventory",
    version: 1,
    observedAt: new Date().toISOString(),
    accountId,
    tokenStatus,
    zones,
    workers,
    customDomains,
    counts: { zones: zones.length, records: recordCount, workers: workers.length, customDomains: customDomains.length },
  });
}


/**
 * Read the *native account* Workers Builds exhaustion signal with an already
 * admitted user-scoped Workers CI Read token. This is not the general Worker,
 * KV or R2 allowance, not an estimated number of unused build minutes, and
 * not a billing receipt. Incomplete or denied scope remains UNKNOWN.
 */
export async function observeCloudflareBuildMinutes(request, { environment = process.env } = {}) {
  requireObject(request, "request");
  const accountId = requireNonEmptyString(request.accountId, "request.accountId");
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new TypeError("Cloudflare build observation needs an exact account id");
  }
  const tokenEnvironmentVariable = requireNonEmptyString(request.tokenEnvironmentVariable, "request.tokenEnvironmentVariable");
  const token = environment[tokenEnvironmentVariable];
  if (typeof token !== "string" || !token.length) {
    return refusal("TOKEN_ENVIRONMENT_VARIABLE_UNSET", { tokenEnvironmentVariable });
  }
  let observation;
  try {
    observation = await cloudflareGet((url, options) => (request.fetch ?? fetch)(url, {
      ...options, signal: AbortSignal.timeout(15_000),
    }), token, `/accounts/${accountId}/builds/account/limits`);
  } catch {
    return refusal("CLOUDFLARE_BUILD_LIMIT_UNAVAILABLE", { reason: "transport-error" });
  }
  if (!observation.ok) {
    // Workers Builds requires Workers CI Read on a supported user token; the
    // account-scoped inventory token may legitimately lack that permission.
    return refusal("CLOUDFLARE_BUILD_LIMIT_UNAVAILABLE", { reason: "provider-refusal" });
  }
  const result = observation.body?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return refusal("CLOUDFLARE_BUILD_LIMIT_INVALID", { reason: "missing-result" });
  }
  const reached = result.has_reached_build_minutes_limit;
  const refresh = result?.build_minutes_refresh_on;
  if (reached !== undefined && typeof reached !== "boolean") {
    return refusal("CLOUDFLARE_BUILD_LIMIT_INVALID", { reason: "invalid-exhaustion-flag" });
  }
  if (refresh !== undefined && (typeof refresh !== "string" || !Number.isFinite(Date.parse(refresh)))) {
    return refusal("CLOUDFLARE_BUILD_LIMIT_INVALID", { reason: "invalid-refresh-time" });
  }
  return Object.freeze({
    type: "CloudflareWorkersBuildMinutesObservation",
    version: 1,
    accountId,
    observedAt: new Date().toISOString(),
    status: reached === true ? "exhausted" : reached === false ? "not-exhausted" : "unknown",
    refreshAt: refresh ?? null,
    claim: "Workers Builds allowance only; this response does not measure remaining minutes, billable cost, KV, R2, or Worker invocations",
  });
}


/** Native Workers script → storage binding incidence, for tracing KV / DO /
 * R2 usage to its accountable producer. No storage contents or Worker source
 * code is requested. Bindings are provider-owned projections, not a second
 * machine registry and not evidence of current operations or spend.
 */
export async function deriveCloudflareWorkerStorageBindings(request) {
  requireObject(request,"request");
  const accountId=requireNonEmptyString(request.accountId,"request.accountId");
  if(!ACCOUNT_ID_PATTERN.test(accountId))
    throw new TypeError("cloudflare worker bindings require an exact account identifier");
  const tokenEnvironmentVariable=requireNonEmptyString(
    request.tokenEnvironmentVariable,"request.tokenEnvironmentVariable");
  const token=process.env[tokenEnvironmentVariable];
  if(typeof token!=="string"||!token.length)
    return refusal("TOKEN_ENVIRONMENT_VARIABLE_UNSET",{tokenEnvironmentVariable});
  const sourceFetch=request.fetch??fetch;
  const boundedFetch=(url,options)=>sourceFetch(url,{
    ...options,signal:AbortSignal.timeout(10000),
  });
  let scriptsResponse;
  try {scriptsResponse=await cloudflareGet(boundedFetch,token,`/accounts/${accountId}/workers/scripts`);}
  catch {return refusal("CLOUDFLARE_WORKER_BINDING_READ_UNAVAILABLE",{stage:"list-workers"});}
  if(!scriptsResponse.ok)
    return refusal("CLOUDFLARE_WORKER_BINDING_READ_UNAVAILABLE",{stage:"list-workers"});
  const scripts=scriptsResponse.body?.result,info=scriptsResponse.body?.result_info;
  if(!Array.isArray(scripts)||scripts.length>150||
      (info?.total_count!==undefined&&info.total_count!==scripts.length)||
      (info?.total_pages!==undefined&&info.total_pages>1))
    return refusal("CLOUDFLARE_WORKER_BINDING_COVERAGE_INCOMPLETE",{stage:"list-workers"});
  const ids=scripts.map(script=>script?.id);
  if(ids.some(id=>typeof id!=="string"||!/^[a-z0-9_.-]{1,128}$/iu.test(id))
      ||new Set(ids).size!==ids.length)
    return refusal("CLOUDFLARE_WORKER_BINDING_COVERAGE_INCOMPLETE",{stage:"worker-identities"});
  const reads=[];
  // Six bounded concurrent native GETs; total requests cannot exceed the
  // authenticated list's current 150 scripts, and no write route is called.
  for(let i=0;i<ids.length;i+=6){
    const batch=await Promise.all(ids.slice(i,i+6).map(async id=>{
      try{
        const item=await cloudflareGet(boundedFetch,token,
          `/accounts/${accountId}/workers/scripts/${encodeURIComponent(id)}/settings`);
        if(!item.ok)return {worker:id,status:"provider-refusal"};
        const bindings=item.body?.result?.bindings;
        if(!Array.isArray(bindings)||bindings.some(x=>!x||typeof x!=="object"
            ||typeof x.type!=="string"))
          return {worker:id,status:"invalid-settings"};
        const selected=bindings.filter(b=>
          ["kv_namespace","durable_object_namespace","r2_bucket","d1","queue"].includes(b.type));
        // Read the provider's actual typed resource reference, not only a KV
        // namespace field. Every projected binding must have one resource identity.
        // Environment values, tokens and arbitrary provider metadata are excluded.
        const nonempty=value=>typeof value==="string"&&value.length>0;
        const project=b=>{
          if(!nonempty(b.name))return null;
          const common={type:b.type,bindingName:b.name,
            namespaceId:nonempty(b.namespace_id)?b.namespace_id:null};
          switch(b.type){
            case "kv_namespace":
              return nonempty(b.namespace_id)?common:null;
            case "durable_object_namespace":
              if(![b.namespace_id,b.class_name,b.dispatch_namespace].some(nonempty))return null;
              return {...common,
                ...(nonempty(b.class_name)?{className:b.class_name}:{}),
                ...(nonempty(b.script_name)?{scriptName:b.script_name}:{}),
                ...(nonempty(b.environment)?{environment:b.environment}:{}),
                ...(nonempty(b.dispatch_namespace)?{dispatchNamespace:b.dispatch_namespace}:{})};
            case "r2_bucket":
              return nonempty(b.bucket_name)?{...common,bucketName:b.bucket_name,
                ...(nonempty(b.jurisdiction)?{jurisdiction:b.jurisdiction}:{})}:null;
            case "d1":
              return nonempty(b.database_id)?{...common,databaseId:b.database_id}:null;
            case "queue":
              return nonempty(b.queue_name)?{...common,queueName:b.queue_name}:null;
            default:return null;
          }
        };
        const projected=selected.map(project);
        // A malformed or duplicate provider resource is unknown, not empty.
        // Do not let a partial settings read certify a stateless Worker.
        if(projected.some(b=>b===null)||
           new Set(projected.map(b=>b.bindingName)).size!==projected.length)
          return {worker:id,status:"invalid-settings"};
        return {worker:id,status:"observed",bindings:projected};
      }catch{return {worker:id,status:"provider-unavailable"};}
    }));
    reads.push(...batch);
  }
  const unread=reads.filter(r=>r.status!=="observed").map(r=>({worker:r.worker,status:r.status}));
  const bound=reads.filter(r=>r.status==="observed"&&r.bindings.length>0);
  return Object.freeze({
    type:"CloudflareWorkerStorageBindingObservation",
    observedAt:new Date().toISOString(),accountId,source:"Cloudflare Workers Script Version Settings",
    scriptsEnumerated:ids.length,settingsObserved:reads.length-unread.length,
    complete:unread.length===0,unread,
    storageBindings:bound.sort((a,b)=>a.worker.localeCompare(b.worker)),
    // This is a binding graph, NOT a provider operation quota or billing reading.
    currentOperationUsage:"unknown",freeTierHeadroom:"unknown",
  });
}

/**
 * The Cloudflare account's actual R2 bucket holdings, read through the same
 * scoped provider credential boundary as its native Worker observations.
 * This is a STORAGE-CARRIER inventory, not an object, license or sale catalog:
 * listing a bucket does not grant rights to publish/resell its contents.
 *
 * R2 uses cursor pagination, unlike Zones' page-number pagination. No output
 * on partial coverage is permitted to masquerade as an empty bucket account.
 */
export async function observeCloudflareR2Buckets(request, { environment = process.env } = {}) {
  requireObject(request,"request");
  const accountId=requireNonEmptyString(request.accountId,"request.accountId");
  if(!ACCOUNT_ID_PATTERN.test(accountId))throw new TypeError("R2 account id must be exact");
  const tokenEnvironmentVariable=requireNonEmptyString(
    request.tokenEnvironmentVariable,"request.tokenEnvironmentVariable");
  const token=environment[tokenEnvironmentVariable];
  if(typeof token!=="string"||!token.length)
    return refusal("TOKEN_ENVIRONMENT_VARIABLE_UNSET",{tokenEnvironmentVariable});
  const sourceFetch=request.fetch??fetch;
  const bounded=(url,options)=>sourceFetch(url,{
    ...options,signal:AbortSignal.timeout(10000),
  });
  const buckets=[],names=new Set(),cursors=new Set();
  let cursor;
  for(let page=0;page<100;page++){
    const path=`/accounts/${accountId}/r2/buckets`
      +(cursor===undefined?"":`?cursor=${encodeURIComponent(cursor)}`);
    let reply;
    try{reply=await cloudflareGet(bounded,token,path);}
    catch{return refusal("CLOUDFLARE_R2_BUCKET_COVERAGE_UNAVAILABLE",{reason:"provider-transport"});}
    if(!reply.ok)
      return refusal("CLOUDFLARE_R2_BUCKET_COVERAGE_UNAVAILABLE",{reason:"native-provider-refusal"});
    const rows=reply.body?.result?.buckets,next=reply.body?.result_info?.cursor;
    if(!Array.isArray(rows)||rows.length>1000||buckets.length+rows.length>4096
        ||(next!==undefined&&next!==null&&(typeof next!=="string"||!next)))
      return refusal("CLOUDFLARE_R2_BUCKET_COVERAGE_INVALID",{reason:"native-response-shape"});
    for(const bucket of rows){
      const name=bucket?.name;
      if(typeof name!=="string"||!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(name)||names.has(name))
        return refusal("CLOUDFLARE_R2_BUCKET_COVERAGE_INVALID",{reason:"duplicate-or-invalid-bucket"});
      names.add(name);
      buckets.push({
        name,
        jurisdiction:typeof bucket.jurisdiction==="string"?bucket.jurisdiction:null,
        location:typeof bucket.location==="string"?bucket.location:null,
        storageClass:typeof bucket.storage_class==="string"?bucket.storage_class:null,
        createdAt:typeof bucket.creation_date==="string"?bucket.creation_date:null,
      });
    }
    if(next===undefined||next===null||next===""){
      return Object.freeze({
        type:"CloudflareR2BucketObservation",accountId,
        observedAt:new Date().toISOString(),coverage:"complete",
        buckets:Object.freeze(buckets),rightsToResell:"unverified",
        objectInventory:"unobserved",quotaHeadroom:"unobserved",billing:"unobserved",
      });
    }
    if(cursors.has(next))
      return refusal("CLOUDFLARE_R2_BUCKET_COVERAGE_INVALID",{reason:"repeated-cursor"});
    cursors.add(next);cursor=next;
  }
  return refusal("CLOUDFLARE_R2_BUCKET_COVERAGE_INVALID",{reason:"page-limit"});
}

if (import.meta.main) {
  const { runJavascriptNodeOperation } = await import("@red-cup-engineering/javascript-node-operation-engineering-services-section/operation");
  const result = await runJavascriptNodeOperation({ name: "derive-cloudflare-account-inventory", description: "Derives one CloudflareAccountInventory record -- zones, their DNS records, Workers scripts, and Workers custom domains -- for one Cloudflare account, reading the API token from the named environment variable and refusing rather than throwing on an unset token or a non-success API body.", operation: deriveCloudflareAccountInventory }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
