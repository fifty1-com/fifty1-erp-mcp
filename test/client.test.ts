import { describe, expect, it } from "vitest";
import { ErpClient, ErpError } from "../src/client.js";

/**
 * How an ERP answer becomes something the assistant can act on. The 422 case
 * carries the point: a business rule's own wording is the answer and must
 * survive untouched.
 */
describe("ErpClient error mapping", () => {
  function clientWith(status: number, body: unknown) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    return new ErpClient({ baseUrl: "https://erp.example.test/api", token: "t", fetchImpl });
  }

  it("names the config problem on 401", async () => {
    const client = clientWith(401, { error: "Invalid or expired API token" });

    await expect(client.get("/projects")).rejects.toThrowError(/FIFTY1_API_TOKEN/);
  });

  it("keeps the missing permission slug on 403", async () => {
    const client = clientWith(403, { error: "Permission denied: api.projects.controlling.read" });

    await expect(client.get("/projects")).rejects.toThrowError(/api\.projects\.controlling\.read/);
  });

  it("passes a business rule message through verbatim on 422", async () => {
    const message = "Status-Übergang von 'draft' nach 'paid' nicht erlaubt";
    const client = clientWith(422, { error: message });

    await expect(client.post("/invoices/1/status")).rejects.toThrowError(message);
  });

  it("suggests re-checking the id on 404", async () => {
    const client = clientWith(404, { error: "Projekt nicht gefunden" });

    await expect(client.get("/projects/9")).rejects.toThrowError(/Projekt nicht gefunden.*list_/s);
  });

  it("keeps validation details on 400", async () => {
    const client = clientWith(400, { error: "Feld 'employee_id' ist erforderlich", details: { field: "employee_id" } });

    await expect(client.post("/projects/1/team/add")).rejects.toMatchObject({
      status: 400,
      details: { field: "employee_id" },
    });
  });

  it("does not leak server internals on 500", async () => {
    const client = clientWith(500, { error: "SQLSTATE[42S22]: Unknown column 'foo'" });

    const error = await client.get("/projects").catch((e) => e as ErpError);

    expect(error.message).not.toContain("SQLSTATE");
    expect(error.message).toMatch(/ERP-Server-Fehler/);
  });

  it("reports an unreachable ERP instead of throwing a raw network error", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new ErpClient({ baseUrl: "https://erp.example.test/api", token: "t", fetchImpl });

    await expect(client.get("/projects")).rejects.toThrowError(/nicht erreichbar/);
  });
});

describe("ErpClient request building", () => {
  it("sends the bearer token and drops empty query parameters", async () => {
    let seenUrl = "";
    let seenAuth = "";

    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ErpClient({ baseUrl: "https://erp.example.test/api/", token: "abc", fetchImpl });
    await client.get("/projects", { status: "aktiv", q: undefined, customer_id: null, limit: 10 });

    expect(seenUrl).toBe("https://erp.example.test/api/projects?status=aktiv&limit=10");
    expect(seenAuth).toBe("Bearer abc");
  });
});
