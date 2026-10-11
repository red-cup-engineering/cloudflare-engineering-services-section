#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

// A deployment-specific config file (--config=<path>) supplies the binding,
// unit, and expectation literals, so a caller never needs a wrapper script
// to fix a tunnel's shape to one machine.
const configPath = arg("config");
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};

const bindingPath = arg("binding") ?? config.binding;
const unitPath = arg("unit") ?? config.unit;
const tokenPath = arg("token") ?? config.token;
const expectTunnelName = arg("expect-tunnel-name") ?? config.tunnelName;
const expectHostname = arg("expect-hostname") ?? config.hostname;
const expectService = arg("expect-service") ?? config.service;
const expectFallback = arg("expect-fallback") ?? config.fallback ?? "http_status:404";
const expectAppService = arg("expect-app-service") ?? config.appService ?? (expectTunnelName ? `${expectTunnelName}.service` : undefined);

const failures = [];
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

if (failures.length) { process.stderr.write(`cloudflare-ingress: REJECT ${failures.join("; ")}\n`); process.exit(1); }
process.stdout.write(`cloudflare-ingress: ACCEPT remote binding and laptop token-file execution for ${expectTunnelName}\n`);
