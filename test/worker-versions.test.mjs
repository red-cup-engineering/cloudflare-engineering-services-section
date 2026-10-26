import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerVersionClient, workerContentModules, workerVersionPreviewOrigin } from '../scripts/worker-versions.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const accountId = '337e54ee6dc7d488933f473204a6d89e';
const json = result => Response.json({ success: true, result });
const client = fetch => createWorkerVersionClient({ accountId, scriptName: 'market-561-group', token: 'fixture-only-token', fetch });

test('version upload is the documented strict, zero-traffic endpoint and contains exact module bytes', async () => {
  const calls = [], bytes = new TextEncoder().encode('export default {fetch(){return new Response("fixture")}}');
  const provider = client(async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer fixture-only-token');
    assert.equal(init.method, 'POST');
    assert.ok(url.endsWith('/versions?bindings_inherit=strict'));
    assert.deepEqual(JSON.parse(init.body.get('metadata')), { main_module: 'worker.mjs', bindings: [{ name: 'SECRET', type: 'inherit' }] });
    assert.deepEqual(new Uint8Array(await init.body.get('worker.mjs').arrayBuffer()), bytes);
    return json({ id });
  });
  assert.equal((await provider.uploadVersion({ metadata: { main_module: 'worker.mjs', bindings: [{ name: 'SECRET', type: 'inherit' }] }, moduleBytes: bytes })).id, id);
  assert.equal(calls.length, 1);
  assert.ok(!calls.some(call => call.url.endsWith('/deployments')));
});

test('an explicit inherit UUID is refused because this endpoint only inherits latest', async () => {
  let calls = 0;
  await assert.rejects(client(async () => { calls++; }).uploadVersion({ metadata: { main_module: 'worker.mjs', bindings: [{ name: 'SECRET', type: 'inherit', version_id: id }] }, moduleBytes: new Uint8Array([1]) }), /INVALID_VERSION_UPLOAD/u);
  assert.equal(calls, 0);
});

test('provider failure retains numerical codes but never the body/token and never retries writes', async () => {
  let calls = 0;
  try {
    await client(async () => { calls++; return Response.json({ success: false, errors: [{ code: 10057, message: 'fixture-only-token hidden detail' }] }, { status: 400 }); })
      .deployVersion({ versionId: id, message: 'fixture deployment' });
    assert.fail('Expected refusal');
  } catch (error) {
    assert.equal(error.code, 'PROVIDER_OPERATION_REFUSED');
    assert.deepEqual(error.providerCodes, [10057]);
    assert.ok(!JSON.stringify(error).includes('fixture-only-token'));
    assert.ok(!String(error).includes('hidden detail'));
  }
  assert.equal(calls, 1);
});

test('gradual or ambiguous active deployments fail before any write', async () => {
  const provider = client(async () => json({ deployments: [{ id, versions: [{ version_id: id, percentage: 50 }] }] }));
  await assert.rejects(provider.activeDeployment(), /SINGLE_ACTIVE_VERSION_REQUIRED/u);
});

test('an immutable version read must return the independently selected UUID', async () => {
  const provider = client(async () => json({ id: '22222222-2222-4222-8222-222222222222', resources: {} }));
  await assert.rejects(provider.version(id), /PROVIDER_VERSION_IDENTITY_CHANGED/u);
});

test('content module receiving compares bytes despite a changed multipart field name', async () => {
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: 'renamed.js' }));
  form.set('provider-relabelled-field', new Blob(['exact module'], { type: 'application/javascript+module' }), 'renamed.js');
  const response = new Response(form);
  const modules = await workerContentModules({ bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') });
  assert.equal(modules.length, 1);
  assert.equal(new TextDecoder().decode(modules[0]), 'exact module');
});

test('a forged oversized Content-Length is refused and its stream is cancelled', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(64 * 1024 * 1024) } });
  await assert.rejects(client(async () => response).content(), /PROVIDER_BODY_LIMIT/u);
  assert.equal(cancelled, true);
});

test('script availability and existing account hostname use their separate documented GET routes', async () => {
  const calls = [], availability = { enabled: false, previews_enabled: true };
  const provider = client(async (url, init) => {
    calls.push(url);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    if (url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/market-561-group/subdomain`) return json(availability);
    if (url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`) return json({ subdomain: 'original-account' });
    assert.fail('Unselected provider route');
  });
  assert.deepEqual(await provider.subdomain(), availability);
  const account = await provider.accountSubdomain();
  assert.deepEqual(account, { subdomain: 'original-account' });
  assert.equal(workerVersionPreviewOrigin({ versionId: id, scriptName: 'market-561-group', accountSubdomain: account.subdomain }),
    'https://11111111-market-561-group.original-account.workers.dev');
  assert.equal(calls.length, 2);
});

test('a fabricated preview suffix never replaces the original account hostname resource', async () => {
  let calls = 0;
  const provider = client(async () => { calls++; return json({ previews_enabled: true, preview_url_suffix: '-market-561-group.fabricated.workers.dev' }); });
  await assert.rejects(provider.accountSubdomain(), { code: 'WORKER_ACCOUNT_SUBDOMAIN_UNRECEIVED' });
  assert.equal(calls, 1);
});

