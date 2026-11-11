#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const bindingPath = arg("binding");
const unitPath = arg("unit");
const tokenPath = arg("token");
// A host's expectations are parameters: either the --expect-* flags or one JSON
// parameter file (--parameters=PATH with tunnelName, hostname, service and
// optionally fallback and appService). A flag overrides the file.
const parametersPath = arg("parameters");
let parameters = {};
if (parametersPath) {
  try { parameters = JSON.parse(readFileSync(parametersPath, "utf8")); }
  catch { process.stderr.write("cloudflare-ingress: REJECT readable JSON --parameters is required when given\n"); process.exit(1); }
}
const expectTunnelName = arg("expect-tunnel-name") ?? parameters.tunnelName;
const expectHostname = arg("expect-hostname") ?? parameters.hostname;
const expectService = arg("expect-service") ?? parameters.service;
const expectFallback = arg("expect-fallback") ?? parameters.fallback ?? "http_status:404";
const expectAppService = arg("expect-app-service") ?? parameters.appService ?? (expectTunnelName ? `${expectTunnelName}.service` : undefined);
const cloudflaredBin = arg("cloudflared-bin");
const minCloudflaredVersion = arg("min-cloudflared-version");

const failures = [];
for (const flag of ["cloudflared-bin", "min-cloudflared-version"]) {
  if (process.argv.filter((value) => value.startsWith(`--${flag}=`)).length > 1) failures.push(`duplicate --${flag} is not allowed`);
}
if (!bindingPath || !existsSync(bindingPath)) failures.push("readable --binding is required");
if (!unitPath || !existsSync(unitPath)) failures.push("readable --unit is required");
if (!expectTunnelName) failures.push("--expect-tunnel-name is required");
if (!expectHostname) failures.push("--expect-hostname is required");
if (!expectService) failures.push("--expect-service is required");

if (!failures.length) {
  const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  const expected = { configurationSource: "cloudflare-remote", tunnelName: expectTunnelName, hostname: expectHostname, service: expectService, fallback: expectFallback };
  for (const [key, value] of Object.entries(expected)) if (binding[key] !== value) failures.push(`binding ${key} must equal ${value}`);

  const unit = readFileSync(unitPath, "utf8");
  const tokenFile = `%h/.config/cloudflared/${expectTunnelName}.token`;
  const exec = `cloudflared tunnel --no-autoupdate run --token-file ${tokenFile}`;
  if (!unit.includes(exec)) failures.push("unit must consume only the fixed token-file interface");
  if (!unit.includes(`ConditionPathExists=${tokenFile}`)) failures.push("unit must refuse startup when the fixed token file is missing");
  for (const forbidden of ["cert.pem", "credentials-file", "cold-red-gate", "45.76.19.133", "--token "]) if (unit.includes(forbidden)) failures.push(`unit contains forbidden ${forbidden}`);
  if (!unit.includes(`Requires=${expectAppService}`)) failures.push(`unit must require the laptop application service (${expectAppService})`);
}

if (tokenPath) {
  if (!existsSync(tokenPath)) failures.push("admitted tunnel token is missing");
  else if ((statSync(tokenPath).mode & 0o777) !== 0o600) failures.push("admitted tunnel token mode is not 0600");
}

// Optional *host* binary check; it does not prove which binary a running PID uses.
// Never invoke a shell, and never infer an upgrade from a source file or an image tag.
const versionParts = (value) => /^\d{4}\.\d{1,2}\.\d+$/.test(value ?? "")
  ? value.split(".").map(Number) : null;
let checkedCloudflaredVersion;
if (Boolean(cloudflaredBin) !== Boolean(minCloudflaredVersion)) {
  failures.push("--cloudflared-bin and --min-cloudflared-version are required together");
} else if (cloudflaredBin) {
  const floor = versionParts(minCloudflaredVersion);
  if (!floor) failures.push("--min-cloudflared-version must be a full YYYY.M.P release");
  else if (!isAbsolute(cloudflaredBin)) failures.push("--cloudflared-bin must be an absolute executable path");
  else {
    const observed = spawnSync(cloudflaredBin, ["--version"], {
      encoding: "utf8", timeout: 5000, maxBuffer: 8192,
    });
    if (observed.error || observed.status !== 0) {
      failures.push("cloudflared executable could not report its version");
    } else {
      const match = /^cloudflared version (\d{4}\.\d{1,2}\.\d+)(?=\s|$)/.exec((observed.stdout ?? "").trim());
      const current = versionParts(match?.[1]);
      if (!current) failures.push("cloudflared --version did not return a stable release version");
      else {
        checkedCloudflaredVersion = match[1];
        const differing = current.findIndex((part, index) => part !== floor[index]);
        if (differing >= 0 && current[differing] < floor[differing]) {
          failures.push(`cloudflared ${checkedCloudflaredVersion} is below required ${minCloudflaredVersion}`);
        }
      }
    }
  }
}

if (failures.length) { process.stderr.write(`cloudflare-ingress: REJECT ${failures.join("; ")}\n`); process.exit(1); }
process.stdout.write(`cloudflare-ingress: ACCEPT remote binding and laptop token-file execution for ${expectTunnelName}${checkedCloudflaredVersion ? `; checked binary version ${checkedCloudflaredVersion} >= ${minCloudflaredVersion}` : ""}\n`);
