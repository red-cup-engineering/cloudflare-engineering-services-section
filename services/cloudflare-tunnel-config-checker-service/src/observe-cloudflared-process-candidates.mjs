#!/usr/bin/env node
/**
 * A bounded, read-only local Linux /proc candidate discovery for cloudflared.
 * Does not read cmdline, environ, credential files, sockets, or any secret.
 * Its output is NEVER a complete fleet inventory or host-remediation receipt.
 */
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LIMIT = 65536;
function startTicks(record) {
  // Linux stat field 22 is index 19 after the closing '(comm)' (field 3).
  const end = typeof record === 'string' ? record.lastIndexOf(')') : -1;
  const parts = end >= 0 ? record.slice(end + 1).trim().split(/\s+/) : [];
  if (!/^\d+$/.test(parts[19] ?? '')) throw Error('unreadable-process-start');
  return parts[19];
}

export const linuxProcessReader = Object.freeze({
  pids: () => readdirSync('/proc')
    .filter(name => /^[1-9]\d*$/.test(name))
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b),
  comm: pid => readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
  image: pid => {
    const path = `/proc/${pid}`;
    const initial = startTicks(readFileSync(`${path}/stat`, 'utf8'));
    const executable = readlinkSync(`${path}/exe`);
    const metadata = statSync(`${path}/exe`);
    const final = startTicks(readFileSync(`${path}/stat`, 'utf8'));
    if (initial !== final) throw Error('process-reused-during-observation');
    return { executable, startTicks: initial, device: String(metadata.dev), inode: String(metadata.ino) };
  },
});
function sanePid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}
export function observeCloudflaredProcessCandidates(reader = linuxProcessReader, options = {}) {
  const maxProcesses = options.maxProcesses ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(maxProcesses) || maxProcesses < 1 || maxProcesses > DEFAULT_LIMIT) {
    throw TypeError('maxProcesses must be a bounded positive integer');
  }
  const pids = reader.pids();
  if (!Array.isArray(pids) || pids.length > maxProcesses ||
      pids.some(pid => !sanePid(pid)) || new Set(pids).size !== pids.length) {
    throw Error('unsafe-or-incomplete-process-directory');
  }
  const candidates = [];
  let unreadableProcessCount = 0;
  for (const pid of pids) {
    let name;
    try {
      name = reader.comm(pid);
    } catch {
      unreadableProcessCount++;
      continue; // inaccessible PID may be cloudflared; completeness is unknown
    }
    if (name !== 'cloudflared') continue;
    try {
      const image = reader.image(pid);
      if (!image || typeof image.executable !== 'string' ||
          !image.executable.startsWith('/') || typeof image.startTicks !== 'string' ||
          !/^\d+$/.test(image.startTicks) ||
          !/^\d+$/.test(image.device) || !/^\d+$/.test(image.inode)) {
        throw Error('malformed-image');
      }
      candidates.push({
        pid, status: image.executable.endsWith(' (deleted)') ? 'unresolved' : 'observed',
        executable: image.executable,
        startTicks: image.startTicks,
        device: image.device,
        inode: image.inode,
        ...(image.executable.endsWith(' (deleted)') ? { reason: 'deleted-image' } : {}),
      });
    } catch {
      candidates.push({ pid, status: 'unresolved', reason: 'image-unavailable-or-changing' });
    }
  }
  const unresolvedCandidateCount = candidates.filter(c => c.status !== 'observed').length;
  return {
    kind: 'cloudflared.process-candidates/v1',
    observedAtUtc: new Date().toISOString(),
    host: hostname(),
    coverage: 'local-visible-/proc-comm-only; renamed-or-hidden-processes-and-other-hosts-not-covered',
    status: unreadableProcessCount || unresolvedCandidateCount ? 'partial'
      : candidates.length ? 'candidates-observed' : 'no-candidates',
    scannedProcessCount: pids.length,
    unreadableProcessCount,
    observedCandidateCount: candidates.length - unresolvedCandidateCount,
    unresolvedCandidateCount,
    candidates,
    receiving: 'separate-systemd-scopes-running-version-service-health-and-external-application',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv.length !== 2) throw TypeError('no CLI options supported');
    const reading = observeCloudflaredProcessCandidates();
    process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
    // Even clean discovery is not patch acceptance. This status reports only discovery quality.
    if (reading.status !== 'candidates-observed') process.exitCode = 1;
  } catch {
    process.stderr.write('cloudflared process discovery refused: process directory unreadable or unsafe\n');
    process.exitCode = 2;
  }
}
