import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerVersionClient, workerContentModules } from '../scripts/worker-versions.mjs';

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
