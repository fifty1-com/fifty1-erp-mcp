import { createHash } from "node:crypto";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Checks OAuth access tokens against the ERP, which is the authorization
 * server: the ERP issued the token, so only the ERP can say whether it is still
 * valid (not revoked, not expired, issued for this MCP server).
 *
 * The one distinction that matters for clients: InvalidTokenError becomes a
 * 401 and makes the client start a new login; ServerError becomes a 500. An
 * unreachable or failing ERP must end up as the latter — answering 401 there
 * would send every connected client into a re-login loop during an outage.
 *
 * Error messages end up in the WWW-Authenticate header, so they stay ASCII and
 * free of double quotes.
 */

export interface ErpTokenVerifierOptions {
  /** Base URL of the ERP API, e.g. https://erp.fifty1.com/api */
  apiBaseUrl: string;
  /** This MCP server's resource URL — the audience the token must be issued for. */
  resource: URL | string;
  fetchImpl?: typeof fetch;
  /** How long a positive answer is reused. Bounds how late a revocation takes effect. */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  timeoutMs?: number;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

interface TokenInfo {
  active?: unknown;
  sub?: unknown;
  client_id?: unknown;
  scope?: unknown;
  aud?: unknown;
  exp?: unknown;
}

interface CacheEntry {
  info: AuthInfo;
  validUntilMs: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

export class ErpTokenVerifier implements OAuthTokenVerifier {
  private readonly tokeninfoUrl: string;
  private readonly resource: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  // Map keeps insertion order, which makes "evict the oldest" a keys().next().
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: ErpTokenVerifierOptions) {
    this.tokeninfoUrl = `${options.apiBaseUrl.replace(/\/+$/, "")}/oauth/tokeninfo`;
    this.resource = normalizeResource(String(options.resource));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Keyed by hash so the cache never holds usable bearer tokens as keys.
    const key = createHash("sha256").update(token).digest("hex");
    const cached = this.cache.get(key);

    if (cached) {
      if (cached.validUntilMs > this.now()) {
        return cached.info;
      }
      this.cache.delete(key);
    }

    const info = this.toAuthInfo(token, await this.fetchTokenInfo(token));
    this.remember(key, info);

    return info;
  }

  private async fetchTokenInfo(token: string): Promise<TokenInfo> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.tokeninfoUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      console.error(
        "fifty1-erp-mcp: tokeninfo nicht erreichbar:",
        error instanceof Error ? error.message : String(error),
      );
      throw new ServerError("Authorization server unreachable");
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text().catch(() => "");
    const body = parseObject(text);

    if (response.status === 401 || body?.error === "invalid_token") {
      throw new InvalidTokenError("Token is invalid, expired or revoked");
    }

    if (!response.ok) {
      // A 404 here means a wrong FIFTY1_API_BASE_URL, a 5xx an ERP problem —
      // neither is fixed by logging in again.
      console.error(`fifty1-erp-mcp: tokeninfo antwortete mit HTTP ${response.status}`);
      throw new ServerError("Authorization server error");
    }

    if (!body) {
      throw new InvalidTokenError("Malformed token information");
    }

    return body;
  }

  private toAuthInfo(token: string, body: TokenInfo): AuthInfo {
    if (body.active !== true) {
      throw new InvalidTokenError("Token is not active");
    }

    const { client_id: clientId, sub, exp, scope } = body;

    if (
      typeof clientId !== "string" ||
      (typeof sub !== "string" && typeof sub !== "number") ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      (scope !== undefined && typeof scope !== "string")
    ) {
      throw new InvalidTokenError("Malformed token information");
    }

    if (exp * 1000 <= this.now()) {
      throw new InvalidTokenError("Token has expired");
    }

    const audience = this.matchAudience(body.aud);

    return {
      token,
      clientId,
      scopes: typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : [],
      expiresAt: exp,
      resource: new URL(audience),
      extra: { employeeId: String(sub) },
    };
  }

  /**
   * RFC 8707: a token minted for another resource must not be accepted here,
   * even if the same ERP issued it — otherwise a token handed to some other
   * integration could be replayed against this server.
   */
  private matchAudience(aud: unknown): string {
    const candidates = Array.isArray(aud) ? aud : [aud];
    const match = candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && normalizeResource(candidate) === this.resource,
    );

    if (!match) {
      throw new InvalidTokenError("Token was not issued for this resource");
    }

    return match;
  }

  private remember(key: string, info: AuthInfo): void {
    const validUntilMs = Math.min(this.now() + this.cacheTtlMs, (info.expiresAt ?? 0) * 1000);

    this.cache.delete(key);
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    this.cache.set(key, { info, validUntilMs });
  }
}

function normalizeResource(resource: string): string {
  return resource.replace(/\/+$/, "");
}

function parseObject(text: string): (TokenInfo & { error?: unknown }) | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TokenInfo & { error?: unknown })
      : null;
  } catch {
    return null;
  }
}
