import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { observeCloudflaredProcessCandidates } from '../src/observe-cloudflared-process-candidates.mjs';

function harness(data, overrides={}) {
  return {
    pids: () => overrides.pids?.() ?? [...data.keys()],
    comm: pid => {
      if (overrides.comm) return overrides.comm(pid);
      const value = data.get(pid);
      if (!value || value.readable === false) throw Error('secret SHOULD NOT leak');
      return value.comm;
    },
    image: pid => {
      if (overrides.image) return overrides.image(pid);
      const value = data.get(pid);
      if (!value || value.imageError) throw Error('process not readable');
      return {
        executable: value.path ?? '/usr/bin/cloudflared',
        startTicks: value.startTicks ?? '123456',
        device: value.device ?? '254',
        inode: value.inode ?? '45678',
      };
    },
  };
}
test('observes both local tunnel paths without reading cmdline or tokens', () => {
  const entries = new Map([
    [11, {comm:'cloudflared',path:'/home/emsenn/.local/bin/cloudflared'}],
    [22, {comm:'cloudflared',path:'/usr/bin/cloudflared',startTicks:'42'}],
    [33, {comm:'node'}],
  ]);
  const r = observeCloudflaredProcessCandidates(harness(entries));
  assert.equal(r.kind, 'cloudflared.process-candidates/v1');
  assert.equal(r.status, 'candidates-observed');
  assert.equal(r.scannedProcessCount, 3);
  assert.equal(r.observedCandidateCount, 2);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map(x => x.executable),
    ['/home/emsenn/.local/bin/cloudflared', '/usr/bin/cloudflared']);
  assert.equal(JSON.stringify(r).includes('token'), false);
  assert.equal(JSON.stringify(r).includes('oauth'), false);
});
test('zero candidates is not proof that active connectors are absent', () => {
  const r = observeCloudflaredProcessCandidates(harness(new Map([[9,{comm:'node'}]])));
  assert.equal(r.status,'no-candidates');
  assert.equal(r.observedCandidateCount,0);
  assert.match(r.coverage,/renamed-or-hidden/);
});
test('unreadable unrelated PID makes completion unknowable', () => {
  const r = observeCloudflaredProcessCandidates(harness(new Map([
    [1,{comm:'node',readable:false}], [2,{comm:'cloudflared'}],
  ])));
  assert.equal(r.status,'partial');
  assert.equal(r.unreadableProcessCount,1);
  assert.equal(r.observedCandidateCount,1);
});
test('PID vanished during image inspection is explicitly unresolved', () => {
  const r = observeCloudflaredProcessCandidates(harness(new Map([
    [17,{comm:'cloudflared',imageError:true}],
  ])));
  assert.equal(r.status,'partial');
  assert.deepEqual(r.candidates,[{pid:17,status:'unresolved',reason:'image-unavailable-or-changing'}]);
});
test('deleted executable remains an unresolved candidate', () => {
  const r = observeCloudflaredProcessCandidates(harness(new Map([
    [21,{comm:'cloudflared',path:'/usr/bin/cloudflared (deleted)'}],
  ])));
  assert.equal(r.status,'partial');
  assert.equal(r.candidates[0].reason,'deleted-image');
});
test('unexpected binary metadata must not become a readable verified candidate', () => {
  const r = observeCloudflaredProcessCandidates(harness(new Map([
    [12,{comm:'cloudflared',device:'not-a-number'}],
  ])));
  assert.equal(r.status,'partial');
  assert.equal(r.candidates[0].status,'unresolved');
});
test('refuses oversized scan or duplicate and forged PID input', () => {
  const original = harness(new Map());
  for (const pids of [[1,1],[0,1],[-9],[1.2],[NaN]]) {
    assert.throws(() => observeCloudflaredProcessCandidates({...original,pids:()=>pids}));
  }
  assert.throws(() => observeCloudflaredProcessCandidates({...original,pids:()=>[1,2,3]}, {maxProcesses:2}));
});
test('rejects invalid process scan bounds before reading proc', () => {
  const original=harness(new Map());
  for (const maxProcesses of [0,2.2,65537,-1,NaN])
    assert.throws(() => observeCloudflaredProcessCandidates(original,{maxProcesses}),TypeError);
});
test('inspection cannot leak errors that may contain credential material', () => {
  const r = observeCloudflaredProcessCandidates(harness(new Map([
    [19,{comm:'cloudflared'}]
  ]),{image:()=>{throw Error('raw token SENSITIVE_BYTES')}}));
  assert.equal(JSON.stringify(r).includes('SENSITIVE_BYTES'),false);
  assert.equal(r.status,'partial');
});
test('CLI refuses unrecognized options without scanning host or printing secrets', () => {
  const path=resolve(import.meta.dirname,'../src/observe-cloudflared-process-candidates.mjs');
  const out=spawnSync(process.execPath,[path,'--token-forbidden'],{encoding:'utf8'});
  assert.equal(out.status,2);
  assert.equal(out.stdout,'');
});
