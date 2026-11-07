/**
 * Builder forms per trigger / action type. Presentation only: the server
 * validates every save (and returns issues with paths, shown next to fields).
 * A type without a form here falls back to a raw JSON params editor.
 */

export type Widget =
  | "address" // address input, auto-detected (token / contract / wallet)
  | "address-or-template"
  | "text"
  | "decimal"
  | "number"
  | "select"
  | "bool"
  | "template" // one line, with the variable picker
  | "template-area" // multi-line, with the variable picker
  | "json-template" // JSON body, with the variable picker
  | "cron"
  | "timezone"
  | "connection"
  | "event" // event signature, picked from the detected ABI
  | "function" // view function signature, picked from the detected ABI
  | "args" // call arguments (literal or variables)
  | "list" // list of templates (sheet columns)
  | "pairs"; // name / value list (headers, form fields)

export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly widget: Widget;
  readonly help?: string;
  readonly placeholder?: string;
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly connectionType?: string;
  readonly optional?: boolean;
  /** For event / function pickers: the address field whose detection supplies the ABI. */
  readonly source?: string;
  readonly defaultValue?: unknown;
  readonly visible?: (params: Readonly<Record<string, unknown>>) => boolean;
}

const opts = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));

export const TRIGGER_FORMS: Readonly<Record<string, readonly FormField[]>> = {
  TOKEN_TRANSFER: [
    { key: "token", label: "Token", widget: "address", placeholder: "0x… token contract", help: "Paste the ERC-20 contract: symbol, decimals and supply are detected." },
    { key: "wallet", label: "Wallet", widget: "address", optional: true, placeholder: "0x… (optional)", help: "Only transfers into or out of this wallet." },
    { key: "direction", label: "Direction", widget: "select", options: opts(["any", "In or out"], ["in", "Into the wallet"], ["out", "Out of the wallet"]), defaultValue: "any", visible: (p) => Boolean(p.wallet) },
  ],
  NEW_HOLDER: [{ key: "token", label: "Token", widget: "address", placeholder: "0x… token contract", help: "Fires when an address starts holding the token (per transaction, not router hops)." }],
  CONTRACT_EVENT: [
    { key: "address", label: "Contract", widget: "address", placeholder: "0x… contract" },
    { key: "event", label: "Event", widget: "event", source: "address", placeholder: "event Name(address indexed from, uint256 value)", help: "Pick from the contract's ABI, or paste a full signature." },
  ],
  BALANCE_THRESHOLD: [
    { key: "wallet", label: "Wallet", widget: "address", placeholder: "0x… wallet" },
    { key: "asset", label: "Asset", widget: "text", defaultValue: "native", placeholder: "native or 0x… token", help: "native = ETH, or an ERC-20 token address." },
    { key: "threshold", label: "Threshold", widget: "decimal", placeholder: "2", help: "In token units (2 = 2 ETH)." },
    { key: "direction", label: "Run when it goes", widget: "select", options: opts(["below", "Below the threshold"], ["above", "Above the threshold"], ["cross", "Across, either way"]), defaultValue: "below" },
  ],
  CONTRACT_DEPLOYED: [{ key: "deployer", label: "Deployer", widget: "address", placeholder: "0x… wallet or CREATE factory" }],
  STATE_CHANGE: [
    { key: "address", label: "Contract", widget: "address", placeholder: "0x… contract" },
    { key: "function", label: "Read", widget: "function", source: "address", placeholder: "function totalSupply() view returns (uint256)", help: "A view function; the flow runs when its result changes." },
    { key: "args", label: "Arguments", widget: "args", optional: true },
  ],
  SCHEDULE: [
    { key: "cron", label: "Schedule (cron)", widget: "cron", placeholder: "0 9 * * 1-5", help: "minute hour day month weekday — e.g. 0 9 * * 1-5 = 09:00 Monday to Friday." },
    { key: "timezone", label: "Timezone", widget: "timezone", defaultValue: "Asia/Jakarta" },
  ],
  INBOUND_WEBHOOK: [],
};

