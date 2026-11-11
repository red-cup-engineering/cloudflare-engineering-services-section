import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  parseArguments, qualifyRunningService, qualifyRunningFleet,
} from '../src/verify-running-cloudflared.mjs';

const bcf = { scope: 'user', unit: 'bare-cedar-fog-cloudflared.service',
  binary: '/home/emsenn/.local/bin/cloudflared' };
const other = { scope: 'system', unit: 'union-semiotic-exchange-workers-vpc-tunnel.service',
  binary: '/usr/bin/cloudflared' };
const minimumVersion = '2026.10.2';
function fake(overrides = {}) {
  let serviceReads = 0, processReads = 0, installedReads = 0;
  const basic = {
    service: () => ({ load: 'loaded', state: 'active', pid: 1032 }),
    process: () => ({ target: '/home/emsenn/.local/bin/cloudflared', dev: 12, ino: 42, startTicks: '5001' }),
    installed: () => ({ dev: 12, ino: 42 }),
    version: () => 'cloudflared version 2026.10.2 (built 2026-10-20)\n',
  };
  return {
    service(...args) { serviceReads++; return (overrides.service ?? basic.service)(serviceReads, ...args); },
    process(...args) { processReads++; return (overrides.process ?? basic.process)(processReads, ...args); },
    installed(...args) { installedReads++; return (overrides.installed ?? basic.installed)(installedReads, ...args); },
    version(...args) { return (overrides.version ?? basic.version)(...args); },
  };
}
const verify = (overrides, service=bcf) => qualifyRunningService(service, minimumVersion, fake(overrides));
test('accepts running same-image patched version with stable process identity', () => {
  const reading = verify();
  assert.equal(reading.status, 'qualified');
  assert.equal(reading.runningVersion, '2026.10.2');
  assert.equal(reading.pid, 1032);
});
test('rejects dated vulnerable running binary (even when on-disk path is present)', () => {
  const reading = verify({ version: () => 'cloudflared version 2026.7.2' });
  assert.equal(reading.reason, 'running-version-below-minimum');
});
test('rejects one-patch-behind running binary', () => {
  assert.equal(verify({ version: () => 'cloudflared version 2026.10.1' }).status, 'refused');
});
test('accepts later month or patched maintenance release', () => {
  for (const version of ['2026.10.3', '2026.11.0', '2027.1.0']) {
    assert.equal(verify({ version: () => `cloudflared version ${version}` }).status, 'qualified');
  }
});
test('rejects running inode differing from newly upgraded on-disk binary', () => {
  assert.equal(verify({ installed: () => ({ dev: 12, ino: 97 }) }).reason,
    'running-image-differs-from-installed');
});
test('rejects deleted executables even if version would otherwise qualify', () => {
  assert.equal(verify({ process: () => ({ target: '/usr/bin/cloudflared (deleted)', dev: 12, ino: 42, startTicks: '5001' }) }).reason,
    'running-image-deleted');
});
test('rejects stopped, missing, and main-PID-less service', () => {
  for (const value of [
    { load: 'not-found', state: 'inactive', pid: 0 },
    { load: 'loaded', state: 'failed', pid: 0 },
    { load: 'loaded', state: 'active', pid: 0 },
  ]) assert.equal(verify({ service: () => value }).status, 'refused');
});
test('rejects systemd PID switch between reads', () => {
  const reading = verify({ service: i => ({ load: 'loaded', state: 'active', pid: i === 1 ? 1032 : 2033 }) });
  assert.equal(reading.reason, 'process-identity-changed');
});
test('rejects PID recycling even when the number and inode match', () => {
  const reading = verify({ process: i => ({ target: '/usr/bin/cloudflared', dev: 12, ino: 42, startTicks: i === 1 ? '5001' : '6002' }) });
  assert.equal(reading.reason, 'process-identity-changed');
});
test('rejects replaced binary between initial and final observation', () => {
  const reading = verify({ installed: i => ({ dev: 12, ino: i === 1 ? 42 : 99 }) });
  assert.equal(reading.reason, 'installed-image-changed');
});
test('rejects service becoming inactive during version check', () => {
  const reading = verify({ service: i => ({ load: 'loaded', state: i === 1 ? 'active' : 'inactive', pid: 1032 }) });
  assert.equal(reading.reason, 'process-identity-changed');
});
test('rejects malformed/prerelease/forged running version output', () => {
  for (const output of [
    'cloudflared 2026.10.3', 'cloudflared version 2026.10.3-rc1',
    'evil cloudflared version 2026.11.0', 'cloudflared version 2026.10',
  ]) assert.equal(verify({ version: () => output }).reason, 'running-version-unparseable');
});
test('does not leak secret-bearing subprocess errors into a receipt', () => {
  const x = verify({ version: () => { throw Error('TOKEN-SHOULD-NEVER-LEAK'); } });
  assert.equal(x.reason, 'inspection-unavailable');
  assert.equal(JSON.stringify(x).includes('TOKEN-SHOULD-NEVER-LEAK'), false);
});
test('multi-service receiving refuses if any declared unit is unqualified', () => {
  const inspector = fake({ version: pid => pid === 1032 ? 'cloudflared version 2026.10.3' : 'cloudflared version 2026.7.2',
    service: (i, target) => ({ load: 'loaded', state: 'active', pid: target.scope === 'user' ? 1032 : 9932 }) });
  const receipt = qualifyRunningFleet({ minimumVersion, services: [bcf, other] }, inspector);
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.services.length, 2);
  assert.deepEqual(receipt.services.map(r => r.status), ['qualified', 'refused']);
  assert.equal(receipt.coverage, 'only-explicitly-named-units-on-this-host');
  assert.equal(receipt.excludes.includes('oauth'), true);
});
test('refuses duplicate service, missing minimum, fake binary identity or empty list', () => {
  for (const request of [
    { minimumVersion, services: [] },
    { minimumVersion, services: [bcf, bcf] },
    { minimumVersion: '2026.10.2-rc', services: [bcf] },
    { minimumVersion, services: [{ ...bcf, binary: '/tmp/not-cloudflared' }] },
    { minimumVersion, services: [{ ...bcf, scope: 'other' }] },
  ]) assert.throws(() => qualifyRunningFleet(request, fake()), TypeError);
});
test('CLI parsing rejects missing or duplicate floor, duplicate units and unknown options', () => {
  const service = `--service=user:${bcf.unit}:${bcf.binary}`;
  for (const flags of [
    [service],
    ['--min-version=2026.10.2'],
    [service, service, '--min-version=2026.10.2'],
    [service, '--min-version=2026.10.2', '--min-version=2026.10.3'],
    [service, '--min-version=2026.10.2', '--token=forbidden'],
  ]) assert.throws(() => parseArguments(flags), TypeError);
});
test('CLI parsing accepts explicit user and system service targets', () => {
  assert.deepEqual(parseArguments([
    '--min-version=2026.10.2',
    `--service=user:${bcf.unit}:${bcf.binary}`,
    `--service=system:${other.unit}:${other.binary}`,
  ]).services, [bcf, other]);
});
test('CLI with no inputs exits nonzero without claiming a host reading', () => {
  const cli = resolve(import.meta.dirname, '../src/verify-running-cloudflared.mjs');
  const child = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
});
