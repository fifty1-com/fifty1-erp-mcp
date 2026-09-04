import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErpClient } from "../client.js";
import { money, summarizeList, toolResult, type ListEnvelope } from "../format.js";
import { guard, pagination } from "./shared.js";

export function registerInvoiceTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "list_invoices",
    {
      title: "Rechnungen auflisten",
      description:
        "Rechnungen filtern: AR (Ausgangsrechnungen) oder ER (Eingangsrechnungen), nach Status, " +
        "Projekt, Kunde oder Rechnungsdatum.",
      inputSchema: {
        type: z.enum(["AR", "ER"]).optional().describe("AR = Ausgangsrechnung, ER = Eingangsrechnung"),
        status: z.string().optional(),
        project_id: z.number().int().positive().optional(),
        customer_id: z.number().int().positive().optional(),
        date_from: z.string().optional().describe("Rechnungsdatum ab, YYYY-MM-DD"),
        date_to: z.string().optional().describe("Rechnungsdatum bis, YYYY-MM-DD"),
        ...pagination,
      },
    },
    guard(async (args) => {
      const data = await client.get<ListEnvelope<{ total_amount: number | null }>>("/invoices", args);

      const sum = data.items.reduce((acc, item) => acc + (item.total_amount ?? 0), 0);
      const summary = `${summarizeList(data, "Rechnungen")} Summe dieser Seite: ${money(sum)}`;

      return toolResult(summary, data);
    }),
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Rechnungs-Detail",
      description:
        "Rechnung inkl. Positionen, Tags und der aktuell erlaubten Statusübergänge.",
      inputSchema: { invoice_id: z.number().int().positive() },
    },
    guard(async ({ invoice_id }) => {
      const invoice = await client.get<{ label: string; status: string; total_amount: number | null }>(
        `/invoices/${invoice_id}`,
      );

      return toolResult(
        `${invoice.label} — Status ${invoice.status}, ${money(invoice.total_amount) ?? "kein Betrag"}`,
        invoice,
      );
    }),
  );

  server.registerTool(
    "update_invoice_status",
    {
      title: "Rechnungsstatus ändern (nur AR)",
      description:
        "Versetzt eine Ausgangsrechnung in den nächsten Workflow-Status (draft → sent → paid/cancelled). " +
        "Nur für AR-Rechnungen; Eingangsrechnungen (ER) werden abgelehnt. " +
        "Erlaubte Übergänge einer konkreten Rechnung liefert get_invoice.",
      inputSchema: {
        invoice_id: z.number().int().positive(),
        status: z.enum(["sent", "paid", "cancelled"]),
      },
    },
    guard(async ({ invoice_id, status }) => {
      const result = await client.post<{
        invoice: { label: string };
        changed: { status: { from: string; to: string } };
      }>(`/invoices/${invoice_id}/status`, { status });

      return toolResult(
        `${result.invoice.label}: ${result.changed.status.from} → ${result.changed.status.to}`,
        result,
      );
    }),
  );
}
