#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { parse as parseJsonc } from 'jsonc-parser';
import { canonicalJson } from '@red-cup-engineering/json-services-section/canonical-json';
import { makeNiUri } from '@red-cup-engineering/uri-services-section/ni-uri';
import { projectWebReleaseManifestArtifact, verifyWebReleaseDirectory, createPublicRelease, decidePublicRelease } from '@red-cup-engineering/web-release-candidate-service';
import { checkStaticSiteInventory, probeStaticSiteRelease } from '@red-cup-engineering/static-site-conformance-service';
import { withCloudflareToken } from './with-cloudflare-token.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const MANIFEST = 'release-manifest.json';
const CONFIGURATION = new Set(['_headers', '_redirects']);
const MEDIA = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.wasm': 'application/wasm' };
const CONFIG_KEYS = new Set(['$schema', 'name', 'account_id', 'compatibility_date', 'compatibility_flags', 'assets', 'routes', 'workers_dev', 'preview_urls', 'send_metrics']);
const ASSET_KEYS = new Set(['directory', 'html_handling', 'not_found_handling']);
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = createRequire(import.meta.url);
const demand = (condition, message) => { if (!condition) throw new Error(message); };
const digest = value => makeNiUri(Buffer.from(canonicalJson(value)));
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

async function jsonFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
async function lock(path) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname() }));
      await file.close();
      return async () => { await unlink(path); };
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      const previous = await jsonFile(path);
      demand(previous.hostname === hostname() && Number.isSafeInteger(previous.pid), 'A different host owns the static release lock');
      try { process.kill(previous.pid, 0); throw new Error(`Static release process ${previous.pid} is already running`); }
      catch (running) { if (running.code !== 'ESRCH') throw running; }
      await unlink(path);
    }
  }
}

/** Read the existing Wrangler configuration and form its native web artifact. */
export async function prepareStaticApplication({ configPath, source, canonicalOrigin, maxFiles = 5000, maxBytes = 128 * 1024 * 1024 } = {}) {
  configPath = resolve(configPath);
  const configStat = await lstat(configPath);
  demand(configStat.isFile() && !configStat.isSymbolicLink(), 'Wrangler configuration must be a regular file');
  const configBytes = await readFile(configPath);
  const errors = [];
  const config = parseJsonc(configBytes.toString('utf8'), errors, { allowTrailingComma: true });
  demand(!errors.length && config && typeof config === 'object' && !Array.isArray(config), 'Wrangler configuration must be JSON or JSONC');
  demand(Object.keys(config).every(key => CONFIG_KEYS.has(key)), 'Static application configuration includes a Worker handler, binding, build hook, environment or unsupported setting');
  demand(typeof config.name === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name), 'An explicit Worker name is required');
  demand(config.assets && typeof config.assets.directory === 'string' && Object.keys(config.assets).every(key => ASSET_KEYS.has(key)), 'Static application needs one assets directory without a Worker binding');
  demand(Array.isArray(config.routes) && config.routes.length > 0, 'Existing custom domains must be declared');
  const domains = config.routes.map(route => {
    demand(route && route.custom_domain === true && Object.keys(route).every(key => ['pattern', 'custom_domain'].includes(key)), 'Only existing custom-domain routes are supported');
    demand(typeof route.pattern === 'string' && /^[a-z0-9.-]+$/.test(route.pattern) && route.pattern.includes('.'), 'Custom-domain hostname is invalid');
    return route.pattern;
  }).sort();
  demand(new Set(domains).size === domains.length, 'Custom domains must be unique');
  const origin = new URL(canonicalOrigin ?? `https://${domains[0]}/`);
  demand(origin.protocol === 'https:' && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash && domains.includes(origin.hostname), 'Canonical origin must be a declared HTTPS custom domain');
  demand(source && typeof source.repository === 'string' && source.repository && typeof source.revision === 'string' && source.revision && Array.isArray(source.build?.command) && source.build.command.length, 'Source repository, revision and build command are required');
  demand(Number.isSafeInteger(maxFiles) && maxFiles > 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0, 'Release bounds must be positive integers');
  const root = resolve(dirname(configPath), config.assets.directory);
  demand(root !== dirname(configPath), 'Use a dedicated build directory for public assets');
  const rootStat = await lstat(root);
  demand(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Assets must be a regular directory');
  const artifacts = [];
  let bytes = 0;
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join('/');
      demand(!entry.isSymbolicLink(), `Assets contain a symbolic link: ${name}`);
      if (entry.isDirectory()) { await visit(path); continue; }
      demand(entry.isFile(), `Assets contain a special file: ${name}`);
      if (name === MANIFEST) continue;
      demand(entry.name !== '.assetsignore', 'Remove .assetsignore from the sealed release; every manifest artifact must upload');
      const stat = await lstat(path);
      demand(bytes + stat.size <= maxBytes && artifacts.length < maxFiles, 'Static release exceeds its file or byte bound');
      const body = await readFile(path);
      bytes += body.length;
      demand(bytes <= maxBytes, 'Static release grew beyond its byte bound');
      artifacts.push({ path: name, body, ...(MEDIA[extname(name).toLowerCase()] ? { mediaType: MEDIA[extname(name).toLowerCase()] } : {}) });
    }
  }
  await visit(root);
  demand(artifacts.some(item => item.path === 'index.html'), 'Static application needs index.html');
  const projected = projectWebReleaseManifestArtifact({ artifacts, config: { path: MANIFEST, baseUrl: origin.href, profile: 'production', metadata: { source, providerConfigurationFiles: artifacts.filter(item => CONFIGURATION.has(item.path)).map(item => item.path).sort() } } });
  demand(projected.manifest && !projected.diagnostics.length, 'Could not form the web release manifest');
  const local = checkStaticSiteInventory({ artifacts, manifest: projected.manifest });
  demand(local.valid, `Static assets have invalid local links: ${JSON.stringify(local.diagnostics)}`);
  return { configPath, configBytes, config, domains, root, source, canonicalOrigin: origin.href, manifest: projected.manifest, manifestBody: projected.artifacts[0].body, artifacts, maxFiles: maxFiles + 1, maxBytes: maxBytes + Buffer.byteLength(projected.artifacts[0].body) };
}

