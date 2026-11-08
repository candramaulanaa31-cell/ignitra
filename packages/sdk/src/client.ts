import { IgnitraApiError, IgnitraError, IgnitraNetworkError } from "./errors.js";
import type {
  ActionInfo,
  ActionStep,
  ActionStepInput,
  Connection,
  ConnectionInput,
  CreatedConnection,
  Evaluation,
  EvaluationOutcome,
  Flow,
  FlowDefinition,
  FlowDefinitionInput,
  FlowDetail,
  Page,
  PublishTemplateInput,
  Run,
  RunDetail,
  RunStatus,
  TemplateCard,
  TemplateDetail,
  TestRunResult,
  TriggerInfo,
  Usage,
  User,
  ValidatedFlow,
} from "./types.js";

export const SDK_VERSION = "0.1.0";

export interface IgnitraOptions {
  /** An API key (`igk_…`, Team plan) or a wallet session token (`igs_…`). */
  apiKey?: string;
  /** The API base, e.g. `https://app.example/api`. Defaults to the `IGNITRA_API_URL` env variable. */
  baseUrl?: string;
  /** Per request, including retries of that request. Default 30 s. */
  timeoutMs?: number;
  /** Retries of rate-limited (429) and unavailable (502/503/504) answers. Default 2. */
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  /** Safe to repeat after a network error or a 5xx (GET, DELETE, pause…). */
  idempotent?: boolean;
  signal?: AbortSignal;
}

const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Names steps that have none (`webhook`, `webhook_2`, …), as the API requires a step_id. */
export function withStepIds(actions: readonly ActionStepInput[]): ActionStep[] {
  const taken = new Set(actions.map((a) => a.step_id).filter((id): id is string => typeof id === "string"));
  return actions.map((a) => {
    if (a.step_id) return a as ActionStep;
    const base = a.type.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "") || "step";
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
    taken.add(id);
    return { ...a, step_id: id };
  });
}

function toDefinition(input: FlowDefinitionInput): FlowDefinitionInput & { actions: ActionStep[] } {
  return {
    trigger: input.trigger,
    ...(input.conditions ? { conditions: input.conditions } : {}),
    actions: withStepIds(input.actions),
    ...(input.settings ? { settings: input.settings } : {}),
  };
}

export type CreateFlowInput = { name: string; activate?: boolean } & ({ definition: FlowDefinitionInput } | FlowDefinitionInput);

const definitionOf = (input: CreateFlowInput | { definition: FlowDefinitionInput } | FlowDefinitionInput): FlowDefinitionInput =>
  "definition" in input ? input.definition : { trigger: input.trigger, ...(input.conditions ? { conditions: input.conditions } : {}), actions: input.actions, ...(input.settings ? { settings: input.settings } : {}) };

/**
 * The IGNITRA API client.
 *
 *   const ignitra = new Ignitra({ apiKey: process.env.IGNITRA_API_KEY, baseUrl: "https://app.example/api" });
 *   await ignitra.flows.create({ name: "Big buys → my server", trigger: {…}, actions: [{ type: "WEBHOOK", params: {…} }] });
 */
export class Ignitra {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  readonly flows: FlowsResource;
  readonly runs: RunsResource;
  readonly connections: ConnectionsResource;
  readonly templates: TemplatesResource;
  readonly catalog: CatalogResource;
  readonly account: AccountResource;

  constructor(options: IgnitraOptions = {}) {
    const apiKey = options.apiKey ?? env("IGNITRA_API_KEY");
    const baseUrl = options.baseUrl ?? env("IGNITRA_API_URL");
    if (!apiKey) throw new IgnitraError("Ignitra: apiKey is required (or set IGNITRA_API_KEY)");
    if (!baseUrl) throw new IgnitraError("Ignitra: baseUrl is required (or set IGNITRA_API_URL), e.g. https://app.example/api");
    if (!/^https?:\/\//.test(baseUrl)) throw new IgnitraError("Ignitra: baseUrl must be an http(s) URL");
    this.#apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
    const request = this.request.bind(this);
    this.flows = new FlowsResource(request);
    this.runs = new RunsResource(request);
    this.connections = new ConnectionsResource(request);
    this.templates = new TemplatesResource(request);
    this.catalog = new CatalogResource(request);
    this.account = new AccountResource(request);
  }

  /** Low-level call: answers the parsed JSON body (or null for 204). */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const idempotent = options.idempotent ?? (method === "GET" || method === "DELETE");
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            accept: "application/json",
            "x-ignitra-client": `sdk-js/${SDK_VERSION}`,
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = controller.signal.aborted && !options.signal?.aborted;
        if (idempotent && attempt < this.#maxRetries && !options.signal?.aborted) {
          await sleep(backoff(attempt, null));
          continue;
        }
        throw new IgnitraNetworkError(timedOut ? `${method} ${path} timed out after ${this.#timeoutMs} ms` : `${method} ${path} failed: ${(err as Error).message}`, timedOut, err);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
      if (res.status === 204) return null as T;
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { error: { code: `http_${res.status}`, message: text.slice(0, 200) || `HTTP ${res.status}` } };
      }
      if (res.ok) return body as T;
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      // A 429 was refused before doing anything, so any method may repeat it.
      const retryable = res.status === 429 || (idempotent && (res.status === 502 || res.status === 503 || res.status === 504));
      if (retryable && attempt < this.#maxRetries) {
        await sleep(backoff(attempt, retryAfter));
        continue;
      }
      throw new IgnitraApiError(res.status, body, retryAfter);
    }
  }
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function backoff(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds !== null) return Math.min(retryAfterSeconds, 60) * 1000;
  return Math.round(500 * 2 ** attempt * (0.8 + Math.random() * 0.4));
}

