import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

interface NamespaceInfo { id?: string; title?: string }

const projectUrl = new URL("../", import.meta.url);
const configUrl = new URL("../wrangler.jsonc", import.meta.url);
const expectedTitle = "zackcloud-lite-staging-SUBSCRIPTION_STORE";
const createAllowed = process.argv.includes("--create");

function run(args: string[]): string {
  const result = spawnSync("npx", ["wrangler", ...args], { cwd: projectUrl, encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error("Wrangler command failed");
  return result.stdout;
}

function extractCreatedId(output: string): string | undefined {
  return /"id"\s*:\s*"([a-f0-9]{32})"/i.exec(output)?.[1] ??
    /id\s*=\s*"([a-f0-9]{32})"/i.exec(output)?.[1];
}

try {
  run(["whoami"]);
  const namespaces = JSON.parse(run(["kv", "namespace", "list"])) as NamespaceInfo[];
  const matches = namespaces.filter((namespace) => namespace.title === expectedTitle);
  if (matches.length > 1) throw new Error("Ambiguous namespace state");
  let namespaceId = matches[0]?.id;
  let state = "EXISTS";
  if (!namespaceId) {
    if (!createAllowed) {
      console.log("KV_NAMESPACE=NOT_FOUND");
      console.log("NEXT_STEP=rerun_with_create");
      process.exit(2);
    }
    namespaceId = extractCreatedId(run(["kv", "namespace", "create", "SUBSCRIPTION_STORE", "--env", "staging"]));
    if (!namespaceId) throw new Error("Could not identify created namespace");
    state = "CREATED";
  }

  const config = JSON.parse(await readFile(configUrl, "utf8")) as {
    env: { staging: { kv_namespaces?: Array<{ binding: string; id: string }> } };
  };
  const existing = config.env.staging.kv_namespaces ?? [];
  config.env.staging.kv_namespaces = [
    ...existing.filter(({ binding }) => binding !== "SUBSCRIPTION_STORE"),
    { binding: "SUBSCRIPTION_STORE", id: namespaceId },
  ];
  await writeFile(configUrl, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`KV_NAMESPACE=${state}`);
  console.log("WRANGLER_CONFIG=UPDATED");
} catch {
  console.log("KV_SETUP=FAIL");
  process.exitCode = 1;
}