function cloudflare(accountId, token, fetchImpl) {
  demand(/^[a-f0-9]{32}$/.test(accountId ?? '') && typeof token === 'string' && token.length > 0, 'Cloudflare account ID and scoped API token are required');
  return async (path, method = 'GET', input) => {
    const response = await fetchImpl(`${API}/accounts/${accountId}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' }, ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20000) });
    const body = await response.json();
    demand(response.ok && body.success === true, `Cloudflare ${method} failed: HTTP ${response.status}; codes ${(body.errors ?? []).map(item => item.code).join(',')}`);
    return body;
  };
}
async function snapshot(api, candidate) {
  const worker = encodeURIComponent(candidate.config.name);
  const [domainResult, deploymentResult, settingsResult] = await Promise.all([
    api(`/workers/domains?service=${worker}`), api(`/workers/scripts/${worker}/deployments`), api(`/workers/scripts/${worker}/settings`),
  ]);
  demand(Array.isArray(domainResult.result), 'Cloudflare domain list is malformed');
  demand(!(domainResult.result_info?.total_pages > 1) && (domainResult.result_info?.count === undefined || domainResult.result_info.count === domainResult.result.length), 'Cloudflare domain list is incomplete');
  const domains = domainResult.result.map(item => ({ id: item.id, hostname: item.hostname, service: item.service, environment: item.environment ?? 'production', zone_id: item.zone_id, enabled: item.enabled !== false })).sort((a, b) => a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0);
  demand(domains.every(item => item.service === candidate.config.name && item.enabled && item.environment === 'production'), 'Existing Worker domains are disabled or refer to another environment');
  demand(same(domains.map(item => item.hostname), candidate.domains), 'Existing Worker custom domains differ from the application configuration');
  const bindings = settingsResult.result?.bindings;
  demand(Array.isArray(bindings) && bindings.every(item => item?.type === 'assets'), 'Existing Worker has non-static bindings');
  const deployment = deploymentResult.result?.deployments?.[0];
  demand(deployment && deployment.versions?.length === 1 && deployment.versions[0].percentage === 100 && VERSION.test(deployment.versions[0].version_id), 'Existing Worker must have one active 100-percent version');
  return { deploymentId: deployment.id, providerVersion: deployment.versions[0].version_id, routeDigest: digest(domains), domains };
}
function subprocessEnvironment(env, outputPath, accountId) {
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:CLOUDFLARE|CF_|WRANGLER_)/i.test(key)));
  return { ...result, CI: 'true', NO_COLOR: '1', CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: join(dirname(outputPath), 'logs'), WRANGLER_OUTPUT_FILE_PATH: outputPath };
}
async function runWrangler(args, { env, outputPath, accountId, timeoutMs, report }) {
  const executable = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
  const childEnv = subprocessEnvironment(env, outputPath, accountId);
  const status = await new Promise((resolveStatus, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const timer = setTimeout(terminate, timeoutMs);
    let killTimer;
    timer.unref();
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.on('spawn', () => { killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000); killTimer.unref(); });
    const diagnostic = bytes => report(bytes.toString().replaceAll(env.CLOUDFLARE_API_TOKEN, '[REDACTED]'));
    child.stdout.on('data', diagnostic); child.stderr.on('data', diagnostic);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolveStatus({ code, signal }); });
  });
  demand(status.code === 0, `Wrangler ${args.slice(0, 2).join(' ')} failed (${status.code ?? status.signal}); inspect the retained release state before retrying`);
  const output = await readFile(outputPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  return output.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function receive(candidate, release, origin, fetchImpl, expectedHeaders) {
  const result = await probeStaticSiteRelease({ manifest: candidate.manifest, origin, includePaths: release.channel.probes.map(item => item.artifactPath), expectedHeaders, maxBytes: candidate.maxBytes, timeoutMilliseconds: 15000, concurrency: 2, fetch: fetchImpl });
  demand(result.valid, `Deployed static assets do not match the release: ${JSON.stringify(result.diagnostics)}`);
  return { kind: 'public-release-observation', version: 1, releaseDigest: release.digest, independent: true, observer: '@red-cup-engineering/static-site-conformance-service', origin: new URL(origin).href, observedAt: new Date().toISOString(), probes: result.probes.map(item => ({ id: item.path, status: item.status, digest: item.digest, ...(item.mediaType ? { contentType: item.mediaType } : {}) })) };
}
function receipt(release, providerVersion, routeDigest, candidateOrigin) {
  return { kind: 'public-release-receipt', version: 1, releaseDigest: release.digest, provider: release.target.provider, receiver: release.target.receiver, artifactManifestDigest: release.artifact.manifestDigest, configDigest: release.target.configDigest, bindingDigest: release.target.bindingDigest, baselineProviderVersion: release.snapshot.providerVersion, baselineRouteDigest: release.snapshot.routeDigest, providerVersion, routeDigest, canonicalOrigin: release.channel.canonicalOrigin, ...(candidateOrigin ? { candidateOrigin } : {}) };
}

/** Upload and receive a version, then promote that exact version on existing domains. */
export async function releaseStaticApplication({ candidate, env = process.env, stateDirectory, fetchImpl = fetch, expectedHeaders = {}, timeoutMs = 300000, report = message => process.stderr.write(message), run = runWrangler } = {}) {
  demand(candidate?.manifest, 'A prepared static application is required');
  demand(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Wrangler timeout must be a positive integer');
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? candidate.config.account_id;
  demand(!candidate.config.account_id || candidate.config.account_id === accountId, 'Configured and injected Cloudflare accounts differ');
  const api = cloudflare(accountId, env.CLOUDFLARE_API_TOKEN, fetchImpl);
  const base = resolve(stateDirectory ?? join(dirname(candidate.configPath), '.wrangler', 'static-release'));
  const stateRelation = relative(candidate.root, base);
  demand(stateRelation.startsWith(`..${sep}`) || stateRelation === '..', 'Release state must be outside the public assets directory');
  const unlock = await lock(join(base, `${candidate.config.name}.lock`));
  const directory = join(base, candidate.manifest.digest.split(';')[1]);
  const statePath = join(directory, 'state.json');
  let state;
  let validatedState = false;
  const subdomainPath = `/workers/scripts/${encodeURIComponent(candidate.config.name)}/subdomain`;
  const readPreviewSettings = async () => {
    const { result } = await api(subdomainPath);
    demand(typeof result?.enabled === 'boolean' && typeof result?.previews_enabled === 'boolean', 'Worker version-preview settings are unavailable');
    return { enabled: result.enabled, previews_enabled: result.previews_enabled };
  };
  const restorePreviewSettings = async () => {
    if (!validatedState || !state.preview || state.preview.stage === 'restored') return;
    const current = await readPreviewSettings();
    const baseline = state.preview.baseline;
    demand(current.enabled === baseline.enabled, 'Worker subdomain changed while version previews were in use');
    if (!same(current, baseline)) {
      demand(current.previews_enabled === true && baseline.previews_enabled === false, 'Worker version-preview settings changed during release');
      state.preview.stage = 'restoring'; await save(statePath, state);
      await api(subdomainPath, 'POST', baseline);
      demand(same(await readPreviewSettings(), baseline), 'Worker version-preview settings were not restored');
    }
    state.preview.stage = 'restored'; await save(statePath, state);
  };
  const enableVersionPreviews = async () => {
    const baseline = await readPreviewSettings();
    if (baseline.previews_enabled) return;
    // Record intent before changing this non-versioned provider setting. A
    // resumed release restores it before attempting another candidate receive.
    state.preview = { baseline, stage: 'enabling' }; await save(statePath, state);
    const enabled = { ...baseline, previews_enabled: true };
    await api(subdomainPath, 'POST', enabled);
    demand(same(await readPreviewSettings(), enabled), 'Worker version previews could not be enabled');
    state.preview.stage = 'enabled'; await save(statePath, state);
  };
  try {
    await mkdir(directory, { recursive: true });
    const stagedRoot = join(directory, 'assets');
    for (const artifact of [...candidate.artifacts, { path: MANIFEST, body: candidate.manifestBody }]) {
      const path = join(stagedRoot, artifact.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, artifact.body);
    }
    const verified = await verifyWebReleaseDirectory({ manifest: candidate.manifest, root: stagedRoot, maxFiles: candidate.maxFiles, maxBytes: candidate.maxBytes });
    demand(verified.valid, `Static release staging failed: ${JSON.stringify(verified.diagnostics)}`);
    demand((await readFile(candidate.configPath)).equals(candidate.configBytes), 'Wrangler configuration changed during preparation');
    state = await jsonFile(statePath, null);
    if (state) {
      demand(state.accountId === accountId && state.release.artifact.manifestDigest === candidate.manifest.digest && state.release.target.configDigest === makeNiUri(candidate.configBytes), 'Saved release state belongs to different inputs');
      validatedState = true;
      await restorePreviewSettings();
    }
    const current = await snapshot(api, candidate);
    if (!state) {
      const publicArtifacts = candidate.manifest.artifacts.filter(item => !CONFIGURATION.has(item.path));
      const release = createPublicRelease({ source: candidate.source, artifact: { manifest: candidate.manifest }, channel: { canonicalOrigin: candidate.canonicalOrigin, stateClass: 'static', probes: publicArtifacts.map(item => ({ id: item.path, method: 'GET', path: new URL(item.url).pathname, expectedStatus: 200, artifactPath: item.path, ...(item.mediaType ? { contentType: item.mediaType } : {}) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) }, target: { provider: 'cloudflare', receiver: `worker:${candidate.config.name}`, configDigest: makeNiUri(candidate.configBytes), bindingDigest: digest({}) }, snapshot: { providerVersion: current.providerVersion, routeDigest: current.routeDigest } });
      state = { release, accountId, baseline: current, stage: 'prepared' }; await save(statePath, state);
    }
    validatedState = true;
    demand(current.routeDigest === state.baseline.routeDigest, 'Worker routes changed since release preparation');
    const release = state.release;
    const command = async (args, name) => run(args, { env, accountId, outputPath: join(directory, `${name}.jsonl`), timeoutMs, report });
    const restorePreviousVersion = async () => {
      const latest = await snapshot(api, candidate);
      demand(latest.routeDigest === state.baseline.routeDigest, 'Worker domains changed while rollback was pending');
      if (latest.providerVersion === state.candidateReceipt?.providerVersion) {
        await command(['versions', 'deploy', `${state.baseline.providerVersion}@100%`, '--name', candidate.config.name, '--config', candidate.configPath, '--yes', '--message', 'Restore previous static application after failed public receiving'], 'rollback');
        const restored = await snapshot(api, candidate);
        demand(restored.providerVersion === state.baseline.providerVersion && restored.routeDigest === state.baseline.routeDigest, 'Rollback did not restore the previous Worker version');
      } else {
        demand(latest.providerVersion === state.baseline.providerVersion, 'Another Worker version became active while rollback was pending');
      }
      state.stage = 'rolled-back'; await save(statePath, state);
    };
    if (state.stage === 'rolling-back') await restorePreviousVersion();
    demand(state.stage !== 'rolled-back', `This candidate was rolled back: ${state.failure ?? 'public receiving failed'}. Build a corrected release`);
    if (!state.candidateObservation) await enableVersionPreviews();
    if (!state.candidateReceipt) {
      demand(current.providerVersion === state.baseline.providerVersion, 'Active Worker changed before candidate upload');
      let output;
      if (state.stage === 'uploading') {
        // Wrangler writes a structured completion record before exiting. Receive
        // that existing version after interruption instead of uploading twice.
        const recorded = await readFile(join(directory, 'upload.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        output = recorded.split('\n').filter(Boolean).map(line => JSON.parse(line));
        const completed = output.filter(item => item.type === 'version-upload' && item.version === 1);
        demand(completed.length === 1 && VERSION.test(completed[0].version_id), `The previous upload outcome is unresolved; inspect ${join(directory, 'upload.jsonl')} before retrying`);
        const existing = await api(`/workers/scripts/${encodeURIComponent(candidate.config.name)}/versions/${completed[0].version_id}`);
        demand(existing.result?.id === completed[0].version_id, 'The interrupted upload version is unavailable');
      } else {
        state.stage = 'uploading'; await save(statePath, state);
        output = await command(['versions', 'upload', '--config', candidate.configPath, '--name', candidate.config.name, '--assets', stagedRoot, '--message', `561 static ${candidate.manifest.digest}`], 'upload');
      }
      const uploaded = output.filter(item => item.type === 'version-upload' && item.version === 1);
      demand(uploaded.length === 1 && VERSION.test(uploaded[0].version_id), 'Wrangler did not return one uploaded version');
      const url = new URL(uploaded[0].preview_url);
      demand(url.protocol === 'https:' && url.hostname.endsWith('.workers.dev') && !url.username && !url.password, 'Uploaded version has no Workers version URL');
      state.candidateReceipt = receipt(release, uploaded[0].version_id, current.routeDigest, new URL('/', url).href);
      state.stage = 'uploaded'; await save(statePath, state);
    }
    const versionId = state.candidateReceipt.providerVersion;
    if (!state.candidateObservation) {
      state.candidateObservation = await receive(candidate, release, state.candidateReceipt.candidateOrigin, fetchImpl, expectedHeaders);
      state.stage = 'received-candidate'; await save(statePath, state);
    }
    await restorePreviewSettings();
    const decision = decidePublicRelease({ release, candidateReceipt: state.candidateReceipt, candidateObservation: state.candidateObservation });
    demand(decision.disposition === 'cutover', `Release cannot promote: ${decision.requirements.join('; ')}`);
    const before = await snapshot(api, candidate);
    demand(before.routeDigest === state.baseline.routeDigest, 'Worker domains changed before promotion');
    demand(before.providerVersion === state.baseline.providerVersion || before.providerVersion === versionId, 'Another Worker version became active before promotion');
    if (before.providerVersion !== versionId) {
      demand(state.stage !== 'rolled-back', 'This candidate was rolled back; build a corrected release');
      state.stage = 'promoting'; await save(statePath, state);
      try {
        await command(['versions', 'deploy', `${versionId}@100%`, '--name', candidate.config.name, '--config', candidate.configPath, '--yes', '--message', `561 static ${candidate.manifest.digest}`], 'promote');
      } catch (error) {
        // A provider activation may succeed before Wrangler fails to print its
        // result. Receive that exact active version in this invocation.
        const reconciled = await snapshot(api, candidate);
        demand(reconciled.routeDigest === state.baseline.routeDigest, 'Worker domains changed during promotion');
        demand(reconciled.providerVersion === versionId || reconciled.providerVersion === state.baseline.providerVersion, 'Another Worker version became active during promotion');
        if (reconciled.providerVersion !== versionId) throw error;
      }
    }
    const active = await snapshot(api, candidate);
    demand(active.providerVersion === versionId && active.routeDigest === state.baseline.routeDigest, 'Cloudflare did not activate the selected version on the existing domains');
    state.activeReceipt = receipt(release, versionId, active.routeDigest); state.stage = 'active'; await save(statePath, state);
    try {
      state.receiverObservation = await receive(candidate, release, candidate.canonicalOrigin, fetchImpl, expectedHeaders);
      const accepted = decidePublicRelease({ release, activeReceipt: state.activeReceipt, receiverObservation: state.receiverObservation });
      demand(accepted.disposition === 'no-op', `Public release receiving failed: ${accepted.requirements.join('; ')}`);
    } catch (error) {
      // Record the failed candidate before rollback can change traffic. A
      // resumed invocation must finish this restoration, never promote again.
      state.stage = 'rolling-back'; state.failure = error.message; await save(statePath, state);
      await restorePreviousVersion();
      throw error;
    }
    state.stage = 'released'; await save(statePath, state);
    return { worker: candidate.config.name, origin: candidate.canonicalOrigin, providerVersion: versionId, files: candidate.manifest.artifactCount, bytes: candidate.manifest.byteCount, stage: state.stage, statePath };
  } finally {
    try { await restorePreviewSettings(); }
    finally { await unlock(); }
  }
}

/** Existing injected tokens and the existing scoped manager lifecycle share one release path. */
export async function deployStaticApplication(options = {}) {
  const candidate = await prepareStaticApplication(options);
  if (options.check) return { worker: candidate.config.name, origin: candidate.canonicalOrigin, files: candidate.manifest.artifactCount, bytes: candidate.manifest.byteCount, stage: 'prepared', manifest: candidate.manifest };
  const env = options.env ?? process.env;
  if (env.CLOUDFLARE_API_TOKEN) return releaseStaticApplication({ ...options, candidate, env });
  demand(options.envFile, 'Supply the existing scoped token environment or --env-file for the Cloudflare manager');
  const manager = parseEnv(await readFile(options.envFile, 'utf8'));
  let result;
  await withCloudflareToken({ accountId: env.CLOUDFLARE_ACCOUNT_ID ?? manager.CLOUDFLARE_ACCOUNT_ID, managerToken: env.CLOUDFLARE_ACCOUNT_TOKEN_MANAGER ?? manager.CLOUDFLARE_ACCOUNT_TOKEN_MANAGER, accountPermissions: ['Workers Scripts Write'], command: process.execPath, args: [fileURLToPath(import.meta.url)], env, fetchImpl: options.fetchImpl, run: async (_command, _args, scopedEnv) => { result = await releaseStaticApplication({ ...options, candidate, env: scopedEnv }); return 0; } });
  return result;
}

if (import.meta.main) {
  try {
    const options = {};
    const argv = process.argv.slice(2);
    if (argv.includes('--help')) {
      console.log('Usage: deploy-cloudflare-static-application --config wrangler.jsonc --source source.json [--origin https://example.com/] [--env-file /existing/manager.env] [--state-directory DIR] [--check]');
    } else {
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--check') options.check = true;
        else {
          const key = { '--config': 'configPath', '--source': 'sourcePath', '--origin': 'canonicalOrigin', '--env-file': 'envFile', '--state-directory': 'stateDirectory' }[argv[i]];
          demand(key && argv[i + 1], `Unknown or incomplete option: ${argv[i]}`); options[key] = argv[++i];
        }
      }
      demand(options.sourcePath && options.configPath, '--source and --config are required');
      options.source = await jsonFile(resolve(options.sourcePath));
      console.log(JSON.stringify(await deployStaticApplication(options), null, 2));
    }
  } catch (error) { console.error(`Cloudflare static release failed: ${error.message}`); process.exitCode = 1; }
}
