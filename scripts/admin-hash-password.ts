import { readFile } from "node:fs/promises";
import { createPortablePasswordHash } from "../portal/src/security";

try {
  if (process.argv.length > 2) throw new Error("PASSWORD_ARGUMENT_NOT_ALLOWED");
  const password = (await readFile("/dev/stdin", "utf8")).replace(/[\r\n]+$/, "");
  if (!password) throw new Error("PASSWORD_STDIN_REQUIRED");
  console.log(`ADMIN_PASSWORD_HASH=${await createPortablePasswordHash(password)}`);
} catch (error) {
  const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "ADMIN_HASH_FAILED";
  console.log(`ADMIN_HASH=${reason}`);
  process.exitCode = 1;
}
