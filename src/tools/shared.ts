import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ErpError } from "../client.js";

/**
 * Wraps a tool handler so an ErpError becomes a tool error the assistant can
 * relay (including the ERP's own German business-rule wording) instead of an
 * unhandled exception. Anything else keeps bubbling up — an unexpected crash
 * should not look like a normal "no" from the ERP.
 */
export function guard<A>(
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof ErpError) {
        return {
          content: [{ type: "text" as const, text: error.message }],
          isError: true,
        };
      }
      throw error;
    }
  };
}

/** Shared input fragments so every list tool pages the same way. */
export const pagination = {
  limit: z.number().int().min(1).max(200).optional()
    .describe("Maximale Anzahl Datensätze (Standard 25, max 200)"),
  offset: z.number().int().min(0).optional()
    .describe("Offset für weitere Seiten"),
};

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format YYYY-MM-DD erwartet");

export const month = z.string().regex(/^\d{4}-\d{2}(-01)?$/, "Monat im Format YYYY-MM erwartet");

export const projectId = z.number().int().positive().describe("ID des Projekts");
