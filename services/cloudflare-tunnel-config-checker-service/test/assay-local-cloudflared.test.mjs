import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  systemdMembershipFromCgroup, assayLocalCloudflared, requestFrom,
} from '../src/assay-local-cloudflared.mjs';

const user = {
  pid: 120, status: 'observed', executable: '/home/emsenn/.local/bin/cloudflared',
  startTicks: '4200', device: '2049', inode: '1561',
};
const system = {
  pid: 220, status: 'observed', executable: '/usr/bin/cloudflared',
  startTicks: '5200', device: '2049', inode: '2561',
};
const userCg = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/bare-cedar-fog-cloudflared.service\n';
const systemCg = '0::/system.slice/union-semiotic-exchange-workers-vpc-tunnel.service\n';

function setup({
  candidates = [user], discoveryStatus = 'candidates-observed',
  unreadable = 0, versions = {}, cgroups = {},
  override = {}, 
} = {}) {
  const instances = new Map(candidates.map(c => [c.pid,c]));
  const reader = {
    service: ({scope,unit}) => {
      const instance = [...instances.values()].find(c =>
        (c.pid === 120 && scope === 'user' && unit === 'bare-cedar-fog-cloudflared.service') ||
        (c.pid === 220 && scope === 'system' && unit === 'union-semiotic-exchange-workers-vpc-tunnel.service'));
      return { load: 'loaded', state: 'active', pid: instance?.pid ?? 0 };
    },
    process: pid => {
      const c = instances.get(pid);
      if (!c) throw Error('missing process');
      return {target:c.executable, dev:Number(c.device), ino:Number(c.inode),startTicks:c.startTicks};
    },
    installed: path => {
      const c = [...instances.values()].find(c => c.executable === path);
      if (!c) throw Error('missing binary');
      return {dev:Number(c.device),ino:Number(c.inode)};
    },
    version: pid => `cloudflared version ${versions[pid] ?? '2026.10.3'} (build)\n`,
  };
  const inspector = Object.fromEntries(Object.entries(reader).map(([key,fn]) =>
    [key,override[key] ?? fn]));
  const discovered = () => ({
    kind: 'cloudflared.process-candidates/v1',
    status: discoveryStatus, candidates,
    unreadableProcessCount: unreadable,
    scannedProcessCount: candidates.length + unreadable,
  });
  const cgroupOf = override.cgroupOf ?? (pid => cgroups[pid] ?? (pid === 120 ? userCg : systemCg));
  return assayLocalCloudflared({
    minimumVersion: '2026.10.2', discover: override.discover ?? discovered,
    inspector, cgroupOf, observedAtUtc: () => '2026-10-28T04:20:00Z',
    host: () => 'fixture-host',
  });
}

