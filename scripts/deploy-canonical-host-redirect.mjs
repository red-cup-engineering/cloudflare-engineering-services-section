#!/usr/bin/env node
// Derive the www aliases from the published estate and deploy one worker that
// owns exactly those routes. Run by CI on a schedule, so a hand change in the
// Cloudflare dashboard is overwritten by the declaration within a day.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { estateHosts, wwwAliases } from "./canonical-host.mjs";

const ESTATE_URL = process.env.ESTATE_URL ?? "https://561.group/estate-records.json";
const WORKER = "canonical-host-redirect";
const COMPATIBILITY_DATE = "2026-08-29";
const WRANGLER = "wrangler@4.42.0";

const response = await fetch(ESTATE_URL);
if (!response.ok) throw new Error(`estate ${ESTATE_URL} answered ${response.status}`);
const aliases = wwwAliases(estateHosts(await response.json()));
if (aliases.length === 0) throw new Error("estate yields no apex hosts; refusing to deploy a worker with no routes");
console.log(JSON.stringify({ kind: "canonical-host-routes/v1", worker: WORKER, routes: aliases.map(({ route }) => route) }));
if (process.argv.includes("--dry-run")) process.exit(0);

const result = spawnSync("npx", ["--yes", WRANGLER, "deploy", fileURLToPath(new URL("./canonical-host-worker.mjs", import.meta.url)),
  "--name", WORKER, "--compatibility-date", COMPATIBILITY_DATE, ...aliases.flatMap(({ route }) => ["--route", route])],
  { stdio: "inherit" });
process.exit(result.status ?? 1);
