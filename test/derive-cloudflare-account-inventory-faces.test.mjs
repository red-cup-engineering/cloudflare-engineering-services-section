import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deriveCloudflareAccountInventory } from "../scripts/derive-cloudflare-account-inventory.mjs";

const examples = [
  {
    "type": "JavascriptNodeOperationExample",
    "name": "refuses TOKEN_ENVIRONMENT_VARIABLE_UNSET when the named environment variable is unset",
    "input": {
      "accountId": "337e54ee6dc7d488933f473204a6d89e",
      "tokenEnvironmentVariable": "CLOUDFLARE_API_TOKEN_UNSET_EXAMPLE"
    },
    "output": {
      "type": "CloudflareAccountInventoryRefusal",
      "code": "TOKEN_ENVIRONMENT_VARIABLE_UNSET",
      "tokenEnvironmentVariable": "CLOUDFLARE_API_TOKEN_UNSET_EXAMPLE"
    }
  }
];

for (const example of examples) {
  test(example.name, async () => {
    const importedOutput = await deriveCloudflareAccountInventory(example.input);
    assert.deepEqual(importedOutput, example.output);
    const command = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/derive-cloudflare-account-inventory.mjs", import.meta.url))], {
      input: JSON.stringify(example.input) + "\n",
      encoding: "utf8",
    });
    assert.equal(command.status, 0, command.stderr);
    const commandOutput = JSON.parse(command.stdout.trim());
    assert.deepEqual(commandOutput, example.output);
    assert.deepEqual(commandOutput, importedOutput);
  });
}
