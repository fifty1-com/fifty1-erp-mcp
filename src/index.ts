#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErpClient } from "./client.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerMiscTools } from "./tools/misc.js";

/**
 * MCP server for the fifty1 ERP. Talks to public/api.php with a service token,
 * over stdio, so it runs locally next to the client (Claude Desktop / Claude
 * Code) and needs nothing deployed on the ERP host.
 *
 * stdout belongs to the MCP protocol — every diagnostic goes to stderr.
 */
export function createServer(client: ErpClient): McpServer {
  const server = new McpServer({
    name: "fifty1-erp",
    version: "1.0.0",
  });

  registerProjectTools(server, client);
  registerCustomerTools(server, client);
  registerInvoiceTools(server, client);
  registerMiscTools(server, client);

  return server;
}

function readConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.FIFTY1_API_BASE_URL;
  const token = process.env.FIFTY1_API_TOKEN;

  if (!baseUrl || !token) {
    console.error(
      "fifty1-erp-mcp: FIFTY1_API_BASE_URL und FIFTY1_API_TOKEN müssen gesetzt sein.\n" +
        "Beispiel:\n" +
        "  FIFTY1_API_BASE_URL=https://erp.fifty1.com/api\n" +
        "  FIFTY1_API_TOKEN=<Service-Token aus Einstellungen → API Tokens>",
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

const isEntrypoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  main().catch((error) => {
    console.error("fifty1-erp-mcp konnte nicht starten:", error);
    process.exit(1);
  });
}
