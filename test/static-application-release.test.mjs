import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployStaticApplication, prepareStaticApplication, releaseStaticApplication } from '../scripts/deploy-static-application.mjs';

const before = '11111111-1111-4111-8111-111111111111';
const after = '22222222-2222-4222-8222-222222222222';
const domain = { id: 'domain-1', hostname: 'sample.example.com', service: 'sample', zone_id: 'zone-1', enabled: true };
const source = { repository: 'example/sample', revision: 'source-1', build: { command: ['node', 'build.mjs'], outputRoot: 'dist' } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cloudflare-static-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><script type="module" src="/app.mjs"></script>');
  await writeFile(join(root, 'dist', 'app.mjs'), 'document.body.textContent="ready";');
  await writeFile(join(root, 'dist', '_headers'), '/*\n  X-Content-Type-Options: nosniff\n');
  await writeFile(join(root, 'wrangler.jsonc'), '// Static application\n' + JSON.stringify({ name: 'sample', compatibility_date: '2026-09-02', workers_dev: true, assets: { directory: './dist' }, routes: [{ pattern: 'sample.example.com', custom_domain: true }] }));
  const candidate = await prepareStaticApplication({ configPath: join(root, 'wrangler.jsonc'), source });
  return { root, candidate };
}
function provider(candidate, { failCanonical = false, wrongDomain = false, workersDev = true, previewsEnabled = false } = {}) {
  const commands = [];
  const publicReads = [];
  const previewChanges = [];
  let previewSettings = { enabled: workersDev, previews_enabled: previewsEnabled };
  let active = before;
  const success = result => Response.json({ success: true, result });
  const fetchImpl = async (value, options = {}) => {
    const url = new URL(value);
    if (url.hostname === 'api.cloudflare.com') {
      if (url.pathname.endsWith('/domains')) return Response.json({ success: true, result: [{ ...domain, ...(wrongDomain ? { hostname: 'other.example.com' } : {}) }], result_info: { count: 1, total_count: 99 } });
      if (url.pathname.endsWith('/deployments')) return success({ deployments: [{ id: 'deployment-1', versions: [{ version_id: active, percentage: 100 }] }] });
      if (url.pathname.endsWith('/settings')) return success({ bindings: [] });
      if (url.pathname.endsWith('/subdomain')) {
        if (options.method === 'POST') {
          previewSettings = JSON.parse(options.body);
          previewChanges.push({ ...previewSettings });
        }
        return success(previewSettings);
      }
      if (url.pathname.endsWith(`/versions/${after}`)) return success({ id: after });
      throw new Error(`Unexpected Cloudflare operation: ${url.pathname}`);
    }
    publicReads.push({ hostname: url.hostname, active });
    if (url.hostname.endsWith('.workers.dev')) assert.equal(previewSettings.previews_enabled, true, 'Version URL requires provider previews enabled');
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const artifact = candidate.artifacts.find(item => item.path === path);
    assert.ok(artifact, `Unexpected public asset: ${path}`);
    return new Response(failCanonical && url.hostname === 'sample.example.com' ? 'wrong version' : artifact.body, { headers: { 'content-type': artifact.mediaType ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
  };
  const run = async (args, options) => {
    commands.push(args);
    if (args[1] === 'upload') {
      assert.equal(active, before);
      const record = { type: 'version-upload', version: 1, worker_name: 'sample', version_id: after, ...(previewSettings.previews_enabled ? { preview_url: 'https://22222222-sample.example.workers.dev' } : {}) };
      await writeFile(options.outputPath, JSON.stringify(record) + '\n');
      return [record];
    }
    assert.equal(args[1], 'deploy');
    const version = args[2].split('@')[0];
    if (version === after) assert.ok(publicReads.some(item => item.hostname.endsWith('.workers.dev') && item.active === before), 'Candidate must be read before traffic moves');
    assert.ok([before, after].includes(version));
    active = version;
    return [];
  };
  return { publicReceivingAttempts: 1, publicReceivingDelayMs: 0, fetchImpl, run, commands, publicReads, previewChanges, previewSettings: () => previewSettings, active: () => active };
}
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'scoped-fixture-token' };

test('native manifest and local-link receiver prepare the complete static application', async t => {
  const { candidate } = await fixture(t);
  assert.equal(candidate.manifest.artifactCount, 3);
  assert.deepEqual(candidate.manifest.metadata.providerConfigurationFiles, ['_headers']);
  assert.equal(candidate.manifest.baseUrl, 'https://sample.example.com/');
  assert.equal(candidate.config.name, 'sample');
});
test('receive the uploaded version before promotion and reuse a completed release', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate);
  const result = await releaseStaticApplication({ candidate, env, ...runtime, report: () => {} });
  assert.equal(result.stage, 'released');
  assert.equal(runtime.active(), after);
  assert.equal(runtime.commands.length, 2);
  assert.deepEqual(runtime.previewChanges, [{ enabled: true, previews_enabled: true }, { enabled: true, previews_enabled: false }]);
  assert.ok(runtime.commands.every(args => !args.includes('triggers')));
  const second = await releaseStaticApplication({ candidate, env, ...runtime, report: () => {} });
  assert.equal(second.stage, 'released');
  assert.equal(runtime.commands.length, 2, 'A received release is not uploaded or activated twice');
  assert.equal(runtime.previewChanges.length, 2, 'A received release does not need preview URLs again');
});
test('public failure restores the exact prior version and retains the failed candidate', async t => {
  const { root, candidate } = await fixture(t);
  const runtime = provider(candidate, { failCanonical: true });
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {} }), /Deployed static assets do not match/);
  assert.equal(runtime.active(), before);
  assert.equal(runtime.commands.length, 3);
  assert.equal(runtime.commands[2][2], `${before}@100%`);
  const state = JSON.parse(await readFile(join(root, '.wrangler', 'static-release', candidate.manifest.digest.split(';')[1], 'state.json'), 'utf8'));
  assert.equal(state.stage, 'rolled-back');
  assert.equal(state.candidateReceipt.providerVersion, after);
});
test('a different existing custom domain stops before upload', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate, { wrongDomain: true });
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {} }), /custom domains differ/);
  assert.deepEqual(runtime.commands, []);
  assert.equal(runtime.active(), before);
});

