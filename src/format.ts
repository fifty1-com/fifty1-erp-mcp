/**
 * Output shaping for the assistant.
 *
 * Two rules the ERP data makes necessary: never hand back a bare id without the
 * name it belongs to, and never a bare number where it is money. Everything
 * here is about keeping answers legible when they are read out rather than
 * inspected as JSON.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const EUR = new Intl.NumberFormat("de-AT", {
  style: "currency",
  currency: "EUR",
});

export function money(amount: number | null | undefined): string | null {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return null;
  }

  return EUR.format(amount);
}

export function percent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  return `${value.toFixed(1).replace(".", ",")} %`;
}

const HOURS = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 });

export function hours(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }

  return `${HOURS.format(value)} h`;
}

export interface ListEnvelope<T> {
  items: T[];
  total: number;
  returned: number;
  limit: number | null;
  offset: number;
  has_more: boolean;
}

/**
 * Restates a list result so the assistant knows whether it is looking at
 * everything — the ERP already answers in this envelope, this only makes the
 * "there is more" part impossible to miss.
 */
export function summarizeList<T>(envelope: ListEnvelope<T>, noun: string): string {
  if (envelope.total === 0) {
    return `Keine ${noun} gefunden.`;
  }

  if (!envelope.has_more) {
    return `${envelope.total} ${noun}.`;
  }

  const nextOffset = envelope.offset + envelope.returned;
  return `${envelope.returned} von ${envelope.total} ${noun} (weitere mit offset=${nextOffset} abrufen).`;
}

/** The MCP tool result shape: a text summary plus the structured payload. */
export function toolResult(summary: string, data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: `${summary}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
    structuredContent: isPlainObject(data) ? (data as Record<string, unknown>) : { result: data },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
