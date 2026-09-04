import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ErpClient } from "../client.js";
import { summarizeList, toolResult, type ListEnvelope } from "../format.js";
import { guard, pagination } from "./shared.js";

const contactShape = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  position: z.string().optional(),
});

const customerShape = {
  company: z.string().min(1).describe("Firmenname"),
  email: z.string().optional(),
  phone: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().length(2).optional().describe("Ländercode, Standard AT"),
  tax_id: z.string().optional().describe("UID-Nummer"),
  website: z.string().optional(),
  notes: z.string().optional(),
};

export function registerCustomerTools(server: McpServer, client: ErpClient): void {
  server.registerTool(
    "list_customers",
    {
      title: "Kunden auflisten",
      description: "Kunden durchsuchen (Firmenname oder E-Mail) und filtern.",
      inputSchema: {
        q: z.string().optional().describe("Freitextsuche in Firmenname und E-Mail"),
        status: z.string().optional(),
        ...pagination,
      },
    },
    guard(async (args) => {
      const data = await client.get<ListEnvelope<unknown>>("/customers", args);

      return toolResult(summarizeList(data, "Kunden"), data);
    }),
  );

  server.registerTool(
    "get_customer",
    {
      title: "Kunden-Detail",
      description: "Kundendaten inkl. aller Ansprechpersonen.",
      inputSchema: { customer_id: z.number().int().positive() },
    },
    guard(async ({ customer_id }) => {
      const customer = await client.get<{ company: string; contacts: unknown[] }>(`/customers/${customer_id}`);

      return toolResult(
        `${customer.company} (${customer.contacts.length} Ansprechperson(en))`,
        customer,
      );
    }),
  );

  server.registerTool(
    "create_customer",
    {
      title: "Kunden anlegen",
      description:
        "Legt einen Kunden an. Existiert bereits ein Kunde mit gleicher E-Mail oder gleichem (normalisiertem) " +
        "Firmennamen, wird dieser zurückgegeben statt ein Duplikat anzulegen — erkennbar an customer_matched.",
      inputSchema: customerShape,
    },
    guard(async (body) => {
      const result = await client.post<{
        customer: { company: string; id: number };
        customer_created?: boolean;
        customer_matched?: boolean;
      }>("/customers", body);

      const summary = result.customer_matched
        ? `Bestehender Kunde gefunden: ${result.customer.company} (ID ${result.customer.id}) — kein Duplikat angelegt`
        : `Kunde angelegt: ${result.customer.company} (ID ${result.customer.id})`;

      return toolResult(summary, result);
    }),
  );

  server.registerTool(
    "update_customer",
    {
      title: "Kunden aktualisieren",
      description: "Ändert Kundendaten. Nur die übergebenen Felder werden geschrieben.",
      inputSchema: {
        customer_id: z.number().int().positive(),
        company: z.string().min(1).optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        street: z.string().optional(),
        zip: z.string().optional(),
        city: z.string().optional(),
        country: z.string().length(2).optional(),
        tax_id: z.string().optional(),
        website: z.string().optional(),
        notes: z.string().optional(),
        status: z.string().optional(),
        owner_id: z.number().int().positive().nullable().optional().describe("Betreuender Mitarbeiter"),
      },
    },
    guard(async ({ customer_id, ...body }) => {
      const result = await client.post<{ customer: { company: string } }>(
        `/customers/${customer_id}/update`,
        body,
      );

      return toolResult(`Kunde aktualisiert: ${result.customer.company}`, result);
    }),
  );

  server.registerTool(
    "create_lead",
    {
      title: "Lead anlegen",
      description:
        "Legt ein Lead-Projekt an — optional zusammen mit einem neuen Kunden und einer Ansprechperson. " +
        "Kunde und Kontakt werden serverseitig dedupliziert (Kunde per E-Mail oder normalisiertem Firmennamen, " +
        "Kontakt per E-Mail oder Namen); die Antwort sagt über customer_created/customer_matched bzw. " +
        "contact_created/contact_matched, welcher Fall eingetreten ist. " +
        "Entweder customer_id ODER customer angeben.",
      inputSchema: {
        name: z.string().min(1).describe("Projektname"),
        customer_id: z.number().int().positive().optional().describe("ID eines bestehenden Kunden"),
        customer: z.object({ ...customerShape, contact: contactShape.optional() }).optional()
          .describe("Kundendaten, wenn der Kunde neu angelegt bzw. gesucht werden soll"),
        contact: contactShape.optional().describe("Ansprechperson bei Verwendung mit customer_id"),
        description: z.string().optional(),
        billing_type: z.enum(["time_materials", "fixed_price"]).optional(),
        fixed_price_amount: z.number().min(0).optional(),
        budget_planned: z.number().min(0).optional(),
        hours_planned: z.number().min(0).optional(),
        purchase_order_number: z.string().optional(),
        requires_time_tracking: z.boolean().optional(),
      },
    },
    guard(async (body) => {
      const result = await client.post<{
        project: { project_number: string; name: string };
        customer_created?: boolean;
        customer_matched?: boolean;
        customer?: { company: string };
        contact_created?: boolean;
        contact_matched?: boolean;
      }>("/projects/leads", body);

      const parts = [`Lead angelegt: ${result.project.project_number} — ${result.project.name}`];

      if (result.customer_created) {
        parts.push(`Kunde neu angelegt: ${result.customer?.company}`);
      } else if (result.customer_matched) {
        parts.push(`Bestehender Kunde zugeordnet: ${result.customer?.company}`);
      }

      if (result.contact_created) {
        parts.push("Ansprechperson neu angelegt");
      } else if (result.contact_matched) {
        parts.push("Bestehende Ansprechperson zugeordnet");
      }

      return toolResult(parts.join("\n"), result);
    }),
  );
}
