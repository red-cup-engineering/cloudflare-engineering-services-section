#!/usr/bin/env node
// Runtime receiving for explicitly named Linux systemd cloudflared services.
// No shell, credential access, restart, installer, or full-host coverage claim.
import { spawnSync } from 'node:child_process';
import { readFileSync, readlinkSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = /^\d{4}\.\d{1,2}\.\d+$/;
const SERVICE_NAME = /^[A-Za-z0-9_.@-]+\.service$/;
const VERSION_OUTPUT = /^cloudflared version (\d{4}\.\d{1,2}\.\d+)(?=\s|$)/;
const parts = value => RELEASE.test(value ?? '') ? value.split('.').map(Number) : null;
const atLeast = (observed, minimum) => {
  const a = parts(observed), b = parts(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

function checkedCommand(binary, args) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
  });
  if (result.error || result.status !== 0) throw Error('command-unavailable');
  return result.stdout;
}

function inspectService({ scope, unit }) {
  const output = checkedCommand('systemctl', [
    scope === 'user' ? '--user' : '--system', '--no-pager', '--no-ask-password',
    'show', '--property=LoadState', '--property=ActiveState',
    '--property=MainPID', unit,
  ]);
  const properties = Object.create(null);
  for (const line of output.trim().split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) throw Error('invalid-service-reading');
    const key = line.slice(0, at);
    if (!(key === 'LoadState' || key === 'ActiveState' || key === 'MainPID') ||
        Object.hasOwn(properties, key)) throw Error('invalid-service-reading');
    properties[key] = line.slice(at + 1);
  }
  if (!('LoadState' in properties) || !('ActiveState' in properties) ||
      !/^[0-9]+$/.test(properties.MainPID ?? '')) throw Error('invalid-service-reading');
  const pid = Number(properties.MainPID);
  if (!Number.isSafeInteger(pid)) throw Error('invalid-service-reading');
  return { load: properties.LoadState, state: properties.ActiveState, pid };
}

function inspectProcess(pid) {
  const proc = `/proc/${pid}`;
  const target = readlinkSync(`${proc}/exe`);
  const stat = statSync(`${proc}/exe`);
  // Linux /proc/<pid>/stat: (comm) may contain spaces/parentheses.
  const record = readFileSync(`${proc}/stat`, 'utf8');
  const close = record.lastIndexOf(')');
  const columns = close >= 0 ? record.slice(close + 1).trim().split(/\s+/) : [];
  const startTicks = columns[19]; // field 22 (field 3 is columns[0])
  if (!/^\d+$/.test(startTicks ?? '')) throw Error('invalid-process-reading');
  return { target, dev: stat.dev, ino: stat.ino, startTicks };
}

export const liveInspector = Object.freeze({
  service: inspectService,
  process: inspectProcess,
  installed: path => { const s = statSync(path); return { dev: s.dev, ino: s.ino }; },
  version: pid => checkedCommand(`/proc/${pid}/exe`, ['--version']),
});

export function validateRequest(request) {
  if (!request || !parts(request.minimumVersion) || !Array.isArray(request.services) ||
      request.services.length < 1 || request.services.length > 32) {
    throw TypeError('minimum version and 1-32 named services are required');
  }
  const seen = new Set();
  for (const service of request.services) {
    if (!service || !['user', 'system'].includes(service.scope) ||
        !SERVICE_NAME.test(service.unit ?? '') ||
        !isAbsolute(service.binary ?? '') || basename(service.binary) !== 'cloudflared' ||
        /[\x00-\x1f]/.test(service.binary)) throw TypeError('invalid service identity');
    const key = `${service.scope}:${service.unit}`;
    if (seen.has(key)) throw TypeError('duplicate systemd unit');
    seen.add(key);
  }
}

const sameProcess = (a, b) => a.target === b.target && a.dev === b.dev &&
  a.ino === b.ino && a.startTicks === b.startTicks;
const sameImage = (a, b) => a.dev === b.dev && a.ino === b.ino;

export function qualifyRunningService(service, minimumVersion, inspector = liveInspector) {
  const base = { scope: service.scope, unit: service.unit, expectedBinary: service.binary };
  const refused = reason => ({ ...base, status: 'refused', reason });
  try {
    const first = inspector.service(service);
    if (first.load !== 'loaded') return refused('service-not-loaded');
    if (first.state !== 'active') return refused('service-not-active');
    if (!Number.isSafeInteger(first.pid) || first.pid <= 0) return refused('no-running-main-pid');

    const before = inspector.process(first.pid);
    if (before.target.endsWith(' (deleted)')) return refused('running-image-deleted');
    const installed = inspector.installed(service.binary);
    if (!sameImage(before, installed)) return refused('running-image-differs-from-installed');

    // Version is taken from the current PID's executable, not an unrelated PATH binary.
    const output = inspector.version(first.pid);
    const match = VERSION_OUTPUT.exec(output.trim());
    if (!match || !parts(match[1])) return refused('running-version-unparseable');
    const version = match[1];
    if (!atLeast(version, minimumVersion)) return refused('running-version-below-minimum');

    // Re-observe after execution: a restart, binary replacement or recycled PID refuses.
    const after = inspector.process(first.pid);
    const final = inspector.service(service);
    if (final.load !== 'loaded' || final.state !== 'active' || final.pid !== first.pid ||
        !sameProcess(before, after)) return refused('process-identity-changed');
    if (!sameImage(after, inspector.installed(service.binary))) {
      return refused('installed-image-changed');
    }
    return { ...base, status: 'qualified', pid: first.pid, runningVersion: version };
  } catch {
    // Never include raw systemctl outputs, executable stderr, argv or token material.
    return refused('inspection-unavailable');
  }
}

export function qualifyRunningFleet(request, inspector = liveInspector) {
  validateRequest(request);
  const services = request.services.map(service =>
    qualifyRunningService(service, request.minimumVersion, inspector));
  return {
    kind: 'cloudflared.running-systemd-qualification/v1',
    observedAtUtc: new Date().toISOString(),
    host: hostname(),
    minimumVersion: request.minimumVersion,
    coverage: 'only-explicitly-named-units-on-this-host',
    status: services.every(service => service.status === 'qualified') ? 'qualified' : 'refused',
    services,
    excludes: ['other-connectors', 'provider-route', 'protected-requests', 'oauth', 'host-remediation'],
  };
}

export function parseArguments(argv) {
  const services = [];
  let minimumVersion;
  for (const arg of argv) {
    if (arg.startsWith('--min-version=')) {
      if (minimumVersion !== undefined) throw TypeError('duplicate minimum');
      minimumVersion = arg.slice('--min-version='.length);
    } else if (arg.startsWith('--service=')) {
      const spec = arg.slice('--service='.length);
      const match = /^(user|system):([A-Za-z0-9_.@-]+\.service):(.+)$/.exec(spec);
      if (!match) throw TypeError('invalid service option');
      services.push({ scope: match[1], unit: match[2], binary: match[3] });
    } else throw TypeError('unrecognized option');
  }
  const request = { minimumVersion, services };
  validateRequest(request);
  return request;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const receipt = qualifyRunningFleet(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.status !== 'qualified') process.exitCode = 1;
  } catch {
    process.stderr.write('cloudflared runtime qualification: invalid arguments (see README)\n');
    process.exitCode = 2;
  }
}
