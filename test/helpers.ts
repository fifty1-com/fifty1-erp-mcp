import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErpClient } from "../src/client.js";
import { createServer } from "../src/server.js";

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface ErpStub {
  /** Every request the tools made, in order. */
  requests: RecordedRequest[];
  /** Queue a response for the next request. */
  reply(body: unknown, status?: number): void;
}

/**
 * Boots the real MCP server against a stubbed ERP, connected through the SDK's
 * in-memory transport — so a test exercises tool registration, input validation
 * and the response mapping exactly as a real client would.
 */
export async function connectTestClient(): Promise<{
  client: Client;
  erp: ErpStub;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const queued: { body: unknown; status: number }[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    });

    const next = queued.shift() ?? { body: {}, status: 200 };

    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const erpClient = new ErpClient({
    baseUrl: "https://erp.example.test/api",
    token: "test-token",
    fetchImpl,
  });

  const server = createServer(erpClient);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    erp: {
      requests,
      reply(body: unknown, status = 200) {
        queued.push({ body, status });
      },
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The text a tool answered with (the summary plus the JSON payload). */
export function resultText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];

  return content.map((part) => part.text ?? "").join("\n");
}

export function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

export function emptyList(items: unknown[] = []) {
  return {
    items,
    total: items.length,
    returned: items.length,
    limit: 25,
    offset: 0,
    has_more: false,
  };
}
