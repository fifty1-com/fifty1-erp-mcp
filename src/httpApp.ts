import type { ErrorRequestHandler, Express, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { ErpTokenVerifier } from "./auth/erpTokenVerifier.js";
import { ErpClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * The remote (Streamable HTTP) face of the server, for connectors such as
 * claude.ai or ChatGPT that can only reach MCP over HTTPS with OAuth.
 *
 * The ERP is the authorization server and also publishes the RFC 9728
 * protected-resource metadata, so this app only has to verify bearer tokens
 * and point unauthenticated clients at that metadata URL.
 *
 * Every request is handled statelessly with its own McpServer bound to the
 * caller's token: the ERP then applies exactly that employee's permissions,
 * and nothing about one user can leak into another user's request. Being
 * stateless also means no session affinity is needed behind the proxy.
 */

export interface HttpAppOptions {
  /** Public URL of the MCP endpoint (the token audience), e.g. https://erp.fifty1.com/mcp */
  publicUrl: URL;
  /** Base URL of the ERP API, e.g. https://erp.fifty1.com/api */
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  verifier?: OAuthTokenVerifier;
}

const REQUIRED_SCOPE = "mcp";

export function createHttpApp(options: HttpAppOptions): Express {
  const { publicUrl, apiBaseUrl, fetchImpl } = options;
  const mcpPath = publicUrl.pathname;

  // DNS-rebinding protection: only the public host (Apache forwards it with
  // ProxyPreserveHost On) and loopback names for health checks on the box.
  // Hostnames without port — the SDK middleware compares hostnames only.
  const app = createMcpExpressApp({
    allowedHosts: [...new Set([publicUrl.hostname, "localhost", "127.0.0.1", "[::1]"])],
  });

  const verifier =
    options.verifier ??
    new ErpTokenVerifier({ apiBaseUrl, resource: publicUrl, fetchImpl });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post(
    mcpPath,
    requireBearerAuth({
      verifier,
      requiredScopes: [REQUIRED_SCOPE],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(publicUrl),
    }),
    async (req, res) => {
      const server = createServer(
        new ErpClient({
          baseUrl: apiBaseUrl,
          // requireBearerAuth only calls next() once req.auth is set.
          token: req.auth!.token,
          credential: "oauth",
          fetchImpl,
        }),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error("fifty1-erp-mcp: Fehler bei MCP-Anfrage:", error);
        if (!res.headersSent) {
          jsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
    },
  );

  // Stateless mode has no server-initiated SSE stream (GET) and no session to
  // end (DELETE); the spec wants 405 for both rather than a 404.
  app.all(mcpPath, (_req, res) => {
    res.set("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed.");
  });

  app.use(errorHandler);

  return app;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * express.json() rejects unparsable bodies before any route runs; without this
 * the client would get express's HTML error page instead of JSON-RPC.
 */
const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const type = (error as { type?: string } | null)?.type;
  if (type === "entity.parse.failed") {
    jsonRpcError(res, 400, -32700, "Parse error");
    return;
  }

  // Other body-parser rejections (413 too large, 415 charset) keep their status.
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    jsonRpcError(res, status, -32600, "Invalid request");
    return;
  }

  console.error("fifty1-erp-mcp: unerwarteter Fehler:", error);
  jsonRpcError(res, 500, -32603, "Internal server error");
};
