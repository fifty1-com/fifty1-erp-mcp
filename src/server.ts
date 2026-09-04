import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErpClient } from "./client.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerMiscTools } from "./tools/misc.js";

/**
 * Assembles the server and its tools. Kept apart from the executable entry
 * point so tests (and any other embedder) can build a server against a stubbed
 * ERP without the module deciding whether it was started from the command line
 * — that check is unreliable once npm installs the bin as a symlink.
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
