import { z } from "zod";
import { parseTemplate, type ActionDefinition } from "@ignitra/core";
import { GoogleAuthError, GoogleTokenCache, spreadsheetId, type GoogleConfig } from "../google";
import { transportFailure } from "./http-request";
import { retryAfterMs } from "../http";

/**
 * GOOGLE_SHEETS — append one row to a sheet tab.
 *
 *   {
 *     "connection_id": "conn_…",                                   a Google account (OAuth)
 *     "spreadsheet": "https://docs.google.com/spreadsheets/d/<id>/edit",
 *     "sheet": "Buys",
 *     "values": ["{{trigger.time.iso}}", "{{trigger.from}}", "{{trigger.amount_decimal}}", "{{trigger.explorer_url}}"]
 *   }
 *
 * USER_ENTERED (default) lets Sheets parse numbers and dates like typed input;
 * substituted values that would be read as a formula (=, +, -, @) are written as
 * text, so on-chain data cannot inject formulas. Appends are at-least-once: add
 * {{run.idempotency_key}} as a column if your sheet must deduplicate retries.
 * TEST runs append one extra trailing cell, SHEETS_TEST_MARKER.
 */

export const SHEETS_TEST_MARKER = "🧪 TEST run";

const template = z
  .string()
  .max(2000)
  .superRefine((t, ctx) => {
    try {
      parseTemplate(t);
    } catch (err) {
      ctx.addIssue({ code: "custom", message: (err as Error).message });
    }
  });

export const googleSheetsParams = z
  .object({
    connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/),
    spreadsheet: z
      .string()
      .trim()
      .max(500)
      .transform((v, ctx) => {
        const id = spreadsheetId(v);
        if (!id) {
          ctx.addIssue({ code: "custom", message: "paste the spreadsheet URL (https://docs.google.com/spreadsheets/d/…) or its id" });
          return z.NEVER;
        }
        return id;
      }),
    sheet: z.string().trim().min(1).max(100).default("Sheet1"),
    values: z.array(template).min(1).max(50),
    input: z.enum(["USER_ENTERED", "RAW"]).default("USER_ENTERED"),
  })
  .strict();

export type GoogleSheetsParams = z.output<typeof googleSheetsParams>;

interface AppendResponse {
  updates?: { updatedRange?: string; updatedRows?: number };
  error?: { message?: string; status?: string };
}

export function createGoogleSheetsAction(cfg: GoogleConfig | null): ActionDefinition<GoogleSheetsParams> {
  const tokens = new GoogleTokenCache();
  const sheetsUrl = (cfg?.sheetsUrl ?? "https://sheets.googleapis.com").replace(/\/+$/, "");
  return {
    type: "GOOGLE_SHEETS",
    label: "Google Sheets",
    description: "Append a row to a Google Sheets tab (your Google account, OAuth).",
    connectionType: "google",
    paramsSchema: googleSheetsParams,
    templates: (p) => p.values.map((v, i) => ({ name: `values.${i}`, template: v })),
    outputFields: [
      { path: "updated_range", type: "string", description: "Range the row was written to, e.g. Buys!A12:D12" },
      { path: "updated_rows", type: "number", description: "Rows appended (1)" },
      { path: "spreadsheet_id", type: "string", description: "Spreadsheet id" },
    ],

    async execute(p, ctx) {
      if (!cfg) return { status: "failed", retryable: false, error: "Google is not configured on this runner (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)" };
      const refreshToken = ctx.connection?.secret.refresh_token;
      if (typeof refreshToken !== "string" || !ctx.connection) return { status: "failed", retryable: false, error: "google connection has no refresh token; reconnect Google" };
      const row = p.values.map((v) => ctx.render(v, p.input === "USER_ENTERED" ? "sheets" : "none"));
      // TEST runs are labelled in every destination: a trailing cell keeps the data columns typed.
      if (ctx.isTest) row.push(SHEETS_TEST_MARKER);
      const range = `'${p.sheet.replace(/'/g, "''")}'!A1`;
      const request = { spreadsheet_id: p.spreadsheet, sheet: p.sheet, columns: row.length, row_preview: row.map((c) => c.slice(0, 80)) };

      let token: string;
      try {
        token = await tokens.get(ctx.http, cfg, ctx.connection.id, refreshToken);
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          return { status: "failed", retryable: !err.revoked, error: err.revoked ? "Google access was revoked or expired: reconnect Google in Connections" : err.message, request };
        }
        return transportFailure(err, request);
      }
      try {
        const res = await ctx.http.request({
          url: `${sheetsUrl}/v4/spreadsheets/${encodeURIComponent(p.spreadsheet)}/values/${encodeURIComponent(range)}:append?valueInputOption=${p.input}&insertDataOption=INSERT_ROWS`,
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ majorDimension: "ROWS", values: [row] }),
        });
        let json: AppendResponse = {};
        try {
          json = JSON.parse(res.body) as AppendResponse;
        } catch {
          // ignore
        }
        const response = { status: res.status, duration_ms: res.durationMs, updated_range: json.updates?.updatedRange ?? null, error: json.error?.message ?? null };
        if (res.status >= 200 && res.status < 300) {
          return {
            status: "succeeded",
            httpStatus: res.status,
            output: { updated_range: json.updates?.updatedRange ?? null, updated_rows: json.updates?.updatedRows ?? 1, spreadsheet_id: p.spreadsheet },
            request,
            response,
          };
        }
        if (res.status === 401) tokens.invalidate(ctx.connection.id); // next attempt refreshes
        const permanent: Record<number, string> = {
          400: `Sheets rejected the row: ${json.error?.message ?? "bad request"} (does the tab "${p.sheet}" exist?)`,
          403: `no access to this spreadsheet with ${String(ctx.connection.metadata.email ?? "the connected account")}: open it with that account or share it`,
          404: "spreadsheet not found (check the URL)",
        };
        const message = permanent[res.status];
        if (message) return { status: "failed", httpStatus: res.status, retryable: false, error: message, request, response };
        const after = retryAfterMs(res.headers["retry-after"]);
        return { status: "failed", httpStatus: res.status, retryable: true, error: `Google Sheets answered HTTP ${res.status}`, ...(after !== undefined ? { retryAfterMs: after } : {}), request, response };
      } catch (err) {
        return transportFailure(err, request);
      }
    },
  };
}
