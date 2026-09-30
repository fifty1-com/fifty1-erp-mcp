import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createHttpApp } from "../src/httpApp.js";
import type { RecordedRequest } from "./helpers.js";

/**
 * The remote mode end to end, minus the network: a real express app, the real
 * bearer middleware and verifier, the real MCP server — only the ERP is a
 * stubbed fetch that answers tokeninfo and the tool endpoints.
 */

const PUBLIC_URL = new URL("https://erp.fifty1.com/mcp");
const API_BASE = "https://erp.fifty1.com/api";
const METADATA_URL = "https://erp.fifty1.com/.well-known/oauth-protected-resource/mcp";
const VALID_TOKEN = "f51oa_" + "v".repeat(43);
const HOST = "erp.fifty1.com";
const ACCEPT = "application/json, text/event-stream";

function stubErp() {
  const requests: RecordedRequest[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    });

    if (String(url) === `${API_BASE}/oauth/tokeninfo`) {
      if (headers.Authorization !== `Bearer ${VALID_TOKEN}`) {
        return json({ error: "invalid_token", error_description: "Unknown token" }, 401);
      }
      return json({
        active: true,
        sub: "42",
        client_id: "claude",
        scope: "mcp",
        aud: PUBLIC_URL.href,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    }

    if (String(url) === `${API_BASE}/cost-centers`) {
      return json({
        items: [{ id: 1, code: "100", name: "Beratung", active: true }],
        total: 1,
        returned: 1,
        limit: 25,
        offset: 0,
        has_more: false,
      });
    }

    return json({ error: "Not found" }, 404);
  }) as unknown as typeof fetch;

  return { requests, fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

const initializeParams = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

describe("remote HTTP app", () => {
  let erp: ReturnType<typeof stubErp>;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    erp = stubErp();
    app = createHttpApp({ publicUrl: PUBLIC_URL, apiBaseUrl: API_BASE, fetchImpl: erp.fetchImpl });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function post(body: unknown, token: string | null = VALID_TOKEN) {
    const req = request(app).post("/mcp").set("Host", HOST).set("Accept", ACCEPT);
    return (token ? req.set("Authorization", `Bearer ${token}`) : req).send(body as object);
  }

  it("derives the metadata URL the ERP serves from the public MCP URL", () => {
    expect(getOAuthProtectedResourceMetadataUrl(PUBLIC_URL)).toBe(METADATA_URL);
  });

  it("challenges a request without token and points at the resource metadata", async () => {
    const res = await post(rpc("initialize", initializeParams), null);

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(res.headers["www-authenticate"]).toMatch(/^Bearer /);
    expect(erp.requests).toHaveLength(0);
  });

  it("rejects an unknown token with invalid_token", async () => {
    const res = await post(rpc("initialize", initializeParams), "f51oa_unknown");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["www-authenticate"]).toContain('error="invalid_token"');
    expect(res.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it("answers 500, not 401, when the ERP cannot verify tokens", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    app = createHttpApp({ publicUrl: PUBLIC_URL, apiBaseUrl: API_BASE, fetchImpl: failing });

    const res = await post(rpc("initialize", initializeParams));

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("server_error");
  });

  it("initializes with a valid token", async () => {
    const res = await post(rpc("initialize", initializeParams));

    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe("fifty1-erp");
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("lists the tools without a prior initialize, since every request stands alone", async () => {
    const res = await post(rpc("tools/list"));

    expect(res.status).toBe(200);
    const names = (res.body.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_projects", "list_cost_centers"]));
  });

  it("forwards the caller's own bearer token to the ERP on a tool call", async () => {
    const res = await post(rpc("tools/call", { name: "list_cost_centers", arguments: {} }));

    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    expect(JSON.stringify(res.body.result.content)).toContain("Beratung");

    const toolCall = erp.requests.find((r) => r.url === `${API_BASE}/cost-centers`);
    expect(toolCall?.headers.Authorization).toBe(`Bearer ${VALID_TOKEN}`);
  });

  it("verifies a token only once across requests thanks to the cache", async () => {
    await post(rpc("tools/list"));
    await post(rpc("tools/list"));

    const tokeninfoCalls = erp.requests.filter((r) => r.url.endsWith("/oauth/tokeninfo"));
    expect(tokeninfoCalls).toHaveLength(1);
  });

  it("insists on the Streamable HTTP Accept header", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Host", HOST)
      .set("Accept", "application/json")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send(rpc("tools/list"));

    expect(res.status).toBe(406);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Host", HOST)
      .set("Accept", ACCEPT)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32700);
  });

  it("refuses a foreign Host header (DNS rebinding)", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Host", "evil.example")
      .set("Accept", ACCEPT)
      .set("Authorization", `Bearer ${VALID_TOKEN}`)
      .send(rpc("tools/list"));

    expect(res.status).toBe(403);
    expect(erp.requests).toHaveLength(0);
  });

  it("accepts local Host headers so the health check works on the box itself", async () => {
    const res = await request(app).get("/healthz").set("Host", "127.0.0.1:3030");

    expect(res.status).toBe(200);
  });

  it.each(["get", "delete"] as const)("rejects %s on the MCP path with 405", async (method) => {
    const res = await request(app)[method]("/mcp").set("Host", HOST);

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.body).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
  });

  it("reports health without authentication", async () => {
    const res = await request(app).get("/healthz").set("Host", HOST);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("uses an injected verifier instead of asking the ERP", async () => {
    const verifier = {
      verifyAccessToken: vi.fn(async (token: string) => ({
        token,
        clientId: "injected",
        scopes: ["mcp"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      })),
    };
    app = createHttpApp({
      publicUrl: PUBLIC_URL,
      apiBaseUrl: API_BASE,
      fetchImpl: erp.fetchImpl,
      verifier,
    });

    const res = await post(rpc("tools/list"), "anything");

    expect(res.status).toBe(200);
    expect(verifier.verifyAccessToken).toHaveBeenCalledWith("anything");
    expect(erp.requests).toHaveLength(0);
  });

  it("refuses a token without the mcp scope", async () => {
    const verifier = {
      verifyAccessToken: async (token: string) => ({
        token,
        clientId: "other",
        scopes: ["profile"],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      }),
    };
    app = createHttpApp({ publicUrl: PUBLIC_URL, apiBaseUrl: API_BASE, verifier });

    const res = await post(rpc("tools/list"));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("insufficient_scope");
  });

  it("works with the SDK's own Streamable HTTP client end to end", async () => {
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
    const { port } = listener.address() as AddressInfo;

    const client = new Client({ name: "sdk-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${VALID_TOKEN}` } },
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const result = await client.callTool({ name: "list_cost_centers", arguments: {} });

      expect(tools.length).toBeGreaterThan(10);
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});
