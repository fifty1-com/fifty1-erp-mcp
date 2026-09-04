import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErpClient } from "../client.js";
import { money, percent, summarizeList, toolResult, type ListEnvelope } from "../format.js";
import { guard, pagination, projectId } from "./shared.js";

export function registerProjectTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "list_projects",
    {
      title: "Projekte auflisten",
      description:
        "Projekte durchsuchen und filtern (Status, Kunde, Freitext). Liefert Projektnummer, Name, Status, Phase, Budget und Kunde.",
      inputSchema: {
        status: z.string().optional().describe("Projektstatus, z.B. lead, aktiv, abgeschlossen, cancelled"),
        customer_id: z.number().int().positive().optional().describe("Nur Projekte dieses Kunden"),
        q: z.string().optional().describe("Freitextsuche in Projektname und Projektnummer"),
        ...pagination,
      },
    },
    guard(async (args) => {
      const data = await client.get<ListEnvelope<{ label: string }>>("/projects", args);

      return toolResult(summarizeList(data, "Projekte"), data);
    }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Projekt-Detail",
      description:
        "Vollständige Projektdaten inkl. Tätigkeiten sowie der aktuell erlaubten Status- und Phasenwechsel.",
      inputSchema: { project_id: projectId },
    },
    guard(async ({ project_id }) => {
      const project = await client.get<Record<string, unknown>>(`/projects/${project_id}`);

      return toolResult(`Projekt ${project.label ?? project_id}`, project);
    }),
  );

  server.registerTool(
    "update_project",
    {
      title: "Projekt aktualisieren",
      description:
        "Ändert Projektstammdaten und/oder Status bzw. Phase. Nur die übergebenen Felder werden geschrieben. " +
        "Die Phase kann nur geändert werden, solange der Status 'lead' ist; ein Statuswechsel auf aktiv/cancelled löscht die Phase.",
      inputSchema: {
        project_id: projectId,
        name: z.string().min(1).optional(),
        customer_id: z.number().int().positive().nullable().optional(),
        status: z.string().optional().describe("z.B. lead, aktiv, cancelled, abgeschlossen"),
        phase: z.enum(["lead", "eingang", "erstkontakt", "angebot", "verhandlung"]).optional()
          .describe("Vertriebsphase, nur bei Status 'lead' änderbar"),
        billing_type: z.enum(["time_materials", "fixed_price"]).optional(),
        fixed_price_amount: z.number().min(0).nullable().optional(),
        budget_planned: z.number().min(0).nullable().optional(),
        hours_planned: z.number().min(0).nullable().optional(),
        start_date: z.string().optional().describe("YYYY-MM-DD"),
        end_date: z.string().optional().describe("YYYY-MM-DD"),
        purchase_order_number: z.string().nullable().optional(),
        description: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ project: { label: string }; changed: unknown }>(
        `/projects/${project_id}/update`,
        body,
      );

      return toolResult(`Projekt aktualisiert: ${result.project.label}`, result);
    }),
  );

  server.registerTool(
    "get_project_controlling",
    {
      title: "Projektcontrolling (Soll/Ist)",
      description:
        "Soll/Ist-Kennzahlen eines Projekts: geplante vs. geleistete Stunden, Arbeitskosten, Umsatz, " +
        "Gesamtkosten, Deckungsbeitrag 1, realer Tagessatz und Budgetverbrauch.",
      inputSchema: { project_id: projectId },
    },
    guard(async ({ project_id }) => {
      const data = await client.get<ControllingSummary>(`/projects/${project_id}/controlling`);

      const summary = [
        `${data.project.project_number} — ${data.project.name}`,
        `Umsatz ${money(data.revenue)}, Kosten ${money(data.costs.total)}, DB1 ${money(data.deckungsbeitrag_1)}`,
        `Stunden geplant ${data.hours.planned}, geleistet ${data.hours.actual_total}`,
        `Budget (${data.budget.basis}) ${money(data.budget.planned)} — verbraucht ${percent(data.budget.consumed_pct)}`,
        `Realer Tagessatz ${money(data.realer_tagessatz)}`,
      ].join("\n");

      return toolResult(summary, data);
    }),
  );

  registerTeamTools(server, client);
  registerMilestoneTools(server, client);
  registerResourcePlanningTools(server, client);
}

function registerTeamTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "get_project_team",
    {
      title: "Projektteam",
      description: "Teamzusammensetzung eines Projekts inkl. Rolle, geplanter Stunden und Tagessatz.",
      inputSchema: { project_id: projectId },
    },
    guard(async ({ project_id }) => {
      const data = await client.get<ListEnvelope<unknown>>(`/projects/${project_id}/team`);

      return toolResult(summarizeList(data, "Teammitglieder"), data);
    }),
  );

  server.registerTool(
    "add_project_team_member",
    {
      title: "Teammitglied hinzufügen",
      description:
        "Ordnet einen Mitarbeiter einem Projekt zu. Ist er bereits zugeordnet, werden Rolle/Allokation aktualisiert.",
      inputSchema: {
        project_id: projectId,
        employee_id: z.number().int().positive().describe("ID des Mitarbeiters (siehe list_employees)"),
        role: z.string().optional().describe("z.B. Projektleiter, Teammitglied"),
        allocated_hours: z.number().min(0).nullable().optional(),
        daily_rate: z.number().min(0).nullable().optional().describe("Projektspezifischer Tagessatz"),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ team_member: { employee: { name: string }; role: string } }>(
        `/projects/${project_id}/team/add`,
        body,
      );

      return toolResult(
        `${result.team_member.employee.name} als ${result.team_member.role || "Teammitglied"} zugeordnet`,
        result,
      );
    }),
  );

  server.registerTool(
    "update_project_team_member",
    {
      title: "Teammitglied ändern",
      description: "Ändert Rolle, geplante Stunden oder Tagessatz eines bereits zugeordneten Mitarbeiters.",
      inputSchema: {
        project_id: projectId,
        employee_id: z.number().int().positive(),
        role: z.string().optional(),
        allocated_hours: z.number().min(0).nullable().optional(),
        daily_rate: z.number().min(0).nullable().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ team_member: { employee: { name: string } } }>(
        `/projects/${project_id}/team/update`,
        body,
      );

      return toolResult(`Zuordnung von ${result.team_member.employee.name} aktualisiert`, result);
    }),
  );

  server.registerTool(
    "remove_project_team_member",
    {
      title: "Teammitglied entfernen",
      description: "Entfernt einen Mitarbeiter aus dem Projektteam. Erfasste Zeiten bleiben erhalten.",
      inputSchema: {
        project_id: projectId,
        employee_id: z.number().int().positive(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post(`/projects/${project_id}/team/remove`, body);

      return toolResult("Teammitglied entfernt", result);
    }),
  );
}

function registerMilestoneTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "get_project_milestones",
    {
      title: "Abrechnungsmeilensteine",
      description:
        "Abrechnungsmeilensteine eines Projekts inkl. geplantem Betrag, Status und verknüpfter Ausgangsrechnung.",
      inputSchema: { project_id: projectId },
    },
    guard(async ({ project_id }) => {
      const data = await client.get<ListEnvelope<unknown> & { planned_amount_total: number }>(
        `/projects/${project_id}/milestones`,
      );

      const summary = `${summarizeList(data, "Meilensteine")} Geplantes Volumen: ${money(data.planned_amount_total)}`;

      return toolResult(summary, data);
    }),
  );

  server.registerTool(
    "create_project_milestone",
    {
      title: "Meilenstein anlegen",
      description: "Legt einen Abrechnungsmeilenstein an (geplantes Datum und Betrag).",
      inputSchema: {
        project_id: projectId,
        title: z.string().min(1).describe("Bezeichnung, z.B. 'Anzahlung' oder 'Abnahme Phase 1'"),
        planned_date: z.string().optional().describe("YYYY-MM-DD"),
        planned_amount: z.number().min(0).optional(),
        notes: z.string().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ milestone: { title: string; planned_amount: number | null } }>(
        `/projects/${project_id}/milestones/add`,
        body,
      );

      return toolResult(
        `Meilenstein "${result.milestone.title}" angelegt (${money(result.milestone.planned_amount) ?? "ohne Betrag"})`,
        result,
      );
    }),
  );

  server.registerTool(
    "update_project_milestone",
    {
      title: "Meilenstein ändern",
      description:
        "Ändert einen Meilenstein — auch Status und die Verknüpfung zu einer Ausgangsrechnung. " +
        "Die Rechnung muss zum selben Projekt gehören.",
      inputSchema: {
        project_id: projectId,
        milestone_id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        planned_date: z.string().nullable().optional().describe("YYYY-MM-DD"),
        planned_amount: z.number().min(0).nullable().optional(),
        status: z.enum(["planned", "invoiced", "paid", "cancelled"]).optional(),
        invoice_id: z.number().int().positive().nullable().optional()
          .describe("Ausgangsrechnung, mit der dieser Meilenstein abgerechnet wurde"),
        notes: z.string().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ milestone: { title: string; status: string } }>(
        `/projects/${project_id}/milestones/update`,
        body,
      );

      return toolResult(
        `Meilenstein "${result.milestone.title}" aktualisiert (Status: ${result.milestone.status})`,
        result,
      );
    }),
  );
}

function registerResourcePlanningTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "get_project_resource_planning",
    {
      title: "Ressourcenplanung",
      description:
        "Monatliche Ressourcenplanung eines Projekts: geplante Stunden und FTE je Mitarbeiter, " +
        "daneben die im selben Monat tatsächlich erfassten Stunden.",
      inputSchema: {
        project_id: projectId,
        months: z.number().int().min(1).max(24).optional().describe("Anzahl Monate ab dem aktuellen (Standard 6)"),
      },
    },
    guard(async ({ project_id, months }) => {
      const data = await client.get<ListEnvelope<unknown>>(
        `/projects/${project_id}/resource-planning`,
        { months },
      );

      return toolResult(summarizeList(data, "Planungseinträge"), data);
    }),
  );

  server.registerTool(
    "set_project_resource_planning",
    {
      title: "Ressourcenplanung setzen",
      description:
        "Setzt die geplanten Stunden und die FTE-Quote eines Mitarbeiters für einen Monat. " +
        "Ein bestehender Eintrag wird überschrieben.",
      inputSchema: {
        project_id: projectId,
        employee_id: z.number().int().positive(),
        month: z.string().describe("Monat im Format YYYY-MM"),
        planned_hours: z.number().min(0),
        fte_percentage: z.number().min(0).max(100).optional().describe("Standard 100"),
        notes: z.string().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ planning: { month: string; planned_hours: number } }>(
        `/projects/${project_id}/resource-planning/save`,
        body,
      );

      return toolResult(
        `Planung für ${result.planning.month} gespeichert: ${result.planning.planned_hours} h`,
        result,
      );
    }),
  );

  server.registerTool(
    "delete_project_resource_planning",
    {
      title: "Planungseintrag löschen",
      description: "Entfernt die Planung eines Mitarbeiters für einen Monat.",
      inputSchema: {
        project_id: projectId,
        employee_id: z.number().int().positive(),
        month: z.string().describe("Monat im Format YYYY-MM"),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post(`/projects/${project_id}/resource-planning/delete`, body);

      return toolResult("Planungseintrag gelöscht", result);
    }),
  );
}

interface ControllingSummary {
  project: { project_number: string; name: string };
  hours: { planned: number; actual_total: number };
  costs: { total: number };
  revenue: number;
  deckungsbeitrag_1: number;
  realer_tagessatz: number;
  budget: { basis: string; planned: number; consumed_pct: number };
}
