import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const verifier = resolve(import.meta.dirname, "../src/verify-cloudflare-ingress.mjs");
function fixture(dir, version, status = 0) {
  const binary = join(dir, "mock-cloudflared");
  writeFileSync(binary, `#!/usr/bin/env node\nif (process.argv[2] !== '--version') process.exit(4);\nprocess.stdout.write(${JSON.stringify(version)});\nprocess.exit(${status});\n`);
  chmodSync(binary, 0o700);
  return binary;
}
function run(dir, binary, extra = []) {
  const binding = join(dir, "binding.json"), unit = join(dir, "tunnel.service");
  writeFileSync(binding, JSON.stringify({ configurationSource: "cloudflare-remote", tunnelName: "test", hostname: "test.561.group", service: "http://localhost:19748", fallback: "http_status:404" }));
  writeFileSync(unit, "[Unit]\nRequires=test.service\nConditionPathExists=%h/.config/cloudflared/test.token\n[Service]\nExecStart=%h/.local/bin/cloudflared tunnel --no-autoupdate run --token-file %h/.config/cloudflared/test.token\n");
  const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [verifier, `--binding=${binding}`, `--unit=${unit}`, "--expect-tunnel-name=test", "--expect-hostname=test.561.group", "--expect-service=http://localhost:19748", ...(binary ? [`--cloudflared-bin=${binary}`, "--min-cloudflared-version=2026.10.2"] : []), ...extra], { encoding: "utf8", env: environment });
}
for (const [name, output, expected] of [
  ["dated 2026.7.2 is refused", "cloudflared version 2026.7.2 (built)", false],
  ["one-patch-behind 2026.10.1 refused", "cloudflared version 2026.10.1", false],
  ["minimum patched 2026.10.2 accepted", "cloudflared version 2026.10.2 (built)", true],
  ["newer patched 2026.10.3 accepted", "cloudflared version 2026.10.3", true],
  ["later month accepted", "cloudflared version 2026.11.0", true],
  ["unparseable output refused", "cloudflared unknown\n", false],
  ["prerelease refused", "cloudflared version 2026.10.2-rc1", false],
  ["malformed prefix refused", "evil cloudflared version 2026.10.2", false],
]) {
  test(name, () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudflare-version-floor-"));
    try {
      const out = run(dir, fixture(dir, output));
      assert.equal(out.status === 0, expected, `${out.stdout}\n${out.stderr}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test("missing executable, failed command, unpaired flags, invalid floor and nonabsolute path fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-version-negative-"));
  try {
    const missing = run(dir, join(dir, "missing"));
    const failed = run(dir, fixture(dir, "cloudflared version 2026.10.3", 1));
    const oneFlag = run(dir, null, ["--cloudflared-bin=/path/to/cloudflared"]);
    const badFloor = run(dir, null, [`--cloudflared-bin=${fixture(dir, "cloudflared version 2026.10.3")}`, "--min-cloudflared-version=2026.10.2-rc"]);
    const badPath = run(dir, "relative/path/cloudflared");
    const duplicate = run(dir, fixture(dir, "cloudflared version 2026.10.3"), ["--cloudflared-bin=/path/to/other-binary"]);
    for (const result of [missing, failed, oneFlag, badFloor, badPath, duplicate]) assert.notEqual(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("existing static verification still works with no binary flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "cloudflare-version-backcompat-"));
  try { const out = run(dir, null); assert.equal(out.status, 0, out.stderr); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