test('derives unambiguous user-service hint only from a strict unified cgroup', () => {
  assert.deepEqual(systemdMembershipFromCgroup(userCg),
    {scope:'user',unit:'bare-cedar-fog-cloudflared.service'});
});
test('derives system-service hint separately, without guessing scope', () => {
  assert.deepEqual(systemdMembershipFromCgroup(systemCg),
    {scope:'system',unit:'union-semiotic-exchange-workers-vpc-tunnel.service'});
});
test('does not mistake the systemd user manager for an executable tunnel service', () => {
  assert.equal(systemdMembershipFromCgroup('0::/user.slice/user-1000.slice/user@1000.service\n'),null);
});
test('refuses hybrid, v1, scope, or ambiguous multi-unit paths', () => {
  for(const c of [
    '11:memory:/system.slice/cloudflared.service\n',
    '0::/system.slice/cloudflared.service\n1:name=systemd:/other\n',
    '0::/system.slice/first.service/second.service\n',
    '0::/session-2.scope/first.service\n',
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/a.service/b.service\n',
    '0::/system.slice/user.slice/user@1000.service/a.service\n',
    '0::/user.slice/user-1000.slice/user@1000.service/app.slice/a:secret.service\n',
    '0::/system.slice/cloudflared.service\n0::/system.slice/other.service\n',
  ]) assert.equal(systemdMembershipFromCgroup(c),null,c);
});
test('rejects nonstring, oversized, and control-containing cgroups', () => {
  assert.equal(systemdMembershipFromCgroup(null),null);
  assert.equal(systemdMembershipFromCgroup('0::/'+ 'x'.repeat(17000)),null);
  assert.equal(systemdMembershipFromCgroup('0::/system.slice/a\u0000.service'),null);
});
test('qualifies only two explicitly observed systemd main processes and retains exclusions', () => {
  const r=setup({candidates:[user,system]});
  assert.equal(r.kind,'cloudflared.local-process-systemd-assay/v1');
  assert.equal(r.status,'qualified-candidates');
  assert.equal(r.host,'fixture-host');
  assert.deepEqual(r.candidates.map(c=>c.status),['qualified','qualified']);
  assert.deepEqual(r.candidates.map(c=>c.pid),[120,220]);
  assert.equal(r.excludes.includes('oauth'),true);
  assert.equal(JSON.stringify(r).includes('argv'),false);
  assert.equal(JSON.stringify(r).includes('token'),false);
});
test('reports no candidates as partial and never safe fleet status', () => {
  const r=setup({candidates:[],discoveryStatus:'no-candidates'});
  assert.equal(r.status,'partial');assert.equal(r.candidates.length,0);
});
test('partially unreadable proc scan cannot yield qualified fleet-like state', () => {
  const r=setup({discoveryStatus:'partial',unreadable:1});
  assert.equal(r.status,'partial'); assert.equal(r.candidates[0].status,'qualified');
});
test('wrong MainPID refuses candidate even if another process has patched version', () => {
  const r=setup({override:{service:()=>({load:'loaded',state:'active',pid:220})}});
  assert.equal(r.status,'candidate-qualification-refused');
  assert.equal(r.candidates[0].status,'refused');
});
test('on-disk binary replaced without running restart fails closed', () => {
  const r=setup({override:{installed:()=>({dev:2049,ino:9999})}});
  assert.equal(r.status,'candidate-qualification-refused');
  assert.equal(r.candidates[0].reason,'running-image-differs-from-installed');
});
test('running vulnerable cloudflared never qualifies', () => {
  const r=setup({versions:{120:'2026.7.2'}});
  assert.equal(r.status,'candidate-qualification-refused');
  assert.equal(r.candidates[0].reason,'running-version-below-minimum');
});
test('unattributed unit becomes unresolved, not an invented main service', () => {
  const r=setup({cgroups:{120:'0::/user.slice/user-1000.slice/user@1000.service/app.slice/app.scope'}});
  assert.equal(r.status,'partial');assert.equal(r.candidates[0].reason,'systemd-owner-unattributed');
});
test('discovery with deleted executable refuses input without invoking any service', () => {
  const r=setup({candidates:[{...user,status:'unresolved',executable:user.executable+' (deleted)'}]});
  assert.equal(r.status,'partial');assert.equal(r.candidates[0].reason,'candidate-unavailable');
});
test('PID reuse after discovery becomes an unresolved candidate', () => {
  let count=0;
  const r=setup({override:{process:pid=>{
    count++;return {target:user.executable,dev:2049,ino:1561,startTicks:count<2?'4200':'9000'};
  }}});
  assert.equal(r.status,'partial');
  assert.equal(r.candidates[0].reason,'process-changed-during-attribution');
});
test('cgroup reparenting after version check refuses a falsely stable service', () => {
  let count=0;
  const r=setup({override:{cgroupOf:()=>++count ===1?userCg:systemCg}});
  assert.equal(r.status,'partial');
  assert.equal(r.candidates[0].reason,'service-or-process-identity-changed');
});
test('unreadable cgroup never exports underlying secret-shaped error', () => {
  const r=setup({override:{cgroupOf:()=>{throw Error('secret TOKEN-NEVER-LEAK');}}});
  assert.equal(r.status,'partial');
  assert.equal(r.candidates[0].reason,'inspection-unavailable');
  assert.equal(JSON.stringify(r).includes('TOKEN-NEVER-LEAK'),false);
});
test('too many process candidates stays partial and performs no systemctl queries', () => {
  let invoked=false;
  const many=Array.from({length:33},(_,i)=>({...user,pid:1000+i}));
  const r=setup({candidates:many,override:{service:()=>{invoked=true;throw Error('should not run')}}});
  assert.equal(r.status,'partial');assert.equal(r.reason,'candidate-bound-exceeded');
  assert.equal(invoked,false);
});
test('malformed discovery cannot be treated as a negative process inventory',()=>{
  const r=setup({override:{discover:()=>({kind:'invalid',candidates:[],status:'candidates-observed'})}});
  assert.equal(r.status,'partial');assert.equal(r.reason,'discovery-invalid');
});
test('unavailable process reader returns a partial structured receipt',()=>{
  const r=setup({override:{discover:()=>{throw Error('permission denied');}}});
  assert.equal(r.status,'partial');assert.equal(r.reason,'discovery-unavailable');
});
test('rejects omitted, duplicate or malformed minimum version before any host read',()=>{
  for (const x of [[],['--min-version=2026.10.2','--min-version=2026.10.3'],
    ['--version=2026.10.2'],['--min-version=2026.10.2-rc1']]) {
    assert.throws(()=>requestFrom(x),TypeError);
  }
});
test('no-argument CLI exits 2 without a positive host receipt',()=>{
  const cli=resolve(import.meta.dirname,'../src/assay-local-cloudflared.mjs');
  const r=spawnSync(process.execPath,[cli],{encoding:'utf8'});
  assert.equal(r.status,2);assert.equal(r.stdout,'');
});
