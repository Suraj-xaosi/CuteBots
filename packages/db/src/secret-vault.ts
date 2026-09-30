import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1";

export class SecretVault {
  private readonly key: Buffer;

  constructor(encodedKey = process.env.SETTINGS_ENCRYPTION_KEY) {
    if (!encodedKey) {
      throw new Error("SETTINGS_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex key");
    }
    this.key = decodeKey(encodedKey);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      ENCRYPTION_PREFIX,
      iv.toString("base64url"),
      authTag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(":");
  }

  decrypt(value: string): string {
    const [prefix, encodedIv, encodedTag, encodedCiphertext] = value.split(":");
    if (prefix !== ENCRYPTION_PREFIX || !encodedIv || !encodedTag || encodedCiphertext === undefined) {
      throw new Error("Stored secret has an unsupported encryption format");
    }

    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(encodedIv, "base64url"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function decodeKey(value: string): Buffer {
  const key = /^[A-Fa-f0-9]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.byteLength !== 32) {
    throw new Error("SETTINGS_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}