test('version origin derivation refuses missing, ambiguous or escaping hostname resources', () => {
  for (const accountSubdomain of [undefined, 123, {}, [], '', 'not.a.label', 'account/other', 'account@host', '-account', 'account-', 'a'.repeat(64)]) {
    assert.throws(() => workerVersionPreviewOrigin({ versionId: id, scriptName: 'market-561-group', accountSubdomain }),
      { code: 'WORKER_ACCOUNT_SUBDOMAIN_UNRECEIVED' });
  }
  for (const scriptName of ['market/other', 'market.other', 'market@host', 'a'.repeat(55)]) {
    assert.throws(() => workerVersionPreviewOrigin({ versionId: id, scriptName, accountSubdomain: 'original-account' }),
      { code: 'WORKER_VERSION_PREVIEW_ADDRESS_UNRECEIVED' });
  }
  assert.throws(() => workerVersionPreviewOrigin({ versionId: '../other', scriptName: 'market', accountSubdomain: 'original-account' }),
    { code: 'INVALID_WORKER_VERSION' });
});

test('the documented deployment, version-list, immutable-version and script-settings envelopes are consumed at their original routes', async () => {
  const later = '22222222-2222-4222-8222-222222222222';
  const deployment = { id, source: 'api', strategy: 'percentage', versions: [{ version_id: later, percentage: 100 }] };
  const resources = { bindings: [{ name: 'SOURCE', type: 'plain_text', text: 'fixture' }],
    script: { etag: 'fixture-content-etag', handlers: ['fetch'] },
    script_runtime: { compatibility_date: '2026-08-31', compatibility_flags: ['nodejs_compat'], exports: { default: { type: 'worker', state: 'created' } } } };
  const settings = { logpush: false, observability: { enabled: true } }, calls = [];
  const provider = client(async (url, init) => {
    assert.equal(init.method, 'GET'); calls.push(url);
    if (url.endsWith('/deployments')) return json({ deployments: [deployment] });
    if (url.endsWith('/versions')) return json({ items: [{ id, number: 10 }, { id: later, number: 11 }] });
    if (url.endsWith(`/versions/${later}`)) return json({ id: later, number: 11, resources });
    if (url.endsWith('/script-settings')) return json(settings);
    assert.fail('Unselected provider route');
  });
  assert.deepEqual(await provider.activeDeployment(), deployment);
  assert.equal((await provider.latestVersion()).id, later);
  assert.deepEqual((await provider.version(later)).resources, resources);
  assert.deepEqual(await provider.scriptSettings(), settings);
  assert.equal(calls.length, 4);
});

test('exact-version module receiving selects the existing Worker name and UUID without a latest-content guess', async () => {
  const bytes = Buffer.from('export default {fetch(){return new Response("received")}}'), calls = [];
  const provider = client(async (url, init) => {
    calls.push(url); assert.equal(init.method, 'GET');
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/workers/market-561-group/versions/${id}?include=modules`);
    return json({ id, number: 42, main_module: 'worker.mjs', modules: [
      { name: 'worker.mjs', content_type: 'application/javascript+module', content_base64: bytes.toString('base64') },
    ] });
  });
  const modules = await provider.versionModules(id);
  assert.equal(modules.length, 1); assert.deepEqual(Buffer.from(modules[0]), bytes); assert.equal(calls.length, 1);
});

test('exact-version module receiving refuses another UUID, omitted modules and ambiguous module identities', async () => {
  const module = { name: 'worker.mjs', content_type: 'application/javascript+module', content_base64: 'YQ==' };
  for (const [result, code] of [
    [{ id: '22222222-2222-4222-8222-222222222222', modules: [module] }, 'PROVIDER_VERSION_IDENTITY_CHANGED'],
    [{ id }, 'VERSION_MODULES_UNRECEIVED'], [{ id, modules: [] }, 'VERSION_MODULES_UNRECEIVED'],
    [{ id, modules: [module, module] }, 'VERSION_MODULES_UNRECEIVED'],
    [{ id, modules: [{ ...module, content_type: undefined }] }, 'VERSION_MODULES_UNRECEIVED'],
  ]) await assert.rejects(client(async () => json(result)).versionModules(id), { code });
});

test('module base64 must decode canonically and stays within the aggregate original byte bound', async () => {
  for (const content_base64 of ['YQ', 'YQ===', 'Y Q==', 'Y!==', 'YQ==\n', 'YR==']) {
    const provider = client(async () => json({ id, modules: [{ name: 'worker.mjs', content_type: 'application/javascript+module', content_base64 }] }));
    await assert.rejects(provider.versionModules(id), { code: 'VERSION_MODULE_BASE64_UNRECEIVED' });
  }
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'content-length': String(Math.ceil(32 * 1024 * 1024 / 3) * 4 + 4 * 1024 * 1024 + 1) } });
  await assert.rejects(client(async () => response).versionModules(id), { code: 'PROVIDER_BODY_LIMIT' });
  assert.equal(cancelled, true);
});