// A completed provider effect may be followed by a local process failure.
test('an interrupted rollback never promotes the failed candidate on resume', async t => {
  const { root, candidate } = await fixture(t);
  const runtime = provider(candidate, { failCanonical: true });
  const originalRun = runtime.run;
  runtime.run = async (args, options) => {
    const result = await originalRun(args, options);
    if (args[1] === 'deploy' && args[2] === `${before}@100%`) throw new Error('process ended after provider rollback');
    return result;
  };
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {} }), /ended after provider rollback/);
  assert.equal(runtime.active(), before);
  const statePath = join(root, '.wrangler', 'static-release', candidate.manifest.digest.split(';')[1], 'state.json');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).stage, 'rolling-back');
  const operations = runtime.commands.length;
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {} }), /candidate was rolled back/);
  assert.equal(runtime.active(), before);
  assert.equal(runtime.commands.length, operations);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).stage, 'rolled-back');
});

test('version receiving temporarily enables previews while preserving a disabled workers.dev route', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate, { workersDev: false });
  const result = await releaseStaticApplication({ candidate, env, ...runtime, report: () => {} });
  assert.equal(result.stage, 'released');
  assert.deepEqual(runtime.previewChanges, [{ enabled: false, previews_enabled: true }, { enabled: false, previews_enabled: false }]);
  assert.deepEqual(runtime.previewSettings(), { enabled: false, previews_enabled: false });
});

test('an interrupted preview enable restores the previous provider setting before a retry', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate);
  const originalFetch = runtime.fetchImpl;
  let interrupted = false;
  runtime.fetchImpl = async (url, options) => {
    const response = await originalFetch(url, options);
    if (!interrupted && options?.method === 'POST' && JSON.parse(options.body).previews_enabled === true) {
      interrupted = true;
      throw new Error('connection ended after preview enable');
    }
    return response;
  };
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {} }), /ended after preview enable/);
  assert.deepEqual(runtime.previewSettings(), { enabled: true, previews_enabled: false });
  assert.deepEqual(runtime.commands, []);
  assert.equal((await releaseStaticApplication({ candidate, env, ...runtime, report: () => {} })).stage, 'released');
});

test('a promotion completed before Wrangler errors is received in the same invocation', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate);
  const originalRun = runtime.run;
  runtime.run = async (args, options) => {
    const result = await originalRun(args, options);
    if (args[1] === 'deploy' && args[2] === `${after}@100%`) throw new Error('output ended after provider activation');
    return result;
  };
  assert.equal((await releaseStaticApplication({ candidate, env, ...runtime, report: () => {} })).stage, 'released');
  assert.equal(runtime.active(), after);
  assert.equal(runtime.commands.length, 2);
  assert.ok(runtime.publicReads.some(item => item.hostname === 'sample.example.com' && item.active === after));
});

