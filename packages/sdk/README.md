# @ignitra/sdk

The TypeScript SDK for **IGNITRA**, onchain automation for Robinhood Chain (chain id `4663`):
create and manage flows, read runs and their traces, manage connections and templates, and
verify the webhooks IGNITRA sends you.

- No dependencies. Runs in Node 20+, Deno, Bun, browsers and edge runtimes.
- Typed: every request and answer is described in `types.ts`.
- Safe retries: a rate-limited answer (429) is retried after `Retry-After`; 502/503/504 and
  network errors are retried only for requests that are safe to repeat.

```sh
npm install @ignitra/sdk
```

## Authentication

Create an API key in IGNITRA under **Settings → API keys** (Team plan). The key (`igk_…`) is
shown once. Keep it on your server; it acts as your account. A wallet session token (`igs_…`,
from `POST /v1/auth/verify` with `return_token: true`) also works, on any plan.

```ts
import { Ignitra } from "@ignitra/sdk";

const ignitra = new Ignitra({
  apiKey: process.env.IGNITRA_API_KEY, // or set IGNITRA_API_KEY
  baseUrl: "https://<your IGNITRA site>/api", // or set IGNITRA_API_URL
});
```

## Flows

```ts
const flow = await ignitra.flows.create({
  name: "Big buys → my server",
  trigger: { type: "TOKEN_TRANSFER", params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } },
  conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 1 }] },
  actions: [{ type: "WEBHOOK", params: { url: "https://myapp.com/hook" } }],
  activate: true,
});
```

Steps without a `step_id` are named for you (`webhook`, `webhook_2`, …). Later steps read earlier
outputs as `{{steps.<step_id>.…}}`.

| Call | |
|---|---|
| `flows.list()`, `flows.get(id)` | Your flows; `get` includes the definition |
| `flows.create(input)`, `flows.update(id, { name?, definition? })`, `flows.delete(id)` | A new definition becomes a new version |
| `flows.pause(id)`, `flows.resume(id)` | Resuming re-validates and applies the plan's limits |
| `flows.validate(definition)` | Checks without saving; answers the normalized definition and the trigger's data fields |
| `flows.test(id, { sample? })` | One TEST run with the latest real event. Labelled TEST everywhere, never metered |
| `flows.runs(id, { limit?, before?, status? })` | One page of runs, newest first |
| `flows.iterateRuns(id)` | Every run, fetching pages as you go: `for await (const run of …)` |
| `flows.evaluations(id)` | "Why it did not run": matches held back by conditions or limits |
| `runs.get(id)` | The full trace: trigger evidence, every condition with its actual value, every step attempt |
| `runs.deadLetters()`, `runs.iterateDeadLetters()`, `runs.retry(id)` | Runs whose steps failed for good, and running those steps again (same idempotency keys; delivered steps are not repeated) |
| `connections.list() / create() / delete() / verify()` | Secrets go in and never come out |
| `connections.setVigilSecret(id, secret)` | A VIGIL connection made without an API key: the secret VIGIL showed for its receiver URL |
| `templates.list() / get() / use() / publish() / mine() / delete()` | The template gallery |
| `catalog.triggers()`, `catalog.actions()` | Every trigger and action with its params and data |
| `account.me()`, `account.usage()`, `account.webhookSecret()` | Your plan, usage, and the secret that signs your webhooks |
| `account.auditLog()`, `account.iterateAuditLog()` | Every change to the account: who (wallet session, API key, operator, system), what, from where |

## Errors

```ts
import { IgnitraApiError } from "@ignitra/sdk";

try {
  await ignitra.flows.create(input);
} catch (err) {
  if (err instanceof IgnitraApiError && err.status === 422) {
    for (const issue of err.issues) console.log(issue.path, issue.message);
  }
  throw err;
}
```

`IgnitraApiError` carries `status`, `code`, `issues`, `details` (e.g. `limit`, `plan` and `max` on a
402) and `retryAfter`. `IgnitraNetworkError` means no answer arrived (`timedOut` tells which).

## Verifying webhooks

Every webhook carries `X-Ignitra-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`
and `X-Ignitra-Timestamp`. Verify over the **raw** body, before parsing JSON:

```ts
import { parseWebhook, IgnitraSignatureError } from "@ignitra/sdk";

// Express: app.post("/ignitra", express.text({ type: "application/json" }), handler)
async function handler(req, res) {
  let event;
  try {
    event = await parseWebhook(req.body, req.headers, process.env.IGNITRA_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof IgnitraSignatureError) return res.sendStatus(401);
    throw err;
  }
  // At-least-once delivery: ignore an idempotency key you have handled before.
  if (await seen(req.headers["x-ignitra-idempotency-key"])) return res.sendStatus(200);
  if (event.type === "run.action" && !event.test) {
    // event.trigger has the full trigger data
  }
  res.sendStatus(200);
}
```

On edge runtimes, pass the `Request`'s `Headers` and `await request.text()` as the body.
`verifyWebhookSignature` answers a boolean instead of throwing. `signWebhookPayload` signs a body
the way IGNITRA does, for testing your receiver.

## Requirements

Node 20 or later (for `fetch` and WebCrypto), or any runtime that has both.
