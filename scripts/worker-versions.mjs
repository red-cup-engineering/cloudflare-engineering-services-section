/** The Cloudflare owner's small version-effect adapter. It neither builds a
 * Worker nor decides whether a merchant release is fit for traffic.
 *
 * Provider contracts checked 2026-10-26:
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/
 * https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
 * Script-version inherit resolves LATEST UPLOADED, not necessarily deployed.
 * Strict inherit is mandatory here. The application must check its lease.
 */
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const API = 'https://api.cloudflare.com/client/v4';
const MAX_JSON = 4 * 1024 * 1024;
const MAX_CONTENT = 32 * 1024 * 1024;

export class WorkerVersionEffectError extends Error {
  constructor(code, { status = null, providerCodes = [] } = {}) {
    // Never retain a provider body, request headers, token, or transport cause.
    super(code);
    this.name = 'WorkerVersionEffectError';
    this.code = code;
    this.status = status;
    this.providerCodes = providerCodes.filter(Number.isSafeInteger);
  }
}

function requireVersion(id) {
  if (!UUID.test(id ?? '')) throw new WorkerVersionEffectError('INVALID_WORKER_VERSION');
  return id.toLowerCase();
}

async function boundedBytes(response, limit) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    await response.body?.cancel().catch(() => {});
    throw new WorkerVersionEffectError('PROVIDER_BODY_LIMIT');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new WorkerVersionEffectError('PROVIDER_BODY_LIMIT');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Bound to one existing account and script. No arbitrary API paths, retries,
 * route edits, secret edits, account provisioning, or preview enablement. */
export function createWorkerVersionClient({ accountId, scriptName, token, fetch: send = globalThis.fetch } = {}) {
  if (!/^[a-f0-9]{32}$/iu.test(accountId ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/u.test(scriptName ?? '') ||
      typeof token !== 'string' || !token || /[\r\n]/u.test(token) || typeof send !== 'function') {
    throw new WorkerVersionEffectError('INVALID_WORKER_PROVIDER_SELECTION');
  }
  const script = `${API}/accounts/${accountId}/workers/scripts/${scriptName}`;
  async function request(suffix, { method = 'GET', body, limit = MAX_JSON, raw = false } = {}) {
    let response, bytes;
    try {
      response = await send(`${script}${suffix}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-cache',
          ...((body !== undefined && !(body instanceof FormData)) ? { 'content-type': 'application/json' } : {}) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
      bytes = await boundedBytes(response, limit);
    } catch (error) {
      if (error instanceof WorkerVersionEffectError) throw error;
      throw new WorkerVersionEffectError('PROVIDER_TRANSPORT_UNRECEIVED', { status: response?.status });
    }
    if (raw && response.ok) return { bytes, contentType: response.headers.get('content-type') ?? '' };
    let envelope;
    try { envelope = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new WorkerVersionEffectError('PROVIDER_JSON_UNRECEIVED', { status: response.status }); }
    if (!response.ok || envelope?.success !== true || !Object.hasOwn(envelope, 'result')) {
      throw new WorkerVersionEffectError('PROVIDER_OPERATION_REFUSED', { status: response.status,
        providerCodes: Array.isArray(envelope?.errors) ? envelope.errors.map(row => row?.code) : [] });
    }
    return envelope.result;
  }
  return Object.freeze({
    async activeDeployment() {
      const result = await request('/deployments');
      const current = result?.deployments?.[0];
      if (!UUID.test(current?.id ?? '') || !Array.isArray(current.versions) || current.versions.length !== 1 ||
          current.versions[0].percentage !== 100) throw new WorkerVersionEffectError('SINGLE_ACTIVE_VERSION_REQUIRED');
      requireVersion(current.versions[0].version_id);
      return current;
    },
    async latestVersion() {
      const result = await request('/versions');
      if (!Array.isArray(result?.items) || !result.items.length || result.items.some(item =>
        !UUID.test(item?.id ?? '') || !Number.isSafeInteger(item?.number))) {
        throw new WorkerVersionEffectError('LATEST_VERSION_UNRECEIVED');
      }
      return [...result.items].sort((a, b) => b.number - a.number)[0];
    },
    async version(id) {
      const selected = requireVersion(id), result = await request(`/versions/${selected}`);
      if (result?.id?.toLowerCase() !== selected) throw new WorkerVersionEffectError('PROVIDER_VERSION_IDENTITY_CHANGED');
      return result;
    },
    scriptSettings() { return request('/script-settings'); },
    subdomain() { return request('/subdomain'); },
    // This API has no documented version selector. The caller must bracket it
    // with latestVersion readbacks that both equal the selected staged UUID.
    content() { return request('/content/v2', { limit: MAX_CONTENT, raw: true }); },
    async uploadVersion({ metadata, moduleBytes }) {
      if (!metadata || metadata.main_module !== 'worker.mjs' || !Array.isArray(metadata.bindings) ||
          !(moduleBytes instanceof Uint8Array) || moduleBytes.length === 0 || moduleBytes.length > MAX_CONTENT ||
          metadata.bindings.some(binding => binding?.type === 'inherit' && binding.version_id !== undefined)) {
        throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
      }
      const body = new FormData();
      body.set('metadata', JSON.stringify(metadata));
      body.set('worker.mjs', new Blob([moduleBytes], { type: 'application/javascript+module' }), 'worker.mjs');
      const result = await request('/versions?bindings_inherit=strict', { method: 'POST', body });
      requireVersion(result?.id);
      return result;
    },
    async deployVersion({ versionId, message }) {
      requireVersion(versionId);
      if (typeof message !== 'string' || message.length < 1 || new TextEncoder().encode(message).length > 1000) {
        throw new WorkerVersionEffectError('INVALID_DEPLOYMENT_MESSAGE');
      }
      const result = await request('/deployments', { method: 'POST', body: {
        strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { 'workers/message': message },
      } });
      requireVersion(result?.id);
      return result;
    },
  });
}

/** Parse the provider's native module response. Field names are transport
 * labels; the receiver compares the returned module bytes, not those names. */
export async function workerContentModules({ bytes, contentType }) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_CONTENT) throw new WorkerVersionEffectError('INVALID_CONTENT_RESPONSE');
  if (/^multipart\/form-data(?:;|$)/iu.test(contentType)) {
    let form;
    try { form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData(); }
    catch { throw new WorkerVersionEffectError('PROVIDER_MULTIPART_UNRECEIVED'); }
    const modules = [];
    for (const [name, value] of form) {
      if (name === 'metadata' && typeof value === 'string') continue;
      modules.push(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer()));
    }
    return modules;
  }
  if (/^(?:application|text)\/(?:javascript|javascript\+module|ecmascript)(?:;|$)/iu.test(contentType)) return [bytes];
  throw new WorkerVersionEffectError('UNEXPECTED_WORKER_CONTENT_TYPE');
}
