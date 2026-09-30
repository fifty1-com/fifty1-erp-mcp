/**
 * Configuration of the remote HTTP server, read from the environment. Kept out
 * of the executable module so it can be tested without starting a server.
 * Errors carry the German message the operator sees on startup.
 */

export interface HttpConfig {
  publicUrl: URL;
  apiBaseUrl: string;
  port: number;
  host: string;
}

export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpConfigError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function readHttpConfig(env: Record<string, string | undefined>): HttpConfig {
  const publicUrlRaw = env.MCP_PUBLIC_URL?.trim();
  const apiBaseUrl = env.FIFTY1_API_BASE_URL?.trim();

  if (!publicUrlRaw || !apiBaseUrl) {
    throw new HttpConfigError(
      "MCP_PUBLIC_URL und FIFTY1_API_BASE_URL müssen gesetzt sein.\n" +
        "Beispiel:\n" +
        "  MCP_PUBLIC_URL=https://erp.fifty1.com/mcp\n" +
        "  FIFTY1_API_BASE_URL=https://erp.fifty1.com/api",
    );
  }

  return {
    publicUrl: parsePublicUrl(publicUrlRaw),
    apiBaseUrl: parseApiBaseUrl(apiBaseUrl),
    port: parsePort(env.PORT),
    host: env.HOST?.trim() || "127.0.0.1",
  };
}

/**
 * The public URL is the token audience: it has to match, character for
 * character (modulo a trailing slash), what the ERP writes into the tokens.
 */
function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpConfigError(`MCP_PUBLIC_URL ist keine gültige URL: ${raw}`);
  }

  if (url.search || url.hash) {
    throw new HttpConfigError(
      `MCP_PUBLIC_URL darf weder Query noch Fragment enthalten: ${raw}`,
    );
  }

  // Bearer tokens over plain http are only acceptable on the local machine.
  const isLocal = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new HttpConfigError(
      `MCP_PUBLIC_URL muss https verwenden (http nur für localhost): ${raw}`,
    );
  }

  return url;
}

function parseApiBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error();
    }
  } catch {
    throw new HttpConfigError(`FIFTY1_API_BASE_URL ist keine gültige http(s)-URL: ${raw}`);
  }

  return raw.replace(/\/+$/, "");
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 3030;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpConfigError(`PORT muss eine Zahl zwischen 1 und 65535 sein: ${raw}`);
  }

  return port;
}
