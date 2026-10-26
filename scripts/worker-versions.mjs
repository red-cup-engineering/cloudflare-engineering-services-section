/** The Cloudflare owner's small version-effect adapter. It neither builds a
 * Worker nor decides whether a merchant release is fit for traffic.
 *
 * Provider contracts checked 2026-10-26:
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/
 * https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/
 * https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get/
 * https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create/
 * https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
 * Script-version inherit resolves LATEST UPLOADED, not necessarily deployed.
 * Explicit UUID inheritance uses the distinct Workers version operation.
 * The application must check its lease with either upload capability.
 */
import { Buffer } from 'node:buffer';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const API = 'https://api.cloudflare.com/client/v4';
const MAX_JSON = 4 * 1024 * 1024;
const MAX_CONTENT = 32 * 1024 * 1024;
const MAX_MODULE_JSON = Math.ceil(MAX_CONTENT / 3) * 4 + MAX_JSON;
const VERSION_METADATA = new Set(['annotations', 'assets', 'bindings', 'cache_options',
  'compatibility_date', 'compatibility_flags', 'containers', 'exports', 'limits',
  'main_module', 'migrations', 'package_dependencies', 'placement', 'usage_model']);
const VERSION_ANNOTATIONS = new Set(['workers/message', 'workers/tag', 'workers/triggered_by']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

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

/** The script-subdomain response supplies availability flags, not a hostname.
 * Derive the documented version origin from the separately received existing
 * account subdomain and selected script/version. This performs no API call. */
export function workerVersionPreviewOrigin({ versionId, scriptName, accountSubdomain } = {}) {
  const version = requireVersion(versionId);
  if (typeof accountSubdomain !== 'string' || !DNS_LABEL.test(accountSubdomain)) throw new WorkerVersionEffectError('WORKER_ACCOUNT_SUBDOMAIN_UNRECEIVED');
  const workerLabel = `${version.slice(0, 8)}-${scriptName}`;
  if (typeof scriptName !== 'string' || !DNS_LABEL.test(scriptName) || !DNS_LABEL.test(workerLabel)) {
    throw new WorkerVersionEffectError('WORKER_VERSION_PREVIEW_ADDRESS_UNRECEIVED');
  }
  return `https://${workerLabel}.${accountSubdomain}.workers.dev`;
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
  const accountRoot = `${API}/accounts/${accountId}`;
  const script = `${accountRoot}/workers/scripts/${scriptName}`;
  async function request(suffix, { method = 'GET', body, limit = MAX_JSON, raw = false, accountScope = false } = {}) {
    let response, bytes;
    try {
      response = await send(`${accountScope ? accountRoot : script}${suffix}`, {
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
    async accountSubdomain() {
      const result = await request('/workers/subdomain', { accountScope: true });
      if (typeof result?.subdomain !== 'string' || !DNS_LABEL.test(result.subdomain)) throw new WorkerVersionEffectError('WORKER_ACCOUNT_SUBDOMAIN_UNRECEIVED');
      return result;
    },
    async versionModules(id) {
      const selected = requireVersion(id);
      // The documented Worker identifier accepts its existing name. Request
      // this immutable version's modules explicitly; the legacy content read
      // below has no documented version selector or latest/active contract.
      const result = await request(`/workers/workers/${scriptName}/versions/${selected}?include=modules`,
        { accountScope: true, limit: MAX_MODULE_JSON });
      if (result?.id?.toLowerCase() !== selected) throw new WorkerVersionEffectError('PROVIDER_VERSION_IDENTITY_CHANGED');
      if (!Array.isArray(result.modules) || result.modules.length < 1 || result.modules.length > 128) {
        throw new WorkerVersionEffectError('VERSION_MODULES_UNRECEIVED');
      }
      let total = 0;
      const names = new Set(), modules = [];
      for (const item of result.modules) {
        if (typeof item?.name !== 'string' || !item.name || names.has(item.name) ||
            typeof item.content_type !== 'string' || !item.content_type ||
            typeof item.content_base64 !== 'string' || item.content_base64.length > Math.ceil((MAX_CONTENT - total) / 3) * 4) {
          throw new WorkerVersionEffectError('VERSION_MODULES_UNRECEIVED');
        }
        names.add(item.name);
        const bytes = Buffer.from(item.content_base64, 'base64');
        total += bytes.length;
        if (total > MAX_CONTENT) throw new WorkerVersionEffectError('PROVIDER_BODY_LIMIT');
        // Buffer's decoder is intentionally permissive. A canonical round trip
        // refuses skipped characters, whitespace, wrong padding and URL base64.
        if (bytes.toString('base64') !== item.content_base64) throw new WorkerVersionEffectError('VERSION_MODULE_BASE64_UNRECEIVED');
        modules.push(new Uint8Array(bytes));
      }
      return modules;
    },
    // Retained legacy read: this API documents neither a version selector nor
    // latest-versus-active ownership. Use versionModules for version custody.
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
    async uploadVersionFrom(options = {}) {
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
      const { metadata, moduleBytes, inheritVersionId } = options;
      if (typeof inheritVersionId !== 'string') throw new WorkerVersionEffectError('INVALID_WORKER_VERSION');
      const selected = requireVersion(inheritVersionId);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
          !(moduleBytes instanceof Uint8Array) || moduleBytes.length === 0 || moduleBytes.length > MAX_CONTENT) {
        throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
      }
      if (Object.keys(metadata).some(key => !VERSION_METADATA.has(key))) {
        throw new WorkerVersionEffectError('UNSUPPORTED_VERSION_UPLOAD_METADATA');
      }
      let retained;
      try {
        const encoded = JSON.stringify(metadata, (_key, value) => {
          if (value === undefined || ['function', 'symbol', 'bigint'].includes(typeof value) ||
              (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('Non-JSON metadata');
          return value;
        });
        if (Buffer.byteLength(encoded) > MAX_JSON) throw new TypeError('Metadata limit');
        retained = JSON.parse(encoded);
      } catch { throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD'); }
      if (!retained || retained.main_module !== 'worker.mjs' || !Array.isArray(retained.bindings)) {
        throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
      }
      if (retained.annotations !== undefined) {
        const annotations = retained.annotations;
        if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations) ||
            Object.keys(annotations).some(key => !VERSION_ANNOTATIONS.has(key))) {
          throw new WorkerVersionEffectError('UNSUPPORTED_VERSION_UPLOAD_ANNOTATIONS');
        }
        if (Object.entries(annotations).some(([key, value]) => typeof value !== 'string' ||
            (key === 'workers/message' && Buffer.byteLength(value) > 1000) ||
            (key === 'workers/tag' && Buffer.byteLength(value) > 100))) {
          throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
        }
      }
      const names = new Set();
      retained.bindings = retained.bindings.map(binding => {
        if (!binding || typeof binding.name !== 'string' || !binding.name || names.has(binding.name) ||
            typeof binding.type !== 'string' || !binding.type ||
            (binding.version_id !== undefined && (binding.type !== 'inherit' ||
              typeof binding.version_id !== 'string' || binding.version_id.toLowerCase() !== selected))) {
          throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
        }
        names.add(binding.name);
        return binding.type === 'inherit' ? { ...binding, version_id: selected } : binding;
      });
      const body = { ...retained, modules: [{ name: 'worker.mjs',
        content_type: 'application/javascript+module', content_base64: Buffer.from(moduleBytes).toString('base64') }] };
      if (Buffer.byteLength(JSON.stringify(body)) > MAX_MODULE_JSON) throw new WorkerVersionEffectError('INVALID_VERSION_UPLOAD');
      // This supported JSON operation alone accepts the selected inherit UUID.
      // Its response can echo modules, so receive the original bounded expansion.
      const result = await request(`/workers/workers/${scriptName}/versions?deploy=false`,
        { method: 'POST', body, accountScope: true, limit: MAX_MODULE_JSON });
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
