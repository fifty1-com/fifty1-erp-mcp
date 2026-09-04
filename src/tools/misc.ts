import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErpClient } from "../client.js";
import { money, summarizeList, toolResult, type ListEnvelope } from "../format.js";
import { guard, pagination, projectId } from "./shared.js";

/** Time entries, project expenses, budgets, cost centers and the employee directory. */
export function registerMiscTools(server: McpServer, client: ErpClient): void {
  registerTimeEntryTools(server, client);
  registerExpenseTools(server, client);
  registerReferenceTools(server, client);
}

function registerTimeEntryTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "list_time_entries",
    {
      title: "Zeiteinträge auflisten",
      description:
        "Erfasste Zeiten über alle Mitarbeiter hinweg. Mindestens ein Filter ist erforderlich " +
        "(employee_id, project_id oder date_from + date_to); der Zeitraum darf höchstens 92 Tage umfassen.",
      inputSchema: {
        employee_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD"),
        ...pagination,
      },
    },
    guard(async (args) => {
      const data = await client.get<ListEnvelope<{ hours: number }>>("/time-entries", args);

      const sum = data.items.reduce((acc, entry) => acc + entry.hours, 0);
      const summary = `${summarizeList(data, "Zeiteinträge")} Summe dieser Seite: ${sum.toFixed(2)} h`;

      return toolResult(summary, data);
    }),
  );
}

function registerExpenseTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "get_project_expenses",
    {
      title: "Projektausgaben",
      description: "Erfasste Ausgaben eines Projekts (Reisekosten, Kilometergeld, Tagespauschale, Sonstiges).",
      inputSchema: { project_id: projectId },
    },
    guard(async ({ project_id }) => {
      const data = await client.get<ListEnvelope<unknown> & { total_amount: number }>(
        `/projects/${project_id}/expenses`,
      );

      return toolResult(
        `${summarizeList(data, "Ausgaben")} Gesamt: ${money(data.total_amount)}`,
        data,
      );
    }),
  );

  server.registerTool(
    "create_project_expense",
    {
      title: "Projektausgabe erfassen",
      description:
        "Bucht eine Ausgabe auf ein Projekt. Der Mitarbeiter muss explizit angegeben werden — " +
        "der API-Token gehört zu keinem Mitarbeiter. Die Buchung wird im Aktivitätsprotokoll des Projekts vermerkt.",
      inputSchema: {
        project_id: projectId,
        employee_id: z.number().int().positive().describe("Mitarbeiter, dem die Ausgabe zugeordnet wird"),
        amount: z.number().positive().describe("Betrag in EUR, muss größer als 0 sein"),
        category: z.enum(["travel", "mileage", "allowance", "other"]),
        expense_date: z.string().optional().describe("YYYY-MM-DD, Standard heute"),
        description: z.string().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ expense: { amount: number; category_label: string } }>(
        `/projects/${project_id}/expenses/add`,
        body,
      );

      return toolResult(
        `Ausgabe erfasst: ${money(result.expense.amount)} (${result.expense.category_label})`,
        result,
      );
    }),
  );

  server.registerTool(
    "update_project_expense",
    {
      title: "Projektausgabe ändern",
      description: "Ändert Betrag, Kategorie, Datum oder Beschreibung einer erfassten Ausgabe.",
      inputSchema: {
        project_id: projectId,
        expense_id: z.number().int().positive(),
        amount: z.number().positive().optional(),
        category: z.enum(["travel", "mileage", "allowance", "other"]).optional(),
        expense_date: z.string().optional().describe("YYYY-MM-DD"),
        description: z.string().optional(),
      },
    },
    guard(async ({ project_id, ...body }) => {
      const result = await client.post<{ expense: { amount: number } }>(
        `/projects/${project_id}/expenses/update`,
        body,
      );

      return toolResult(`Ausgabe aktualisiert: ${money(result.expense.amount)}`, result);
    }),
  );
}

function registerReferenceTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "list_budgets",
    {
      title: "Projektbudgets",
      description: "Budgetpositionen eines Projekts mit geplantem und tatsächlichem Betrag je Kategorie.",
      inputSchema: { project_id: projectId },
    },
    guard(async ({ project_id }) => {
      const data = await client.get<ListEnvelope<unknown>>("/budgets", { project_id });

      return toolResult(summarizeList(data, "Budgetpositionen"), data);
    }),
  );

  server.registerTool(
    "list_cost_centers",
    {
      title: "Kostenstellen",
      description: "Alle Kostenstellen mit Code und Aktiv-Status.",
      inputSchema: {},
    },
    guard(async () => {
      const data = await client.get<ListEnvelope<unknown>>("/cost-centers");

      return toolResult(summarizeList(data, "Kostenstellen"), data);
    }),
  );

  server.registerTool(
    "list_employees",
    {
      title: "Mitarbeiter auflisten",
      description:
        "Mitarbeiterverzeichnis (Name, E-Mail, Position, Wochenkapazität). " +
        "Enthält bewusst keine Stundensätze oder sicherheitsrelevanten Felder.",
      inputSchema: {
        q: z.string().optional().describe("Freitextsuche in Name und E-Mail"),
        is_active: z.boolean().optional().describe("true = nur aktive, false = nur inaktive Mitarbeiter"),
      },
    },
    guard(async (args) => {
      const data = await client.get<ListEnvelope<unknown>>("/employees", args);

      return toolResult(summarizeList(data, "Mitarbeiter"), data);
    }),
  );
}
