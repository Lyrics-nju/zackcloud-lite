import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = new URL("../", import.meta.url);
const excludedDirectories = new Set([".git", ".wrangler", "coverage", "dist", "node_modules"]);

function parseDevVars(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

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

const devVarsText = await readFile(new URL("../.dev.vars", import.meta.url), "utf8").catch(() => "");
const devVars = parseDevVars(devVarsText);
let friendTokens = [];
try {
  const friends = JSON.parse(devVars.get("FRIENDS_CONFIG_JSON") ?? "[]");
  if (Array.isArray(friends)) friendTokens = friends.map((friend) => friend?.token).filter((token) => typeof token === "string");
} catch {
  // Malformed local friend configuration cannot add searchable token values.
}
const sensitiveValues = [
  devVars.get("UPSTREAM_SUBSCRIPTION_URL"),
  ...(devVars.get("ALLOWED_TOKENS") ?? "").split(","),
  ...friendTokens,
].map((value) => value?.trim()).filter((value) => value && value.length >= 6);

const files = await collectFiles(projectRoot);
const leaks = [];
for (const file of files) {
  const content = await readFile(file.url, "utf8").catch(() => "");
  if (sensitiveValues.some((value) => content.includes(value))) leaks.push(file.relative);
  if (!file.relative.startsWith("test/") && /[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89abAB][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}/.test(content)) leaks.push(file.relative);
  if (/Bearer\s+[A-Za-z0-9._~-]{8,}/i.test(content)) leaks.push(file.relative);
}

const { stdout: trackedOutput } = await execFile("git", ["ls-files"], { cwd: projectRoot });
const tracked = trackedOutput.split(/\r?\n/).filter(Boolean);
const forbiddenTracked = tracked.filter((path) =>
  path === ".dev.vars" || path === ".env" || path.startsWith("node_modules/") ||
  path.startsWith("dist/") || path.startsWith(".wrangler/") || path.startsWith("runtime/") ||
  path.includes("real-subscription") || path.endsWith("staging-friends.json") ||
  path.endsWith("staging-subscription.yaml") || path.endsWith("staging-headers.txt"));

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