test('an injected existing manager grants account-scoped script upload permission and revokes it after release', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate);
  const managerCalls = [];
  const fetchImpl = async (url, options) => {
    if (new URL(url).pathname.includes('/tokens')) {
      assert.equal(options.headers.authorization, 'Bearer fixture-manager');
      managerCalls.push({ path: new URL(url).pathname, ...options });
      if (url.endsWith('/permission_groups')) return Response.json({ success: true, result: [{ id: 'script-write', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] }] });
      if (options.method === 'POST') return Response.json({ success: true, result: { id: 'b'.repeat(32), value: env.CLOUDFLARE_API_TOKEN } });
      assert.equal(options.method, 'DELETE');
      return Response.json({ success: true, result: {} });
    }
    if (new URL(url).hostname === 'api.cloudflare.com') assert.equal(options.headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    return runtime.fetchImpl(url, options);
  };
  const result = await deployStaticApplication({ configPath: candidate.configPath, source, env: { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCOUNT_TOKEN_MANAGER: 'fixture-manager' }, fetchImpl, run: runtime.run, report: () => {} });
  assert.equal(result.stage, 'released');
  const grant = JSON.parse(managerCalls.find(item => item.method === 'POST').body);
  assert.deepEqual(grant.policies, [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${env.CLOUDFLARE_ACCOUNT_ID}`]: '*' }, permission_groups: [{ id: 'script-write' }] }]);
  assert.equal(managerCalls.at(-1).method, 'DELETE');
});

test('public release with multiple attempts succeeds after transient propagation errors', async t => {
  const { candidate } = await fixture(t);
  let canonicalReads = 0;
  const runtime = provider(candidate);
  const originalFetch = runtime.fetchImpl;
  runtime.fetchImpl = async (url, options) => {
    const response = await originalFetch(url, options);
    const reqUrl = new URL(url);
    if (reqUrl.hostname === 'sample.example.com') {
      canonicalReads++;
      if (canonicalReads <= 2) {
        return new Response('wrong version', { headers: { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' } });
      }
    }
    return response;
  };
  const result = await releaseStaticApplication({ candidate, env, ...runtime, report: () => {}, publicReceivingAttempts: 3, publicReceivingDelayMs: 0 });
  assert.equal(result.stage, 'released');
  assert.equal(runtime.active(), after);
  assert.equal(runtime.commands.length, 2);
  assert.equal(canonicalReads, 2 * candidate.artifacts.filter(item => !['_headers', '_redirects'].includes(item.path)).length);
});

test('persistent wrong canonical with attempts 2 rejects and rolls back exact baseline', async t => {
  const { root, candidate } = await fixture(t);
  const runtime = provider(candidate, { failCanonical: true });
  let publicReadCount = 0;
  const originalFetch = runtime.fetchImpl;
  runtime.fetchImpl = async (url, options) => {
    const res = await originalFetch(url, options);
    if (new URL(url).hostname === 'sample.example.com') publicReadCount++;
    return res;
  };
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {}, publicReceivingAttempts: 2, publicReceivingDelayMs: 0 }), /Deployed static assets do not match/);
  assert.equal(runtime.active(), before);
  assert.equal(publicReadCount, 2 * candidate.artifacts.filter(item => !['_headers', '_redirects'].includes(item.path)).length);
});

test('concurrent foreign version change observed by api snapshot between attempts refuses immediately', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate, { failCanonical: true });
  let sawCanonical = false;
  const originalFetch = runtime.fetchImpl;
  runtime.fetchImpl = async (url, options) => {
    const reqUrl = new URL(url);
    if (reqUrl.hostname === 'sample.example.com') sawCanonical = true;
    if (reqUrl.pathname.endsWith('/deployments')) {
      if (sawCanonical) {
        return Response.json({ success: true, result: { deployments: [{ id: 'deployment-foreign', versions: [{ version_id: '33333333-3333-4333-8333-333333333333', percentage: 100 }] }] } });
      }
    }
    return originalFetch(url, options);
  };
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, report: () => {}, publicReceivingAttempts: 3, publicReceivingDelayMs: 0 }), /Another Worker version became active while rollback was pending/);
  assert.equal(runtime.commands.length, 2, 'No rollback overwrites a foreign deployment');
});

test('options invalid refuse before writes', async t => {
  const { candidate } = await fixture(t);
  const runtime = provider(candidate);
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, publicReceivingAttempts: 0 }), /Public receiving attempts must be between 1 and 12/);
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, publicReceivingAttempts: 13 }), /Public receiving attempts must be between 1 and 12/);
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, publicReceivingDelayMs: -1 }), /Public receiving delay must be between 0 and 5000 ms/);
  await assert.rejects(releaseStaticApplication({ candidate, env, ...runtime, publicReceivingDelayMs: 5001 }), /Public receiving delay must be between 0 and 5000 ms/);
  assert.deepEqual(runtime.commands, []);
});
