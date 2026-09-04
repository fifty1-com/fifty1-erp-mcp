#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErpClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * Executable entry point of the MCP server. Talks to public/api.php with an API
 * token, over stdio, so it runs locally next to the client (Claude Desktop /
 * Claude Code) and needs nothing deployed on the ERP host.
 *
 * This module always starts the server: it is only ever loaded as the bin,
 * which npm installs as a symlink — comparing import.meta.url against argv[1]
 * to detect "am I the entry point" silently fails in exactly that case.
 * Everything importable lives in server.ts.
 *
 * stdout belongs to the MCP protocol — every diagnostic goes to stderr.
 */
function readConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.FIFTY1_API_BASE_URL;
  const token = process.env.FIFTY1_API_TOKEN;

  if (!baseUrl || !token) {
    console.error(
      "fifty1-erp-mcp: FIFTY1_API_BASE_URL und FIFTY1_API_TOKEN müssen gesetzt sein.\n" +
        "Beispiel:\n" +
        "  FIFTY1_API_BASE_URL=https://erp.fifty1.com/api\n" +
        "  FIFTY1_API_TOKEN=<Token aus dem ERP: Profil → API-Tokens>",
    );
    process.exit(1);
  }

  return { baseUrl, token };
}

async function main(): Promise<void> {
  const { baseUrl, token } = readConfig();
  const server = createServer(new ErpClient({ baseUrl, token }));

  await server.connect(new StdioServerTransport());
  console.error(`fifty1-erp-mcp verbunden (ERP: ${baseUrl})`);
}

main().catch((error) => {
  console.error("fifty1-erp-mcp konnte nicht starten:", error);
  process.exit(1);
});
