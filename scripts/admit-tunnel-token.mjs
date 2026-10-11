#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { writeFileTextSync } from "@red-cup-engineering/computer-file-engineering-services-section/write-file";

const args = new Map(process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
  const [key, ...rest] = arg.slice(2).split("="); return [key, rest.length ? rest.join("=") : true];
}));

function fail(message) { process.stderr.write(`tunnel-token admission refused: ${message}\n`); process.exitCode = 1; }

// A deployment-specific config file (--config=<path>) supplies the tunnel
// name, an optional expected Cloudflare account id, and an optional fixed
// token path, so callers never need a wrapper script to fix those literals.
export function readAdmissionConfig(path) {
  const parsed = JSON.parse(readFileSync(resolve(String(path)), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--config must name a JSON object");
  return parsed;
}

export function validateTunnelToken(token, expectedAccountId) {
  if (token.length < 80 || token.length > 4096 || /\s/.test(token) || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("token must be one bounded base64url value without whitespace");
  let value;
  try { value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { throw new Error("token is not a decodable Cloudflare tunnel-token envelope"); }
  if (!value || typeof value !== "object" || !/^[a-f0-9]{32}$/i.test(value.a ?? "") || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.t ?? "") || typeof value.s !== "string" || value.s.length < 16) throw new Error("token envelope lacks bounded account, tunnel, or connector claims");
  if (expectedAccountId && value.a.toLowerCase() !== String(expectedAccountId).toLowerCase()) throw new Error("token account claim does not match the expected account");
  return value;
}

function tunnelNameFrom(tunnelName) {
  if (!tunnelName || !/^[a-z0-9-]{1,120}$/.test(tunnelName)) throw new Error("--tunnel-name must name one bounded lowercase-kebab tunnel");
  return tunnelName;
}

export function tokenPathForTestRoot(testRoot, tunnelName) {
  const root = resolve(String(testRoot));
  if (root === "/" || !existsSync(root) || lstatSync(root).isSymbolicLink()) throw new Error("test root must name an existing non-symlink directory other than /");
  return join(root, ".config", "cloudflared", `${tunnelNameFrom(tunnelName)}.token`);
}

function target(tunnelName, config) {
  if (args.has("test-root")) return tokenPathForTestRoot(args.get("test-root"), tunnelName);
  const tokenPath = args.get("token-path") ?? config?.tokenPath;
  if (tokenPath) return resolve(String(tokenPath));
  return `/home/emsenn/.config/cloudflared/${tunnelNameFrom(tunnelName)}.token`;
}

async function hiddenPrompt() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("interactive admission requires a TTY; automation must explicitly use --stdin --safe-stdin");
  process.stderr.write("Paste the tunnel-specific Cloudflare token (input hidden), then press Enter: ");
  process.stdin.setRawMode(true); process.stdin.resume();
  let token = "";
  try {
    return await new Promise((resolveToken, reject) => process.stdin.on("data", (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) return reject(new Error("interrupted"));
        if (byte === 13 || byte === 10) return resolveToken(token);
        if (byte === 127 || byte === 8) { token = token.slice(0, -1); continue; }
        if (byte >= 32 && byte <= 126) token += String.fromCharCode(byte);
        if (token.length > 4096) return reject(new Error("token exceeds the admission bound"));
      }
    }));
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write("\n"); }
}

async function readToken() {
  if (args.has("stdin")) {
    if (!args.has("safe-stdin")) throw new Error("--stdin requires the explicit --safe-stdin acknowledgement");
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 4096) throw new Error("token exceeds the admission bound");
    }
    return input.trim();
  }
  return hiddenPrompt();
}

export function admitTunnelToken(token, path, expectedAccountId) {
  validateTunnelToken(token, expectedAccountId);
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(resolve(directory, "..")).isSymbolicLink()) throw new Error("protected configuration parent may not be a symlink");
  if (lstatSync(directory).isSymbolicLink()) throw new Error("protected token directory may not be a symlink");
  chmodSync(directory, 0o700);
  writeFileTextSync(path, `${token}\n`, { mode: 0o600 });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = args.has("config") ? readAdmissionConfig(args.get("config")) : {};
    const tunnelName = tunnelNameFrom(args.get("tunnel-name") ?? config.tunnelName);
    const accountId = args.get("account-id") ?? config.accountId;
    const token = await readToken();
    if (!token) throw new Error("no token was supplied");
    const path = target(tunnelName, config); admitTunnelToken(token, path, accountId);
    process.stdout.write(`tunnel-token admitted to ${path}; mode 0600\n`);
  } catch (error) { fail(error instanceof Error ? error.message : "unknown admission failure"); }
}
