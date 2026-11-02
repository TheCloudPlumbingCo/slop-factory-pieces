import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM. Sealed format: base64(iv[12] | authTag[16] | ciphertext).
// `aad` binds the ciphertext to its owner so a record cannot be swapped between users.

function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return k;
}

export const hasEncryptionKey = (): boolean => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

export function seal(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function open(sealed: string, aad: string): string {
  const buf = Buffer.from(sealed, "base64");
  if (buf.length < 29) throw new Error("sealed data is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("sealed data failed authentication");
  }
}
