import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = new URL("../", import.meta.url);
const excludedDirectories = new Set([".git", ".wrangler", "coverage", "dist", "node_modules"]);

async function collectFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const nextUrl = new URL(nextRelative, projectRoot);
    if (entry.isDirectory()) files.push(...await collectFiles(nextUrl, nextRelative));
    else if (entry.isFile() && entry.name !== ".dev.vars") files.push({ relative: nextRelative, url: nextUrl });
  }
  return files;
}

const files = await collectFiles(projectRoot);
const leaks = [];
const friendStorePath = process.env.ZACKCLOUD_FRIENDS_FILE ||
  join(homedir(), ".local", "share", "zackcloud-lite", "friends.json");
const friendStoreText = await readFile(friendStorePath, "utf8").catch(() => "");
let sensitiveValues = [];
try {
  const friends = JSON.parse(friendStoreText);
  if (Array.isArray(friends)) {
    sensitiveValues = friends.map((friend) => friend?.token)
      .filter((token) => typeof token === "string" && token.length >= 16);
  }
} catch {
  // Invalid private state is handled by the friend CLI; the scanner never prints it.
}
for (const file of files) {
  const content = await readFile(file.url, "utf8").catch(() => "");
  if (sensitiveValues.some((value) => content.includes(value))) leaks.push(file.relative);
  const wranglerConfigFile = /(^|\/)wrangler(?:\.[a-z0-9-]+)?\.jsonc(?:\.bak)?$/i.test(file.relative);
  const uuidScanContent = wranglerConfigFile
    ? content.replace(/("database_id"\s*:\s*")[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89abAB][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}("\s*)/g, "$1[PUBLIC_D1_DATABASE_ID]$2")
    : content;
  if (!file.relative.startsWith("test/") && /[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89abAB][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}/.test(uuidScanContent)) leaks.push(file.relative);
  if (/Bearer\s+[A-Za-z0-9._~-]{8,}/i.test(content)) leaks.push(file.relative);
}

const { stdout: trackedOutput } = await execFile("git", ["ls-files"], { cwd: projectRoot });
const tracked = trackedOutput.split(/\r?\n/).filter(Boolean);
const forbiddenTracked = tracked.filter((path) =>
  path === ".dev.vars" || path === ".env" || path.startsWith("node_modules/") ||
  path.startsWith("dist/") || path.startsWith(".wrangler/") || path.startsWith("runtime/") ||
  path.includes("real-subscription") || path.endsWith("staging-friends.json") ||
  path.endsWith("staging-subscription.yaml") || path.endsWith("staging-headers.txt") ||
  /\.(?:db|db-shm|db-wal|sqlite|sqlite3)$/i.test(path) ||
  path === "friends.json" || path.endsWith("/friends.json"));

const workflowFile = files.find(({ relative }) => relative === ".github/workflows/update-subscription.yml");
if (workflowFile) {
  const workflow = await readFile(workflowFile.url, "utf8");
  const forbiddenWorkflowPatterns = [
    /set\s+-x/,
    /echo[^\n]*secrets\./i,
    /GITHUB_STEP_SUMMARY/,
    /actions\/upload-artifact/i,
    /cat[^\n]*(ya?ml|\.dev\.vars)/i,
  ];
  if (forbiddenWorkflowPatterns.some((pattern) => pattern.test(workflow))) leaks.push(workflowFile.relative);
  if (!/if:\s*always\(\)/.test(workflow) || !/RUNNER_TEMP/.test(workflow)) leaks.push(workflowFile.relative);
}

if (leaks.length > 0 || forbiddenTracked.length > 0) {
  console.log("SECURITY_SCAN=FAIL");
  console.log(`SUSPECT_FILE_COUNT=${new Set([...leaks, ...forbiddenTracked]).size}`);
  process.exitCode = 1;
} else {
  console.log("SECURITY_SCAN=PASS");
  console.log(`SCANNED_FILE_COUNT=${files.length}`);
  console.log(`TRACKED_FILE_COUNT=${tracked.length}`);
}
