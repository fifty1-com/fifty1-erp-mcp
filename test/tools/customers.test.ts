import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectTestClient, emptyList, isError, resultText } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  ctx = await connectTestClient();
});

afterEach(async () => {
  await ctx.close();
});

describe("customer tools", () => {
  it("searches customers by free text", async () => {
    ctx.erp.reply(emptyList());

    await ctx.client.callTool({ name: "list_customers", arguments: { q: "ACME" } });

    const url = new URL(ctx.erp.requests[0].url);
    expect(url.pathname).toBe("/api/customers");
    expect(url.searchParams.get("q")).toBe("ACME");
  });

  it("says how many contacts a customer has", async () => {
    ctx.erp.reply({ company: "ACME GmbH", contacts: [{ id: 1 }, { id: 2 }] });

    const text = resultText(
      await ctx.client.callTool({ name: "get_customer", arguments: { customer_id: 89 } }),
    );

    expect(text).toContain("ACME GmbH (2 Ansprechperson(en))");
  });

  it("makes a dedup hit unmistakable", async () => {
    ctx.erp.reply({ customer_matched: true, customer: { id: 89, company: "ACME GmbH" } });

    const text = resultText(
      await ctx.client.callTool({ name: "create_customer", arguments: { company: "acmegmbh" } }),
    );

    expect(text).toContain("Bestehender Kunde gefunden");
    expect(text).toContain("kein Duplikat angelegt");
  });

  it("reports a newly created customer as created", async () => {
    ctx.erp.reply({ customer_created: true, customer: { id: 90, company: "Neu GmbH" } });

    const text = resultText(
      await ctx.client.callTool({ name: "create_customer", arguments: { company: "Neu GmbH" } }),
    );

    expect(text).toContain("Kunde angelegt: Neu GmbH");
  });

  it("requires a company name", async () => {
    const result = await ctx.client.callTool({ name: "create_customer", arguments: { city: "Wien" } });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("rejects a country code that is not two letters", async () => {
    const result = await ctx.client.callTool({
      name: "create_customer",
      arguments: { company: "Test", country: "Österreich" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("posts a customer update to the action path", async () => {
    ctx.erp.reply({ customer: { company: "ACME GmbH" } });

    await ctx.client.callTool({
      name: "update_customer",
      arguments: { customer_id: 89, city: "Salzburg" },
    });

    const request = ctx.erp.requests[0];
    expect(new URL(request.url).pathname).toBe("/api/customers/89/update");
    expect(request.body).toEqual({ city: "Salzburg" });
  });
});

describe("create_lead", () => {
  it("posts to the existing lead endpoint", async () => {
    ctx.erp.reply({ project: { project_number: "P-2026-4711", name: "Website Redesign" } });

    await ctx.client.callTool({
      name: "create_lead",
      arguments: { name: "Website Redesign", customer_id: 42 },
    });

    const request = ctx.erp.requests[0];
    expect(new URL(request.url).pathname).toBe("/api/projects/leads");
    expect(request.body).toEqual({ name: "Website Redesign", customer_id: 42 });
  });

  it("reports which dedup branch the ERP took", async () => {
    ctx.erp.reply({
      project: { project_number: "P-2026-4711", name: "Website Redesign" },
      customer_matched: true,
      customer: { company: "ACME GmbH" },
      contact_created: true,
    });

    const text = resultText(
      await ctx.client.callTool({
        name: "create_lead",
        arguments: { name: "Website Redesign", customer: { company: "ACME GmbH" } },
      }),
    );

    expect(text).toContain("Bestehender Kunde zugeordnet: ACME GmbH");
    expect(text).toContain("Ansprechperson neu angelegt");
  });

  it("passes a nested customer with contact through unchanged", async () => {
    ctx.erp.reply({ project: { project_number: "P-1", name: "Neu" } });

    await ctx.client.callTool({
      name: "create_lead",
      arguments: {
        name: "Neu",
        customer: {
          company: "ACME GmbH",
          email: "kontakt@acme.at",
          contact: { first_name: "Max", last_name: "Mustermann" },
        },
      },
    });

    expect(ctx.erp.requests[0].body).toMatchObject({
      customer: { company: "ACME GmbH", contact: { first_name: "Max" } },
    });
  });

  it("requires a project name", async () => {
    const result = await ctx.client.callTool({ name: "create_lead", arguments: { customer_id: 42 } });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });
});
