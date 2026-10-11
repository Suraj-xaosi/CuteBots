import assert from "node:assert/strict";
import test from "node:test";
import { redactStructuredSecrets, redactTextSecrets } from "../src/security/secret-redaction.js";

test("secret redaction removes known token formats and credential assignments", () => {
  const value = "ghp_abcdefghijklmnopqrstuvwxyz123456 Bearer abcdefghijklmnopqrstuvwxyz api_key=very-long-secret-value";
  const redacted = redactTextSecrets(value);

  assert.equal(redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(redacted.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(redacted, /api_key=\[redacted\]/);
});

test("secret redaction masks connection credentials, private keys, and environment secrets", () => {
  const value = [
    "DATABASE_URL=postgres://user:password@db.example.test/app",
    "CLIENT_SECRET=do-not-log",
    "-----BEGIN PRIVATE KEY-----",
    "private-key-material",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  const redacted = redactTextSecrets(value);

  assert.equal(redacted.includes("user:password@"), false);
  assert.match(redacted, /postgres:\/\/\[redacted\]@db\.example\.test\/app/);
  assert.match(redacted, /CLIENT_SECRET=\[redacted\]/);
  assert.equal(redacted.includes("private-key-material"), false);
});

test("structured secret redaction masks sensitive property names and nested text", () => {
  const redacted = redactStructuredSecrets({
    api_key: "do-not-store-this",
    database_password: "do-not-store-this-either",
    details: { message: "password=do-not-store-this-either" },
  });

  assert.deepEqual(redacted, {
    api_key: "[redacted]",
    database_password: "[redacted]",
    details: { message: "password=[redacted]" },
  });
});
