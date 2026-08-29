const encoder = new TextEncoder();
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_ITERATIONS = 310_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index % left.length] ?? 0) ^ (right[index % right.length] ?? 0);
  }
  return difference === 0;
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt: bufferSource(salt),
    iterations,
  }, key, 256));
}

export function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error("PASSWORD_POLICY_FAILED");
  }
}

export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<{
  hash: string; salt: string; iterations: number;
}> {
  validatePassword(password);
  const salt = randomBytes(16);
  return {
    hash: bytesToBase64Url(await derivePassword(password, salt, iterations)),
    salt: bytesToBase64Url(salt),
    iterations,
  };
}

export async function verifyPassword(
  password: string, hash: string, salt: string, iterations: number,
): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH || iterations < 100_000 || iterations > 2_000_000) return false;
  try {
    return constantTimeEqual(await derivePassword(password, base64UrlToBytes(salt), iterations), base64UrlToBytes(hash));
  } catch {
    return false;
  }
}

export async function createPortablePasswordHash(password: string): Promise<string> {
  const result = await hashPassword(password);
  return `pbkdf2-sha256$${result.iterations}$${result.salt}$${result.hash}`;
}

export async function verifyPortablePassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, iterations, salt, hash] = encoded.split("$");
  if (algorithm !== "pbkdf2-sha256" || !iterations || !salt || !hash) return false;
  return verifyPassword(password, hash, salt, Number(iterations));
}

export function randomOpaqueToken(): string {
  return bytesToBase64Url(randomBytes(32));
}

export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(encoded: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(encoded);
  if (bytes.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw", bufferSource(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token: string, encodedKey: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferSource(iv) },
    await encryptionKey(encodedKey),
    bufferSource(encoder.encode(token)),
  );
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), iv: bytesToBase64Url(iv) };
}

export async function decryptToken(ciphertext: string, iv: string, encodedKey: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bufferSource(base64UrlToBytes(iv)) },
    await encryptionKey(encodedKey),
    bufferSource(base64UrlToBytes(ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}

export function safeId(): string {
  return randomOpaqueToken();
}
