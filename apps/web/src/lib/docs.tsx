import { OFFICIAL_TEMPLATES, instantiateTemplate, type FieldSpec } from "@ignitra/core";

/** Docs helpers: params tables from the API's JSON Schemas, payload field tables, examples from the official templates. */

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
}

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alts = s.anyOf ?? s.oneOf;
  if (alts) return [...new Set(alts.map(typeOf))].join(" | ");
  if (s.type === "array") return `${s.items ? typeOf(s.items) : "any"}[]`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  return s.type ?? "any";
}

export function ParamsTable({ schema }: { schema: unknown }) {
  const s = (schema ?? {}) as JsonSchema;
  const required = new Set(s.required ?? []);
  const rows = Object.entries(s.properties ?? {});
  if (rows.length === 0) return <p className="muted">No parameters.</p>;
  return (
    <table className="table card">
      <thead>
        <tr>
          <th>Param</th>
          <th>Type</th>
          <th>Required</th>
          <th>Default</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, p]) => (
          <tr key={name}>
            <td className="mono">{name}</td>
            <td className="mono small">{typeOf(p)}</td>
            <td className="small">{required.has(name) && p.default === undefined ? "yes" : ""}</td>
            <td className="mono small">{p.default === undefined ? "" : JSON.stringify(p.default)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FieldsTable({ fields, prefix }: { fields: readonly FieldSpec[]; prefix: string }) {
  if (fields.length === 0) return null;
  return (
    <table className="table card">
      <thead>
        <tr>
          <th>Variable</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.path}>
            <td className="mono small">
              {prefix}
              {f.path}
            </td>
            <td className="mono small">
              {f.type}
              {f.nullable ? "?" : ""}
            </td>
            <td className="small">{f.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const FAKE_CONN = `conn_${"0".repeat(26)}`;

/** A real, validated example: the params an official template produces with its example values. */
export function exampleFor(kind: "trigger" | "action", type: string): { template: string; params: unknown } | null {
  for (const t of OFFICIAL_TEMPLATES) {
    const def = t.definition as { trigger: { type: string }; actions: Array<{ type: string }> };
    const matches = kind === "trigger" ? def.trigger.type === type : def.actions.some((a) => a.type === type);
    if (!matches) continue;
    const values: Record<string, unknown> = {};
    for (const p of t.placeholders) {
      if (p.type === "connection") values[p.key] = FAKE_CONN;
      else if (p.type === "url") values[p.key] = "https://myapp.example/hooks/ignitra";
      else if (p.type === "spreadsheet") values[p.key] = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";
      else if (p.example !== undefined) values[p.key] = p.example;
    }
    const built = instantiateTemplate(t, values);
    if ("issues" in built) continue;
    const d = built.definition as { trigger: { params: unknown }; actions: Array<{ type: string; params: unknown }> };
    const params = kind === "trigger" ? d.trigger.params : d.actions.find((a) => a.type === type)?.params;
    return { template: t.slug, params: JSON.parse(JSON.stringify(params).split(FAKE_CONN).join("conn_…")) as unknown };
  }
  return null;
}

export function Code({ children }: { children: string }) {
  return (
    <pre className="json">
      <code>{children}</code>
    </pre>
  );
}
