#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { parseEnv } from 'node:util';

const API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = 'com.cloudflare.api.account';
const ZONE = `${ACCOUNT}.zone`;
const idPattern = /^[a-f0-9]{32}$/;

function execute(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal === 'SIGINT' ? 130 : 143));
    });
  });
}

/** Run one trusted maintenance command with a scoped, expiring account token.
 * The manager secret stays in this process. No token is written to disk.
 * This controls Cloudflare authority; it is not a sandbox for untrusted code.
 */
export async function withCloudflareToken({
  accountId, managerToken, accountPermissions = [], zonePermissions = [], zoneId,
  ttlMinutes = 60, command, args = [], env = process.env,
  fetchImpl = fetch, run = execute, report = line => process.stderr.write(`${line}\n`),
}) {
  if (!idPattern.test(accountId ?? '') || !managerToken) throw new Error('Cloudflare account ID and manager credential are required');
  if (!command) throw new Error('A command is required');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 60) throw new Error('Token lifetime must be 5–60 minutes');
  if (!accountPermissions.length && !zonePermissions.length) throw new Error('Request at least one explicit permission');
  if (zonePermissions.length && !idPattern.test(zoneId ?? '')) throw new Error('Zone permissions require one explicit zone ID');
  async function api(path, method = 'GET', body) {
    const response = await fetchImpl(`${API}/accounts/${accountId}${path}`, {
      method, headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}; codes ${(data.errors ?? []).map(e => e.code).join(',')}`);
    }
    return data.result;
  }
  const groups = await api('/tokens/permission_groups');
  const policies = [];
  for (const [scope, resourceId, names] of [[ACCOUNT, accountId, accountPermissions], [ZONE, zoneId, zonePermissions]]) {
    if (!names.length) continue;
    const permission_groups = [...new Set(names)].map(name => {
      const matches = groups.filter(g => g.name === name && g.scopes.includes(scope));
      if (matches.length !== 1) throw new Error(`Unknown or ambiguous ${scope} permission: ${name}`);
      if (/API Tokens/.test(name)) throw new Error('Maintenance commands cannot receive token-management permissions');
      return { id: matches[0].id };
    });
    policies.push({ effect: 'allow', resources: { [`${scope}.${resourceId}`]: '*' }, permission_groups });
  }
  const expires_on = new Date(Date.now() + ttlMinutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const token = await api('/tokens', 'POST', {
    name: `561 maintenance ${new Date().toISOString()}`, policies, expires_on,
  });
  if (!idPattern.test(token?.id ?? '')) throw new Error('Cloudflare returned no token ID; any created token expires at ' + expires_on);
  try {
    if (!token.value) throw new Error('Cloudflare returned no token value');
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/CLOUDFLARE|^CF_(API|ACCOUNT|ZONE)/i.test(key)));
    childEnv.CLOUDFLARE_API_TOKEN = token.value;
    childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
    if (zoneId) childEnv.CLOUDFLARE_ZONE_ID = zoneId;
    report(`Cloudflare: issued scoped token ${token.id}, expires ${expires_on}`);
    return await run(command, args, childEnv);
  } finally {
    try {
      await api(`/tokens/${token.id}`, 'DELETE');
      report(`Cloudflare: revoked token ${token.id}`);
    } catch {
      throw new Error(`Could not confirm revocation of token ${token.id}; it expires at ${expires_on}`);
    }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('Usage: node with-cloudflare-token.mjs [--env-file .env] [--account-permission "Workers Editor"] [--zone-id ID --zone-permission "Config Settings Write"] [--ttl-minutes 60] -- COMMAND [ARG ...]\nRepeat permission flags for additional permissions. Only account ID and manager credential are read from the env file.');
  } else {
    try {
      const separator = argv.indexOf('--');
      if (separator < 0) throw new Error('Separate the command with --; use --help for usage');
      const options = { accountPermissions: [], zonePermissions: [], command: argv[separator + 1], args: argv.slice(separator + 2) };
      let envFile;
      for (let i = 0; i < separator; i += 2) {
        if (i + 1 >= separator) throw new Error(`Missing value for ${argv[i]}`);
        const flag = argv[i], value = argv[i + 1];
        if (flag === '--env-file') envFile = value;
        else if (flag === '--zone-id') options.zoneId = value;
        else if (flag === '--account-permission') options.accountPermissions.push(value);
        else if (flag === '--zone-permission') options.zonePermissions.push(value);
        else if (flag === '--ttl-minutes') options.ttlMinutes = Number(value);
        else throw new Error(`Unknown option ${flag}`);
      }
      const fileEnv = envFile ? parseEnv(await readFile(envFile, 'utf8')) : {};
      options.accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? fileEnv.CLOUDFLARE_ACCOUNT_ID;
      options.managerToken = process.env.CLOUDFLARE_ACCOUNT_TOKEN_MANAGER ?? fileEnv.CLOUDFLARE_ACCOUNT_TOKEN_MANAGER;
      setDefaultAutoSelectFamilyAttemptTimeout(2000);
      process.exitCode = await withCloudflareToken(options);
    } catch (error) {
      console.error(`Cloudflare maintenance failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