type Requester = <T>(method: string, path: string, options?: RequestOptions) => Promise<T>;
const seg = encodeURIComponent;

export class FlowsResource {
  readonly #r: Requester;

  constructor(r: Requester) {
    this.#r = r;
  }

  async list(): Promise<Flow[]> {
    return (await this.#r<{ data: Flow[] }>("GET", "/v1/flows")).data;
  }

  async get(id: string): Promise<FlowDetail> {
    return (await this.#r<{ data: FlowDetail }>("GET", `/v1/flows/${seg(id)}`)).data;
  }

  /** Creates a flow (a paused draft unless `activate: true`). Steps without a step_id are named for you. */
  async create(input: CreateFlowInput): Promise<FlowDetail> {
    return (await this.#r<{ data: FlowDetail }>("POST", "/v1/flows", { body: { name: input.name, definition: toDefinition(definitionOf(input)), ...(input.activate !== undefined ? { activate: input.activate } : {}) } })).data;
  }

  /** A new definition becomes a new version; a name change does not. */
  async update(id: string, input: { name?: string; definition?: FlowDefinitionInput }): Promise<FlowDetail> {
    const body = { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.definition ? { definition: toDefinition(input.definition) } : {}) };
    return (await this.#r<{ data: FlowDetail }>("PATCH", `/v1/flows/${seg(id)}`, { body })).data;
  }

  async delete(id: string): Promise<void> {
    await this.#r("DELETE", `/v1/flows/${seg(id)}`);
  }

  async pause(id: string): Promise<FlowDetail> {
    return (await this.#r<{ data: FlowDetail }>("POST", `/v1/flows/${seg(id)}/pause`, { idempotent: true })).data;
  }

  async resume(id: string): Promise<FlowDetail> {
    return (await this.#r<{ data: FlowDetail }>("POST", `/v1/flows/${seg(id)}/resume`, { idempotent: true })).data;
  }

  /** Validates without saving: the normalized definition and the trigger's data fields. */
  async validate(definition: FlowDefinitionInput): Promise<ValidatedFlow & { definition: FlowDefinition }> {
    return (await this.#r<{ data: ValidatedFlow }>("POST", "/v1/flows/validate", { body: { definition: toDefinition(definition) }, idempotent: true })).data;
  }

  /** One TEST run with the latest real event (or your sample). Labelled TEST everywhere, never metered. */
  async test(id: string, options: { sample?: Record<string, unknown> } = {}): Promise<TestRunResult> {
    return (await this.#r<{ data: TestRunResult }>("POST", `/v1/flows/${seg(id)}/test`, { body: options.sample ? { sample: options.sample } : {} })).data;
  }

  /** INBOUND_WEBHOOK flows: a new hook URL; the old one stops working at once. */
  async rotateHook(id: string): Promise<{ hook_url: string }> {
    return (await this.#r<{ data: { hook_url: string } }>("POST", `/v1/flows/${seg(id)}/hook/rotate`)).data;
  }

  /** One page of runs, newest first. */
  async runs(id: string, options: { limit?: number; before?: string; status?: RunStatus } = {}): Promise<Page<Run>> {
    return this.#r<Page<Run>>("GET", `/v1/flows/${seg(id)}/runs`, { query: { limit: options.limit, before: options.before, status: options.status } });
  }

  /** Every run, newest first, fetching pages as you iterate. */
  async *iterateRuns(id: string, options: { status?: RunStatus; pageSize?: number } = {}): AsyncGenerator<Run, void, undefined> {
    let before: string | undefined;
    for (;;) {
      const page = await this.runs(id, { limit: options.pageSize ?? 100, ...(before ? { before } : {}), ...(options.status ? { status: options.status } : {}) });
      yield* page.data;
      if (!page.next_before) return;
      before = page.next_before;
    }
  }

  /** "Why it did not run": matches that conditions or limits held back. */
  async evaluations(id: string, options: { limit?: number; outcome?: EvaluationOutcome } = {}): Promise<Evaluation[]> {
    return (await this.#r<{ data: Evaluation[] }>("GET", `/v1/flows/${seg(id)}/evaluations`, { query: { limit: options.limit, outcome: options.outcome } })).data;
  }
}

export class RunsResource {
  readonly #r: Requester;

  constructor(r: Requester) {
    this.#r = r;
  }

  /** The full trace: trigger evidence, each condition with its actual value, every step attempt. */
  async get(id: string): Promise<RunDetail> {
    return (await this.#r<{ data: RunDetail }>("GET", `/v1/runs/${seg(id)}`)).data;
  }
}

export class ConnectionsResource {
  readonly #r: Requester;

  constructor(r: Requester) {
    this.#r = r;
  }

  async list(): Promise<Connection[]> {
    return (await this.#r<{ data: Connection[] }>("GET", "/v1/connections")).data;
  }

  /** Secrets go in and never come out; a signing secret is returned here, once. */
  async create(input: ConnectionInput): Promise<CreatedConnection> {
    const res = await this.#r<{ data: Connection; signing_secret?: string; verification?: "sent"; receiver_url?: string }>("POST", "/v1/connections", { body: input });
    return { connection: res.data, signingSecret: res.signing_secret ?? null, verification: res.verification ?? null, receiverUrl: res.receiver_url ?? null };
  }

  async delete(id: string): Promise<void> {
    await this.#r("DELETE", `/v1/connections/${seg(id)}`);
  }

  /** Email connections: confirm the 6-digit code sent to the address. */
  async verify(id: string, code: string): Promise<Connection> {
    return (await this.#r<{ data: Connection }>("POST", `/v1/connections/${seg(id)}/verify`, { body: { code } })).data;
  }

  /**
   * VIGIL connections made without an API key: register `receiverUrl` as a webhook in VIGIL,
   * then hand IGNITRA the signing secret VIGIL showed. Deliveries are refused until then.
   */
  async setVigilSecret(id: string, webhookSecret: string): Promise<Connection> {
    return (await this.#r<{ data: Connection }>("POST", `/v1/connections/${seg(id)}/verify`, { body: { webhook_secret: webhookSecret } })).data;
  }

  async resend(id: string): Promise<void> {
    await this.#r("POST", `/v1/connections/${seg(id)}/resend`);
  }
}

export class TemplatesResource {
  readonly #r: Requester;

  constructor(r: Requester) {
    this.#r = r;
  }

  async list(options: { category?: string } = {}): Promise<TemplateCard[]> {
    return (await this.#r<{ data: TemplateCard[] }>("GET", "/v1/templates", { query: { category: options.category } })).data;
  }

  async get(slug: string): Promise<TemplateDetail> {
    return (await this.#r<{ data: TemplateDetail }>("GET", `/v1/templates/${seg(slug)}`)).data;
  }

  /** Fills a template's placeholders and creates the flow (active unless `activate: false`). */
  async use(slug: string, input: { values: Record<string, unknown>; name?: string; activate?: boolean }): Promise<{ flow_id: string; status: string; version: number }> {
    return (await this.#r<{ data: { flow_id: string; status: string; version: number } }>("POST", `/v1/templates/${seg(slug)}/instantiate`, { body: input })).data;
  }

  /** Shares one of your flows as a template; destinations are replaced by placeholders. */
  async publish(input: PublishTemplateInput): Promise<{ template: TemplateDetail; url: string }> {
    const res = await this.#r<{ data: TemplateDetail; url: string }>("POST", "/v1/templates", { body: input });
    return { template: res.data, url: res.url };
  }

  async mine(): Promise<TemplateCard[]> {
    return (await this.#r<{ data: TemplateCard[] }>("GET", "/v1/me/templates")).data;
  }

  async delete(slug: string): Promise<void> {
    await this.#r("DELETE", `/v1/templates/${seg(slug)}`);
  }
}

export class CatalogResource {
  readonly #r: Requester;

  constructor(r: Requester) {
    this.#r = r;
  }

  async triggers(): Promise<TriggerInfo[]> {
    return (await this.#r<{ data: TriggerInfo[] }>("GET", "/v1/triggers")).data;
  }

  async actions(): Promise<ActionInfo[]> {
    return (await this.#r<{ data: ActionInfo[] }>("GET", "/v1/actions")).data;
  }
}

export class AccountResource {
  readonly #r: Requester;

  constructor(r: Requester) {
    this.#r = r;
  }

  async me(): Promise<User & { usage?: Omit<Usage, "plan"> }> {
    return (await this.#r<{ data: User & { usage?: Omit<Usage, "plan"> } }>("GET", "/v1/me")).data;
  }

  async usage(): Promise<Usage> {
    return (await this.#r<{ data: Usage }>("GET", "/v1/me/usage")).data;
  }

  /** The secret that signs your inline-URL webhooks: verify deliveries with `parseWebhook`. */
  async webhookSecret(): Promise<string> {
    return (await this.#r<{ data: { secret: string } }>("GET", "/v1/me/webhook-secret")).data.secret;
  }
}
