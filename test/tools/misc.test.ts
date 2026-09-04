import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectTestClient, emptyList, isError, resultText } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  ctx = await connectTestClient();
});

afterEach(async () => {
  await ctx.close();
});

describe("invoice tools", () => {
  it("filters invoices by type and date range", async () => {
    ctx.erp.reply(emptyList());

    await ctx.client.callTool({
      name: "list_invoices",
      arguments: { type: "AR", date_from: "2026-01-01", date_to: "2026-03-31" },
    });

    const url = new URL(ctx.erp.requests[0].url);
    expect(url.searchParams.get("type")).toBe("AR");
    expect(url.searchParams.get("date_from")).toBe("2026-01-01");
  });

  it("only knows the two invoice types", async () => {
    const result = await ctx.client.callTool({ name: "list_invoices", arguments: { type: "XX" } });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("sums the amounts of the returned page", async () => {
    ctx.erp.reply({
      ...emptyList([{ total_amount: 1200 }, { total_amount: 800 }]),
    });

    const text = resultText(await ctx.client.callTool({ name: "list_invoices", arguments: {} }));

    expect(text).toMatch(/€\s?2\.000,00/);
  });

  it("describes a status change as from → to", async () => {
    ctx.erp.reply({
      invoice: { label: "AR-2026-001 (AR)" },
      changed: { status: { from: "draft", to: "sent" } },
    });

    const text = resultText(
      await ctx.client.callTool({
        name: "update_invoice_status",
        arguments: { invoice_id: 5, status: "sent" },
      }),
    );

    expect(text).toContain("AR-2026-001 (AR): draft → sent");
  });

  it("relays the ERP's refusal for incoming invoices", async () => {
    ctx.erp.reply(
      { error: "Nur Ausgangsrechnungen (AR) können über die API den Status wechseln" },
      422,
    );

    const result = await ctx.client.callTool({
      name: "update_invoice_status",
      arguments: { invoice_id: 5, status: "paid" },
    });

    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain("Nur Ausgangsrechnungen");
  });

  it("does not offer draft as a target status", async () => {
    const result = await ctx.client.callTool({
      name: "update_invoice_status",
      arguments: { invoice_id: 5, status: "draft" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });
});

describe("time entry tool", () => {
  it("sums the hours of the returned page", async () => {
    ctx.erp.reply(emptyList([{ hours: 4.5 }, { hours: 2 }]));

    const text = resultText(
      await ctx.client.callTool({ name: "list_time_entries", arguments: { project_id: 101 } }),
    );

    expect(text).toContain("6.50 h");
  });

  it("passes the ERP's filter requirement back to the caller", async () => {
    ctx.erp.reply(
      { error: "Mindestens employee_id, project_id oder ein date_from/date_to-Zeitraum ist erforderlich" },
      400,
    );

    const result = await ctx.client.callTool({ name: "list_time_entries", arguments: {} });

    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain("Mindestens employee_id");
  });
});

describe("expense tools", () => {
  it("reports the expense total with currency", async () => {
    ctx.erp.reply({ ...emptyList([{ id: 1 }]), total_amount: 150.5 });

    const text = resultText(
      await ctx.client.callTool({ name: "get_project_expenses", arguments: { project_id: 12 } }),
    );

    expect(text).toMatch(/€\s?150,50/);
  });

  it("requires a positive amount before contacting the ERP", async () => {
    const result = await ctx.client.callTool({
      name: "create_project_expense",
      arguments: { project_id: 12, employee_id: 7, amount: 0, category: "travel" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("only accepts the four expense categories", async () => {
    const result = await ctx.client.callTool({
      name: "create_project_expense",
      arguments: { project_id: 12, employee_id: 7, amount: 10, category: "bewirtung" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("posts an expense to the add action with the employee in the body", async () => {
    ctx.erp.reply({ expense: { amount: 89.9, category_label: "Reisekosten" } });

    await ctx.client.callTool({
      name: "create_project_expense",
      arguments: { project_id: 12, employee_id: 7, amount: 89.9, category: "travel" },
    });

    const request = ctx.erp.requests[0];
    expect(new URL(request.url).pathname).toBe("/api/projects/12/expenses/add");
    expect(request.body).toMatchObject({ employee_id: 7, amount: 89.9 });
  });
});

describe("reference data tools", () => {
  it("asks for budgets of one project", async () => {
    ctx.erp.reply(emptyList());

    await ctx.client.callTool({ name: "list_budgets", arguments: { project_id: 12 } });

    const url = new URL(ctx.erp.requests[0].url);
    expect(url.pathname).toBe("/api/budgets");
    expect(url.searchParams.get("project_id")).toBe("12");
  });

  it("lists cost centers without arguments", async () => {
    ctx.erp.reply(emptyList([{ id: 1, name: "Beratung" }]));

    const text = resultText(await ctx.client.callTool({ name: "list_cost_centers", arguments: {} }));

    expect(new URL(ctx.erp.requests[0].url).pathname).toBe("/api/cost-centers");
    expect(text).toContain("1 Kostenstellen");
  });

  it("passes the active filter as a boolean", async () => {
    ctx.erp.reply(emptyList());

    await ctx.client.callTool({ name: "list_employees", arguments: { is_active: true } });

    expect(new URL(ctx.erp.requests[0].url).searchParams.get("is_active")).toBe("true");
  });
});
