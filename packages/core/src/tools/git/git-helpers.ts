export function isRiskyPath(file: string): boolean {
  if (/(^|\/)(\.env\.(example|sample|template))$/i.test(file)) return false;
  return (
    /(^|\/)(node_modules\/|\.env($|\.)|[^/]*\.env$|id_rsa$|id_ed25519$|cutebots-askpass-)/i.test(file) ||
    /\.(pem|key|p12|pfx)$/i.test(file)
  );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sameGitHubRepository(left: string, right: string): boolean {
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return null;
      return url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
    };
    const leftPath = normalize(left);
    return leftPath !== null && leftPath === normalize(right);
  } catch {
    return false;
  }
}
