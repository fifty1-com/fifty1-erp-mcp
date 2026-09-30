import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErpTokenVerifier } from "../src/auth/erpTokenVerifier.js";

/**
 * The verifier decides which of two very different things a client sees when a
 * token does not work: a 401 (log in again) or a 500 (the ERP has a problem).
 * Mixing them up either locks users out or sends them into an endless re-login
 * loop while the ERP is down — so every branch is pinned here.
 */

const RESOURCE = "https://erp.fifty1.com/mcp";
const TOKEN = "f51oa_" + "a".repeat(43);
const NOW_MS = 1_780_000_000_000;
const NOW_S = NOW_MS / 1000;

interface Call {
  url: string;
  authorization: string | undefined;
}

function tokeninfo(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    sub: "42",
    client_id: "abc",
    scope: "mcp",
    aud: RESOURCE,
    exp: NOW_S + 3600,
    ...overrides,
  };
}

function setup(
  respond: (call: Call) => Response | Promise<Response>,
  options: { cacheTtlMs?: number; maxCacheEntries?: number } = {},
) {
  const calls: Call[] = [];
  let now = NOW_MS;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(url), authorization: headers.Authorization };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;

  const verifier = new ErpTokenVerifier({
    apiBaseUrl: "https://erp.fifty1.com/api/",
    resource: RESOURCE,
    fetchImpl,
    now: () => now,
    ...options,
  });

  return {
    verifier,
    calls,
    advance(ms: number) {
      now += ms;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ErpTokenVerifier", () => {
  // Server-side failures are logged for the operator; keep the test output clean.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the ERP tokeninfo endpoint with the token as bearer and maps the answer", async () => {
    const { verifier, calls } = setup(() => json(tokeninfo({ scope: "mcp profile" })));

    const info = await verifier.verifyAccessToken(TOKEN);

    expect(calls).toEqual([
      { url: "https://erp.fifty1.com/api/oauth/tokeninfo", authorization: `Bearer ${TOKEN}` },
    ]);
    expect(info).toEqual({
      token: TOKEN,
      clientId: "abc",
      scopes: ["mcp", "profile"],
      expiresAt: NOW_S + 3600,
      resource: new URL(RESOURCE),
      extra: { employeeId: "42" },
    });
  });

  it("rejects a token the ERP answers with 401", async () => {
    const { verifier } = setup(() =>
      json({ error: "invalid_token", error_description: "Token expired" }, 401),
    );

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a token the ERP reports as inactive", async () => {
    const { verifier } = setup(() => json({ active: false }));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a tokeninfo answer that lacks the fields a session needs", async () => {
    const { verifier } = setup(() => json(tokeninfo({ exp: undefined })));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a token that is already past its expiry", async () => {
    const { verifier } = setup(() => json(tokeninfo({ exp: NOW_S - 1 })));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a token issued for another resource", async () => {
    const { verifier } = setup(() => json(tokeninfo({ aud: "https://evil.example/mcp" })));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toThrowError(InvalidTokenError);
  });

  it("rejects a token without any audience", async () => {
    const { verifier } = setup(() => json(tokeninfo({ aud: undefined })));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("accepts the audience with a trailing slash", async () => {
    const { verifier } = setup(() => json(tokeninfo({ aud: `${RESOURCE}/` })));

    await expect(verifier.verifyAccessToken(TOKEN)).resolves.toMatchObject({ clientId: "abc" });
  });

  it("accepts an audience list that contains this resource", async () => {
    const { verifier } = setup(() =>
      json(tokeninfo({ aud: ["https://other.example/api", RESOURCE] })),
    );

    const info = await verifier.verifyAccessToken(TOKEN);

    expect(info.resource).toEqual(new URL(RESOURCE));
  });

  it("rejects an audience list without this resource", async () => {
    const { verifier } = setup(() => json(tokeninfo({ aud: ["https://other.example/api"] })));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("reports an ERP server error as a server error, not as a bad token", async () => {
    const { verifier } = setup(() => json({ error: "boom" }, 503));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(ServerError);
  });

  it("reports an unreachable ERP as a server error", async () => {
    const { verifier } = setup(() => {
      throw new TypeError("fetch failed");
    });

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(ServerError);
  });

  it("answers repeated checks of the same token from the cache", async () => {
    const { verifier, calls, advance } = setup(() => json(tokeninfo()));

    await verifier.verifyAccessToken(TOKEN);
    advance(30_000);
    await verifier.verifyAccessToken(TOKEN);

    expect(calls).toHaveLength(1);
  });

  it("asks again once the cache TTL has passed", async () => {
    const { verifier, calls, advance } = setup(() => json(tokeninfo()), { cacheTtlMs: 60_000 });

    await verifier.verifyAccessToken(TOKEN);
    advance(60_001);
    await verifier.verifyAccessToken(TOKEN);

    expect(calls).toHaveLength(2);
  });

  it("never serves a cached entry past the token's own expiry", async () => {
    let exp = NOW_S + 10;
    const { verifier, calls, advance } = setup(() => json(tokeninfo({ exp })));

    await verifier.verifyAccessToken(TOKEN);
    advance(11_000);
    exp = NOW_S - 1; // the ERP now reports it as expired
    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);

    expect(calls).toHaveLength(2);
  });

  it("does not cache failures", async () => {
    let status = 503;
    const { verifier, calls } = setup(() => (status === 200 ? json(tokeninfo()) : json({}, status)));

    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(ServerError);
    status = 401;
    await expect(verifier.verifyAccessToken(TOKEN)).rejects.toBeInstanceOf(InvalidTokenError);
    status = 200;
    await expect(verifier.verifyAccessToken(TOKEN)).resolves.toMatchObject({ clientId: "abc" });

    expect(calls).toHaveLength(3);
  });

  it("keeps different tokens apart in the cache", async () => {
    const { verifier, calls } = setup(({ authorization }) =>
      json(tokeninfo({ sub: authorization?.endsWith("b") ? "7" : "42" })),
    );

    const first = await verifier.verifyAccessToken(TOKEN);
    const second = await verifier.verifyAccessToken(TOKEN.slice(0, -1) + "b");

    expect(first.extra).toEqual({ employeeId: "42" });
    expect(second.extra).toEqual({ employeeId: "7" });
    expect(calls).toHaveLength(2);
  });

  it("evicts the oldest entry once the cache is full", async () => {
    const { verifier, calls } = setup(() => json(tokeninfo()), { maxCacheEntries: 2 });

    await verifier.verifyAccessToken("token-1");
    await verifier.verifyAccessToken("token-2");
    await verifier.verifyAccessToken("token-3"); // pushes token-1 out
    await verifier.verifyAccessToken("token-3");
    await verifier.verifyAccessToken("token-1");

    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-3",
      "Bearer token-1",
    ]);
  });
});
