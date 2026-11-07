const KEY_NAMES = [
  "api_key",
  "access_token",
  "token",
  "secret",
  "password",
  "authorization",
] as const;

const TOKEN_PREFIXES = [
  "ghp_",
  "gho_",
  "github_pat_",
  "sk-",
  "AKIA",
  "tvly_",
  "gsk_"
] as const;

const TOKEN_CONTINUATION_CHARS = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("")
);

export function redactTextSecrets(input: string): string {
  let out = redactPrivateKeyBlocks(input);
  out = redactUrlCredentials(out);
  out = redactKeyValuePairs(out);
  out = redactBearerTokens(out);
  out = redactKnownTokenPatterns(out);
  return out;
}

function redactPrivateKeyBlocks(text: string): string {
  let result = text;
  let cursor = 0;

  while (cursor < result.length) {
    const beginIndex = result.indexOf("-----BEGIN ", cursor);
    if (beginIndex < 0) break;

    const keyIndex = result.indexOf("PRIVATE KEY-----", beginIndex);
    if (keyIndex < 0) break;

    const endBegin = result.indexOf("-----END ", keyIndex);
    if (endBegin < 0) break;

    const blockEnd = result.indexOf("-----", endBegin + "-----END ".length);
    if (blockEnd < 0) break;

    const replacement = "[redacted private key]";
    result =
      result.slice(0, beginIndex) +
      replacement +
      result.slice(blockEnd + "-----".length);

    cursor = beginIndex + replacement.length;
  }

  return result;
}

function redactUrlCredentials(text: string): string {
  let result = text;
  let cursor = 0;

  while (cursor < result.length) {
    const schemeIndex = result.indexOf("://", cursor);
    if (schemeIndex < 0) break;

    const credentialsStart = schemeIndex + 3;
    const atIndex = result.indexOf("@", credentialsStart);
    if (atIndex < 0) {
      cursor = credentialsStart;
      continue;
    }

    const colonIndex = result.lastIndexOf(":", atIndex);
    if (colonIndex < credentialsStart) {
      cursor = atIndex + 1;
      continue;
    }

    const username = result.slice(credentialsStart, colonIndex);
    if (username.length === 0) {
      cursor = atIndex + 1;
      continue;
    }

    result =
      result.slice(0, credentialsStart) +
      "[redacted]" +
      result.slice(atIndex);

    cursor = credentialsStart + "[redacted]".length;
  }

  return result;
}

function redactKeyValuePairs(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const lower = line.toLowerCase();

      for (const key of KEY_NAMES) {
        const keyIndex = lower.indexOf(key);
        if (keyIndex < 0) continue;

        const remainder = line.slice(keyIndex + key.length);
        const separatorIndex = findSeparatorIndex(remainder);
        if (separatorIndex < 0) continue;

        const valueStart = keyIndex + key.length + separatorIndex;
        const valueEntry = line.slice(valueStart);
        const valueEnd = findValueEnd(valueEntry);

        if (valueEnd <= 0) continue;

        return (
          line.slice(0, valueStart) +
          "[redacted]" +
          valueEntry.slice(valueEnd)
        );
      }

      return line;
    })
    .join("\n");
}

function findSeparatorIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ":" || ch === "=") {
      const before = text.slice(0, i).trim();
      if (before.length === 0) {
        return i + 1;
      }
      return i + 1;
    }
  }
  return -1;
}

function findValueEnd(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (!ch) continue;

    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\n" ||
      ch === "\r" ||
      ch === "," ||
      ch === ";" ||
      ch === "}" ||
      ch === "]"
    ) {
      return i;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const quoteIndex = value.indexOf(quote, i + 1);
      if (quoteIndex >= 0) {
        return quoteIndex + 1;
      }
    }
  }

  return value.length;
}

function redactBearerTokens(text: string): string {
  let result = text;
  let cursor = 0;

  while (cursor < result.length) {
    const prefixIndex = result.indexOf("Bearer ", cursor);
    if (prefixIndex < 0) break;

    const tokenStart = prefixIndex + "Bearer ".length;
    let tokenEnd = tokenStart;

    while (tokenEnd < result.length) {
      const ch = result[tokenEnd];
      if (!ch || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "," || ch === ";") {
        break;
      }
      tokenEnd += 1;
    }

    if (tokenEnd > tokenStart) {
      result =
        result.slice(0, tokenStart) +
        "[redacted]" +
        result.slice(tokenEnd);

      cursor = tokenStart + "[redacted]".length;
    } else {
      cursor = tokenStart;
    }
  }

  return result;
}

function redactKnownTokenPatterns(text: string): string {
  let result = text;
  let cursor = 0;

  while (cursor < result.length) {
    let nextIndex = -1;
    let nextPrefix = "";

    for (const prefix of TOKEN_PREFIXES) {
      const index = result.indexOf(prefix, cursor);
      if (index >= 0 && (nextIndex < 0 || index < nextIndex)) {
        nextIndex = index;
        nextPrefix = prefix;
      }
    }

    if (nextIndex < 0 || nextPrefix.length === 0) break;

    let tokenEnd = nextIndex + nextPrefix.length;
    while (tokenEnd < result.length && TOKEN_CONTINUATION_CHARS.has(result[tokenEnd]!)) {
      tokenEnd += 1;
    }

    if (tokenEnd > nextIndex + nextPrefix.length) {
      result =
        result.slice(0, nextIndex) +
        "[redacted]" +
        result.slice(tokenEnd);

      cursor = nextIndex + "[redacted]".length;
    } else {
      cursor = nextIndex + nextPrefix.length;
    }
  }

  return result;
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}