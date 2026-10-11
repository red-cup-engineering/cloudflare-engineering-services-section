import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const verifier = join(root, "scripts", "verify-cloudflare-ingress.mjs");

const TUNNEL_NAME = "example-561-group";
const HOSTNAME = "example.561.group";
const SERVICE = "http://localhost:19999";

function unitText({ tunnelName = TUNNEL_NAME, appService = `${TUNNEL_NAME}.service`, extra = "" } = {}) {
  return [
    "[Unit]",
    `Requires=${appService}`,
    `ConditionPathExists=%h/.config/cloudflared/${tunnelName}.token`,
    "[Service]",
    `ExecStart=%h/.local/bin/cloudflared tunnel --no-autoupdate run --token-file %h/.config/cloudflared/${tunnelName}.token`,
    extra,
  ].join("\n");
}
function bindingObject(overrides = {}) {
  return { configurationSource: "cloudflare-remote", tunnelName: TUNNEL_NAME, hostname: HOSTNAME, service: SERVICE, fallback: "http_status:404", ...overrides };
}
function write(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}
function run(bindingPath, unitPath, extra = []) {
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [verifier, `--binding=${bindingPath}`, `--unit=${unitPath}`, `--expect-tunnel-name=${TUNNEL_NAME}`, `--expect-hostname=${HOSTNAME}`, `--expect-service=${SERVICE}`, ...extra], { encoding: "utf8", env: environment });
}

test("accepts a binding and unit that exactly match the declared expectation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-accept-"));
  try {
    const binding = write(dir, "binding.json", bindingObject());
    const unit = write(dir, "unit.service", unitText());
    const result = run(binding, unit);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects a hostname that does not match the declared expectation", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-host-"));
  try {
    const binding = write(dir, "binding.json", bindingObject({ hostname: "other.561.group" }));
    const unit = write(dir, "unit.service", unitText());
    assert.notEqual(run(binding, unit).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects a numeric-loopback origin substituted for the declared localhost origin", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-numeric-"));
  try {
    const binding = write(dir, "binding.json", bindingObject({ service: "http://127.0.0.1:19999" }));
    const unit = write(dir, "unit.service", unitText());
    assert.notEqual(run(binding, unit).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects a unit carrying a forbidden VPS/cert interface", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-vps-"));
  try {
    const binding = write(dir, "binding.json", bindingObject());
    const unit = write(dir, "unit.service", unitText({ extra: "# cold-red-gate cert.pem" }));
    assert.notEqual(run(binding, unit).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects a unit that requires the wrong application service", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-requires-"));
  try {
    const binding = write(dir, "binding.json", bindingObject());
    const unit = write(dir, "unit.service", unitText({ appService: "some-other.service" }));
    assert.notEqual(run(binding, unit).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects when required --expect-* arguments are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-missing-args-"));
  try {
    const binding = write(dir, "binding.json", bindingObject());
    const unit = write(dir, "unit.service", unitText());
    const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [verifier, `--binding=${binding}`, `--unit=${unit}`], { encoding: "utf8", env: environment });
    assert.notEqual(result.status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--config supplies binding, unit, and expectation literals so no per-deployment wrapper is needed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-config-"));
  try {
    const binding = write(dir, "binding.json", bindingObject());
    const unit = write(dir, "unit.service", unitText());
    const configPath = write(dir, "config.json", {
      binding, unit, tunnelName: TUNNEL_NAME, hostname: HOSTNAME, service: SERVICE,
    });
    const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [verifier, `--config=${configPath}`], { encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an explicit CLI flag overrides its --config counterpart", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-verify-config-override-"));
  try {
    const binding = write(dir, "binding.json", bindingObject());
    const unit = write(dir, "unit.service", unitText());
    const configPath = write(dir, "config.json", {
      binding, unit, tunnelName: TUNNEL_NAME, hostname: "wrong.561.group", service: SERVICE,
    });
    const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [verifier, `--config=${configPath}`, `--expect-hostname=${HOSTNAME}`], { encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
