#!/usr/bin/env node
/**
 * Compose the existing /proc discovery and live systemd MainPID qualifier.
 * This is a read-only, partial LOCAL observation; never a patched fleet verdict.
 * No shell, secrets, process argv, environment, restart, or new inventory store.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeCloudflaredProcessCandidates } from './observe-cloudflared-process-candidates.mjs';
import { liveInspector, qualifyRunningService } from './verify-running-cloudflared.mjs';

const RELEASE = /^\d{4}\.\d{1,2}\.\d+$/;
const UNIT = /^[A-Za-z0-9_.@-]{1,120}\.service$/;
const USER_MANAGER = /^user@[0-9]+\.service$/;
const CAP = 32;

/**
 * A kernel cgroup path offers only a *candidate* systemd owner.
 * systemctl MainPID and the running image must still independently agree.
 * Refuse hybrid/v1, containers, transient scopes and ambiguous ancestors.
 */
export function systemdMembershipFromCgroup(contents) {
  if (typeof contents !== 'string' || contents.length > 16384) return null;
  const lines = contents.trimEnd().split('\n');
  if (lines.length !== 1 || !lines[0].startsWith('0::/')) return null;
  const parts = lines[0].slice(3).split('/').filter(Boolean);
  if (parts.length < 2 || parts.some(p => p.length > 180 || /[\x00-\x1f:]/.test(p))) return null;
  const userManagers = parts.filter(p => USER_MANAGER.test(p));
  const candidates = parts.filter(p => UNIT.test(p) && !USER_MANAGER.test(p));
  if (candidates.length !== 1) return null;
  const inUser = parts.includes('user.slice') && !parts.includes('system.slice') &&
    userManagers.length === 1;
  const inSystem = parts.includes('system.slice') && !parts.includes('user.slice') &&
    userManagers.length === 0;
  if (inUser === inSystem) return null;
  return Object.freeze({ scope: inUser ? 'user' : 'system', unit: candidates[0] });
}

const sameWitness = (process, candidate) =>
  process && process.target === candidate.executable &&
  String(process.dev) === candidate.device &&
  String(process.ino) === candidate.inode &&
  String(process.startTicks) === candidate.startTicks;
const sameProcess = (a, b) => a && b && a.target === b.target &&
  a.dev === b.dev && a.ino === b.ino && a.startTicks === b.startTicks;

export const liveCgroupOf = pid => readFileSync(`/proc/${pid}/cgroup`, 'utf8');

export function assayLocalCloudflared({
  minimumVersion,
  discover = () => observeCloudflaredProcessCandidates(),
  cgroupOf = liveCgroupOf,
  inspector = liveInspector,
  observedAtUtc = () => new Date().toISOString(),
  host = () => hostname(),
} = {}) {
  if (!RELEASE.test(minimumVersion ?? ''))
    throw TypeError('full release floor required');
  const base = {
    kind: 'cloudflared.local-process-systemd-assay/v1',
    observedAtUtc: observedAtUtc(),
    host: host(),
    minimumVersion,
    coverage: 'local-visible-proc-comm-and-systemd-only; no-fleet-assertion',
    excludes: [
      'unreadable-and-renamed-processes', 'containers-and-other-hosts',
      'provider-connection', 'route-and-health', 'anonymous-protection',
      'oauth', 'host-remediation',
    ],
  };
  let found;
  try {
    found = discover();
  } catch {
    return { ...base, status: 'partial', reason: 'discovery-unavailable',
      discovery: null, candidates: [] };
  }
  if (!found || found.kind !== 'cloudflared.process-candidates/v1' ||
      !['partial', 'no-candidates', 'candidates-observed'].includes(found.status) ||
      !Array.isArray(found.candidates) ||
      !Number.isSafeInteger(found.unreadableProcessCount) ||
      !Number.isSafeInteger(found.scannedProcessCount) ||
      found.unreadableProcessCount < 0 || found.scannedProcessCount < 0) {
    return { ...base, status: 'partial', reason: 'discovery-invalid',
      discovery: null, candidates: [] };
  }
  const discovery = {
    status: found.status, scannedProcessCount: found.scannedProcessCount,
    unreadableProcessCount: found.unreadableProcessCount,
    discoveredCandidateCount: found.candidates.length,
  };
  if (found.candidates.length > CAP)
    return { ...base, status: 'partial', reason: 'candidate-bound-exceeded',
      discovery, candidates: [] };

  const candidates = found.candidates.map(candidate => {
    const pid = candidate?.pid;
    const reject = reason => ({ pid: Number.isSafeInteger(pid) ? pid : null,
      status: 'unresolved', reason });
    if (!Number.isSafeInteger(pid) || pid < 1 ||
        candidate.status !== 'observed' || typeof candidate.executable !== 'string' ||
        !candidate.executable.startsWith('/') ||
        basename(candidate.executable) !== 'cloudflared' ||
        [...candidate.executable].some(c => c.charCodeAt(0) < 32) ||
        candidate.executable.endsWith(' (deleted)') ||
        !/^\d+$/.test(candidate.startTicks ?? '') ||
        !/^\d+$/.test(candidate.device ?? '') ||
        !/^\d+$/.test(candidate.inode ?? '')) return reject('candidate-unavailable');
    try {
      const before = inspector.process(pid);
      if (!sameWitness(before, candidate)) return reject('process-image-changed');
      const firstCgroup = cgroupOf(pid);
      const membership = systemdMembershipFromCgroup(firstCgroup);
      if (!membership) return reject('systemd-owner-unattributed');
      const during = inspector.process(pid);
      if (!sameProcess(before, during)) return reject('process-changed-during-attribution');
      const observed = qualifyRunningService(
        { ...membership, binary: candidate.executable }, minimumVersion, inspector);
      if (observed.status !== 'qualified') return {
        pid, scope: membership.scope, unit: membership.unit,
        status: 'refused', reason: observed.reason ?? 'running-qualification-refused',
      };
      // Prevent two processes sharing one service or PID recycling from passing.
      const after = inspector.process(pid);
      if (observed.pid !== pid || !sameProcess(before, after) ||
          cgroupOf(pid) !== firstCgroup) {
        return reject('service-or-process-identity-changed');
      }
      return {
        pid, scope: membership.scope, unit: membership.unit,
        status: 'qualified', runningVersion: observed.runningVersion,
      };
    } catch {
      // Do not echo raw cgroups, systemctl output, executable stderr or secrets.
      return reject('inspection-unavailable');
    }
  });
  const anyRefusal = candidates.some(c => c.status === 'refused');
  const allCandidatesQualified = candidates.length > 0 &&
    candidates.every(c => c.status === 'qualified');
  const status = anyRefusal ? 'candidate-qualification-refused' :
    found.status === 'candidates-observed' && allCandidatesQualified
      ? 'qualified-candidates' : 'partial';
  return { ...base, status, discovery, candidates };
}

export function requestFrom(argv) {
  if (argv.length !== 1 || !argv[0].startsWith('--min-version='))
    throw TypeError('one --min-version=YYYY.M.P is required');
  const minimumVersion = argv[0].slice('--min-version='.length);
  if (!RELEASE.test(minimumVersion)) throw TypeError('invalid minimum release');
  return { minimumVersion };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const receipt = assayLocalCloudflared(requestFrom(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.status !== 'qualified-candidates') process.exitCode = 1;
  } catch {
    process.stderr.write('local cloudflared assay refused: invalid or unavailable request\n');
    process.exitCode = 2;
  }
}