export const ACTION_FORMS: Readonly<Record<string, readonly FormField[]>> = {
  TELEGRAM: [
    { key: "connection_id", label: "Chat", widget: "connection", connectionType: "telegram" },
    { key: "text", label: "Message", widget: "template-area", defaultValue: "🔔 <b>{{flow.name}}</b>", help: "HTML: <b>, <i>, <a href=\"…\">, <code>. Variable values are escaped." },
    { key: "parse_mode", label: "Format", widget: "select", options: opts(["html", "HTML"], ["plain", "Plain text"]), defaultValue: "html" },
    { key: "disable_link_preview", label: "No link previews", widget: "bool", defaultValue: true },
    { key: "silent", label: "Send silently", widget: "bool", defaultValue: false },
  ],
  WEBHOOK: [
    { key: "url", label: "URL", widget: "text", placeholder: "https://myapp.com/hooks/ignitra", visible: (p) => !p.connection_id, help: "Signed with your webhook secret (Settings)." },
    { key: "connection_id", label: "…or a webhook connection", widget: "connection", connectionType: "webhook", optional: true },
  ],
  WEB_PUSH: [
    { key: "title", label: "Title", widget: "template", defaultValue: "{{flow.name}}" },
    { key: "body", label: "Body", widget: "template-area", defaultValue: "" },
    { key: "url", label: "Open on tap", widget: "template", optional: true, placeholder: "{{trigger.explorer_url}}" },
  ],
  CHAIN_READ: [
    { key: "address", label: "Contract", widget: "address-or-template", placeholder: "0x… or {{trigger.token.address}}" },
    { key: "function", label: "Function", widget: "function", source: "address", placeholder: "function balanceOf(address account) view returns (uint256)" },
    { key: "args", label: "Arguments", widget: "args", optional: true },
    { key: "block", label: "Read at", widget: "select", options: opts(["latest", "Latest block"], ["trigger", "The trigger's block"]), defaultValue: "latest" },
  ],
  HTTP_REQUEST: [
    { key: "method", label: "Method", widget: "select", options: opts(["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"], ["GET", "GET"], ["DELETE", "DELETE"]), defaultValue: "POST" },
    { key: "url", label: "URL", widget: "template", placeholder: "https://api.example.com/orders/{{trigger.body.order}}" },
    { key: "headers", label: "Headers", widget: "pairs", optional: true },
    {
      key: "body_type",
      label: "Body",
      widget: "select",
      options: opts(["json", "JSON"], ["text", "Text"], ["form", "Form"], ["none", "None"]),
      defaultValue: "json",
      visible: (p) => p.method !== "GET" && p.method !== "DELETE",
    },
    { key: "body", label: "JSON / text body", widget: "json-template", defaultValue: '{\n  "flow": "{{flow.name}}"\n}', visible: (p) => p.method !== "GET" && p.method !== "DELETE" && (p.body_type === "json" || p.body_type === "text") },
    { key: "form", label: "Form fields", widget: "pairs", visible: (p) => p.method !== "GET" && p.method !== "DELETE" && p.body_type === "form" },
    { key: "connection_id", label: "Secret headers", widget: "connection", connectionType: "http", optional: true, help: "API keys live in an HTTP connection, bound to its host." },
    { key: "sign", label: "Sign the request (X-Ignitra-Signature)", widget: "bool", defaultValue: true },
  ],
  EMAIL: [
    { key: "connection_id", label: "To", widget: "connection", connectionType: "email", help: "A verified address (Connections)." },
    { key: "subject", label: "Subject", widget: "template", defaultValue: "{{flow.name}}" },
    { key: "body", label: "Body", widget: "template-area", defaultValue: "" },
  ],
  GOOGLE_SHEETS: [
    { key: "connection_id", label: "Google account", widget: "connection", connectionType: "google" },
    { key: "spreadsheet", label: "Spreadsheet", widget: "text", placeholder: "https://docs.google.com/spreadsheets/d/…" },
    { key: "sheet", label: "Tab", widget: "text", defaultValue: "Sheet1" },
    { key: "values", label: "Columns", widget: "list", defaultValue: ["{{now_utc}}"], help: "One value per column, left to right." },
    { key: "input", label: "Values", widget: "select", options: opts(["USER_ENTERED", "Parsed like typed input"], ["RAW", "Stored as-is"]), defaultValue: "USER_ENTERED" },
  ],
};

export const CONNECTION_LABELS: Readonly<Record<string, string>> = {
  telegram: "Telegram chat",
  webhook: "Webhook",
  email: "Email address",
  google: "Google account",
  http: "HTTP secret headers",
};
