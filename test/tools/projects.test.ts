import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectTestClient, emptyList, isError, resultText } from "../helpers.js";

let ctx: Awaited<ReturnType<typeof connectTestClient>>;

beforeEach(async () => {
  ctx = await connectTestClient();
});

afterEach(async () => {
  await ctx.close();
});

describe("project tools", () => {
  it("registers every project tool", async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "list_projects",
        "get_project",
        "update_project",
        "get_project_controlling",
        "get_project_team",
        "add_project_team_member",
        "update_project_team_member",
        "remove_project_team_member",
        "get_project_milestones",
        "create_project_milestone",
        "update_project_milestone",
        "get_project_resource_planning",
        "set_project_resource_planning",
        "delete_project_resource_planning",
      ]),
    );
  });

  it("passes list filters through as query parameters", async () => {
    ctx.erp.reply(emptyList());

    await ctx.client.callTool({
      name: "list_projects",
      arguments: { status: "aktiv", customer_id: 42, limit: 10 },
    });

    const url = new URL(ctx.erp.requests[0].url);
    expect(url.pathname).toBe("/api/projects");
    expect(url.searchParams.get("status")).toBe("aktiv");
    expect(url.searchParams.get("customer_id")).toBe("42");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("tells the caller when more rows exist", async () => {
    ctx.erp.reply({
      items: [{ label: "P-1 — Eins" }],
      total: 40,
      returned: 1,
      limit: 1,
      offset: 0,
      has_more: true,
    });

    const result = await ctx.client.callTool({ name: "list_projects", arguments: { limit: 1 } });

    expect(resultText(result)).toContain("1 von 40");
    expect(resultText(result)).toContain("offset=1");
  });

  it("rejects a non-integer project id before making a request", async () => {
    const result = await ctx.client.callTool({
      name: "get_project",
      arguments: { project_id: "einundzwanzig" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("posts a project update to the action-suffixed path", async () => {
    ctx.erp.reply({
      project: { label: "P-1 — Eins", name: "Eins" },
      changed: { status: { from: "lead", to: "aktiv" } },
    });

    await ctx.client.callTool({
      name: "update_project",
      arguments: { project_id: 156, status: "aktiv", budget_planned: 25000 },
    });

    const request = ctx.erp.requests[0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/api/projects/156/update");
    expect(request.body).toEqual({ status: "aktiv", budget_planned: 25000 });
  });

  it("relays a rejected business rule verbatim", async () => {
    ctx.erp.reply({ error: 'Phase kann nur bei Status "Lead" geändert werden' }, 422);

    const result = await ctx.client.callTool({
      name: "update_project",
      arguments: { project_id: 156, phase: "angebot" },
    });

    expect(isError(result)).toBe(true);
    expect(resultText(result)).toBe('Phase kann nur bei Status "Lead" geändert werden');
  });

  it("rejects a phase the ERP does not know before making a request", async () => {
    const result = await ctx.client.callTool({
      name: "update_project",
      arguments: { project_id: 156, phase: "verkauft" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("summarizes the controlling figures with currency and percentage", async () => {
    ctx.erp.reply({
      project: { id: 22, project_number: "P-2026-8945", name: "TransformationCamp" },
      hours: { planned: 380, actual_total: 569.65 },
      costs: { total: 26380.64 },
      revenue: 30000,
      deckungsbeitrag_1: 3619.36,
      realer_tagessatz: 421.3,
      budget: { basis: "budget_planned", planned: 35000, consumed_pct: 75.37 },
      currency: "EUR",
    });

    const text = resultText(
      await ctx.client.callTool({ name: "get_project_controlling", arguments: { project_id: 22 } }),
    );

    expect(text).toContain("P-2026-8945 — TransformationCamp");
    expect(text).toMatch(/€\s?26\.380,64/);
    expect(text).toContain("75,4 %");
  });

  it("names the missing permission when the token lacks it", async () => {
    ctx.erp.reply({ error: "Permission denied: api.projects.controlling.read" }, 403);

    const result = await ctx.client.callTool({
      name: "get_project_controlling",
      arguments: { project_id: 22 },
    });

    expect(isError(result)).toBe(true);
    expect(resultText(result)).toContain("api.projects.controlling.read");
  });

  it("sends the employee id in the body when adding a team member", async () => {
    ctx.erp.reply({ team_member: { employee: { name: "Anna Berger" }, role: "Projektleiter" } });

    await ctx.client.callTool({
      name: "add_project_team_member",
      arguments: { project_id: 12, employee_id: 7, role: "Projektleiter", daily_rate: 950 },
    });

    const request = ctx.erp.requests[0];
    expect(new URL(request.url).pathname).toBe("/api/projects/12/team/add");
    expect(request.body).toEqual({ employee_id: 7, role: "Projektleiter", daily_rate: 950 });
  });

  it("uses a POST action path for removing a team member", async () => {
    ctx.erp.reply({ success: true });

    await ctx.client.callTool({
      name: "remove_project_team_member",
      arguments: { project_id: 12, employee_id: 7 },
    });

    expect(ctx.erp.requests[0].method).toBe("POST");
    expect(new URL(ctx.erp.requests[0].url).pathname).toBe("/api/projects/12/team/remove");
  });

  it("reports the planned volume of the billing schedule", async () => {
    ctx.erp.reply({ ...emptyList([{ title: "Anzahlung" }]), planned_amount_total: 12500 });

    const text = resultText(
      await ctx.client.callTool({ name: "get_project_milestones", arguments: { project_id: 12 } }),
    );

    expect(text).toMatch(/€\s?12\.500,00/);
  });

  it("only accepts the known milestone statuses", async () => {
    const result = await ctx.client.callTool({
      name: "update_project_milestone",
      arguments: { project_id: 12, milestone_id: 3, status: "bezahlt" },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });

  it("sends resource planning to the save action", async () => {
    ctx.erp.reply({ planning: { month: "2026-05-01", planned_hours: 64 } });

    await ctx.client.callTool({
      name: "set_project_resource_planning",
      arguments: { project_id: 12, employee_id: 7, month: "2026-05", planned_hours: 64, fte_percentage: 40 },
    });

    const request = ctx.erp.requests[0];
    expect(new URL(request.url).pathname).toBe("/api/projects/12/resource-planning/save");
    expect(request.body).toMatchObject({ employee_id: 7, month: "2026-05", planned_hours: 64 });
  });

  it("rejects an FTE above 100 without asking the ERP", async () => {
    const result = await ctx.client.callTool({
      name: "set_project_resource_planning",
      arguments: { project_id: 12, employee_id: 7, month: "2026-05", planned_hours: 10, fte_percentage: 250 },
    });

    expect(isError(result)).toBe(true);
    expect(ctx.erp.requests).toHaveLength(0);
  });
});
