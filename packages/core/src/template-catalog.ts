import type { FlowTemplate } from "./flow-templates";

/**
 * Official templates (spec §5 "Templates — growth engine"). Each is a complete,
 * production-quality flow with placeholders; CI instantiates every one with
 * its examples and validates it against the real trigger / action modules.
 *
 * Adapted from the spec's list: Discord → Telegram (the MVP chat action);
 * "Contract upgraded (VIGIL)" uses the EIP-1967 Upgraded event until the VIGIL
 * integration (Phase 8); "daily holder count" is not readable on-chain without
 * an indexer, so the daily report snapshots supply; Pons launches arrive with
 * the Pons integration (Phase 8) — "new contract from a deployer" covers
 * factories that deploy with CREATE today.
 */

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const EXAMPLE_WALLET = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const p = (key: string) => ({ $param: key });
const tx = '<a href="{{trigger.explorer_url}}">View on explorer</a>';

export const OFFICIAL_TEMPLATES: readonly FlowTemplate[] = [
  {
    slug: "big-buy-telegram",
    name: "Big buy alert → Telegram",
    summary: "Post every transfer above a share of supply to your Telegram group.",
    description:
      "Fires on each confirmed transfer of your token that moves at least the given percentage of total supply (mints excluded). The message shows the amount, the share of supply, the recipient and a link to the transaction.",
    category: "trading",
    tags: ["token", "whales", "telegram"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG, help: "The ERC-20 contract on Robinhood Chain." },
      { key: "threshold", label: "Minimum % of supply", type: "decimal", default: "0.5", help: "0.5 = half a percent of total supply." },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "TOKEN_TRANSFER", params: { token: p("token") } },
      conditions: {
        all: [
          { field: "percent_of_supply", op: ">=", value: p("threshold") },
          { field: "is_mint", op: "==", value: false },
        ],
      },
      actions: [
        {
          step_id: "notify",
          type: "TELEGRAM",
          params: {
            connection_id: p("chat"),
            text: `🔥 <b>Big buy: {{trigger.amount_formatted}} {{trigger.token.symbol}}</b>\n{{trigger.percent_of_supply}}% of supply → <code>{{trigger.to | short}}</code>\n${tx}`,
          },
        },
      ],
      settings: { mode: "confirmed", max_runs_per_hour: 60 },
    },
    shareText: "🔥 Big buy alerts for any Robinhood Chain token, straight to Telegram.\nPaste the token, pick a chat, set the % of supply. Live in 2 minutes.",
  },
  {
    slug: "whale-sell-push",
    name: "Whale sell → Web Push",
    summary: "A push notification on your phone when a whale wallet sends a large amount.",
    description: "Watches one wallet (a whale, a team or a treasury) and notifies your devices when it sends at least the given amount of the token. Tap the notification to open the transaction.",
    category: "trading",
    tags: ["whales", "push", "wallet"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "whale", label: "Whale wallet", type: "address", example: EXAMPLE_WALLET },
      { key: "min_amount", label: "Minimum amount (token units)", type: "decimal", default: "10000" },
    ],
    definition: {
      trigger: { type: "TOKEN_TRANSFER", params: { token: p("token"), wallet: p("whale"), direction: "out" } },
      conditions: { all: [{ field: "amount_decimal", op: ">=", value: p("min_amount") }] },
      actions: [
        {
          step_id: "push",
          type: "WEB_PUSH",
          params: { title: "🐋 Whale sent {{trigger.amount_formatted}} {{trigger.token.symbol}}", body: "{{trigger.from | short}} → {{trigger.to | short}}", url: "{{trigger.explorer_url}}" },
        },
      ],
    },
    shareText: "🐋 Get a push on your phone the moment a whale wallet moves your token. No bot, no server.",
  },
  {
    slug: "new-holder-sheets",
    name: "New holder → Google Sheets",
    summary: "Log every new holder of your token as a row in a spreadsheet.",
    description:
      "Adds a row when an address starts holding your token (balance goes from zero to non-zero, decided per transaction so router hops are not counted). Columns: time, holder, amount, symbol, transaction and the run's unique key for deduplication.",
    category: "community",
    tags: ["holders", "sheets", "growth"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "google", label: "Google account", type: "connection", connectionType: "google" },
      { key: "spreadsheet", label: "Spreadsheet", type: "spreadsheet", help: "Paste the spreadsheet URL." },
      { key: "sheet", label: "Tab", type: "text", default: "Holders" },
    ],
    definition: {
      trigger: { type: "NEW_HOLDER", params: { token: p("token") } },
      actions: [
        {
          step_id: "row",
          type: "GOOGLE_SHEETS",
          params: {
            connection_id: p("google"),
            spreadsheet: p("spreadsheet"),
            sheet: p("sheet"),
            values: ["{{trigger.time.iso}}", "{{trigger.holder}}", "{{trigger.amount_decimal}}", "{{trigger.token.symbol}}", "{{trigger.explorer_url}}", "{{run.idempotency_key}}"],
          },
        },
      ],
    },
    shareText: "📈 Every new holder of your token, one row in Google Sheets. Router hops filtered out.",
  },
  {
    slug: "new-holder-welcome-telegram",
    name: "Welcome new holders → Telegram",
    summary: "Celebrate each new holder in your community chat.",
    description: "Posts a short welcome when an address starts holding your token, with the amount and a link to the transaction.",
    category: "community",
    tags: ["holders", "telegram", "community"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "NEW_HOLDER", params: { token: p("token") } },
      actions: [
        {
          step_id: "welcome",
          type: "TELEGRAM",
          params: { connection_id: p("chat"), text: `🎉 New {{trigger.token.symbol}} holder <code>{{trigger.holder | short}}</code> with {{trigger.amount_formatted}}\n${tx}` },
        },
      ],
      settings: { mode: "confirmed", max_runs_per_hour: 120 },
    },
    shareText: "🎉 Welcome every new holder of your token in Telegram, automatically.",
  },
  {
    slug: "treasury-low-email",
    name: "Treasury low balance → email",
    summary: "Email the team when a wallet's ETH balance drops below a threshold.",
    description: "Samples the wallet at the confirmed head and emails once when the balance crosses below the threshold (not on every check while it stays low).",
    category: "treasury",
    tags: ["treasury", "email", "eth"],
    placeholders: [
      { key: "wallet", label: "Treasury wallet", type: "address", example: EXAMPLE_WALLET },
      { key: "threshold", label: "Threshold (ETH)", type: "decimal", default: "2" },
      { key: "email", label: "Email address", type: "connection", connectionType: "email" },
    ],
    definition: {
      trigger: { type: "BALANCE_THRESHOLD", params: { wallet: p("wallet"), asset: "native", threshold: p("threshold"), direction: "below" } },
      actions: [
        {
          step_id: "mail",
          type: "EMAIL",
          params: {
            connection_id: p("email"),
            subject: "⚠️ Treasury below {{trigger.threshold}} ETH",
            body: "Wallet {{trigger.wallet}} now holds {{trigger.balance_after_formatted}} ETH (it held {{trigger.balance_before_decimal}} ETH).\n\nBlock {{trigger.block_number}} · {{trigger.time.iso}}\n{{trigger.explorer_url}}",
          },
        },
      ],
    },
    shareText: "⚠️ Never let a treasury or hot wallet run dry: an email the moment it drops below your threshold.",
  },
  {
    slug: "token-balance-low-telegram",
    name: "Hot wallet low on a token → Telegram",
    summary: "Warn your ops chat when a wallet's token balance falls below a level.",
    description: "Like the treasury alert, for any ERC-20 (USDG, a reward token…): one message per crossing below the threshold, in token units.",
    category: "treasury",
    tags: ["treasury", "token", "telegram"],
    placeholders: [
      { key: "wallet", label: "Wallet", type: "address", example: EXAMPLE_WALLET },
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "threshold", label: "Threshold (token units)", type: "decimal", default: "1000" },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "BALANCE_THRESHOLD", params: { wallet: p("wallet"), asset: p("token"), threshold: p("threshold"), direction: "below" } },
      actions: [
        {
          step_id: "warn",
          type: "TELEGRAM",
          params: { connection_id: p("chat"), text: "🪫 <code>{{trigger.wallet | short}}</code> is down to <b>{{trigger.balance_after_formatted}} {{trigger.token.symbol}}</b> (threshold {{trigger.threshold}})" },
        },
      ],
    },
    shareText: "🪫 Hot wallet running low on USDG? Get told in Telegram before payouts fail.",
  },
  {
    slug: "proxy-upgraded-webhook",
    name: "Proxy upgraded → webhook",
    summary: "Call your API when a proxy contract changes its implementation.",
    description: "Listens for the EIP-1967 Upgraded event of a proxy and sends a signed webhook to your server, e.g. to pause a frontend until the new implementation is reviewed.",
    category: "security",
    tags: ["security", "proxy", "webhook"],
    placeholders: [
      { key: "proxy", label: "Proxy contract", type: "address", example: USDG },
      { key: "url", label: "Your webhook URL", type: "url" },
    ],
    definition: {
      trigger: { type: "CONTRACT_EVENT", params: { address: p("proxy"), event: "event Upgraded(address indexed implementation)" } },
      actions: [{ step_id: "hook", type: "WEBHOOK", params: { url: p("url") } }],
    },
    shareText: "🛡️ A contract you depend on just got upgraded? Your server finds out first, with a signed webhook.",
  },
  {
    slug: "ownership-transferred-telegram",
    name: "Ownership change → Telegram",
    summary: "Know immediately when a contract's owner changes.",
    description: "Watches the OwnershipTransferred event (OpenZeppelin Ownable) and posts the previous and new owner to your security chat.",
    category: "security",
    tags: ["security", "ownable", "telegram"],
    placeholders: [
      { key: "contract", label: "Contract", type: "address", example: USDG },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "CONTRACT_EVENT", params: { address: p("contract"), event: "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)" } },
      actions: [
        {
          step_id: "alert",
          type: "TELEGRAM",
          params: { connection_id: p("chat"), text: `🔐 <b>Ownership changed</b> on <code>{{trigger.contract | short}}</code>\n{{trigger.args.previousOwner | short}} → {{trigger.args.newOwner | short}}\n${tx}` },
        },
      ],
    },
    shareText: "🔐 Ownership of a contract changed? Your security chat knows within seconds.",
  },
  {
    slug: "paused-telegram",
    name: "Contract paused or unpaused → Telegram",
    summary: "Alert when a pausable contract flips its paused state.",
    description: "Reads paused() on every confirmed head sample and posts when the value changes (true = paused).",
    category: "security",
    tags: ["security", "pausable", "telegram"],
    placeholders: [
      { key: "contract", label: "Pausable contract", type: "address", example: USDG },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "STATE_CHANGE", params: { address: p("contract"), function: "function paused() view returns (bool)" } },
      actions: [{ step_id: "alert", type: "TELEGRAM", params: { connection_id: p("chat"), text: "⏸️ <code>{{trigger.contract | short}}</code> paused: {{trigger.previous}} → <b>{{trigger.current}}</b> (block {{trigger.block_number}})" } }],
    },
    shareText: "⏸️ Pause switches matter. Get a Telegram alert when a contract is paused or unpaused.",
  },
  {
    slug: "daily-supply-sheets",
    name: "Daily supply snapshot → Google Sheets",
    summary: "Every morning, append the token's total supply to a spreadsheet.",
    description:
      "Runs on a schedule (08:00 WIB by default), reads totalSupply() at the latest block and appends date, supply and block. Holder counts need an indexer, so this report tracks supply; add more columns with balanceOf reads for wallets you watch.",
    category: "reporting",
    tags: ["schedule", "sheets", "supply"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "schedule", label: "When (cron)", type: "cron", default: "0 8 * * *", help: "0 8 * * * = every day at 08:00 in WIB." },
      { key: "google", label: "Google account", type: "connection", connectionType: "google" },
      { key: "spreadsheet", label: "Spreadsheet", type: "spreadsheet" },
      { key: "sheet", label: "Tab", type: "text", default: "Supply" },
    ],
    definition: {
      trigger: { type: "SCHEDULE", params: { cron: p("schedule"), timezone: "Asia/Jakarta" } },
      actions: [
        { step_id: "supply", type: "CHAIN_READ", params: { address: p("token"), function: "function totalSupply() view returns (uint256)" } },
        {
          step_id: "row",
          type: "GOOGLE_SHEETS",
          params: { connection_id: p("google"), spreadsheet: p("spreadsheet"), sheet: p("sheet"), values: ["{{trigger.scheduled_at_local}}", "{{steps.supply.result}}", "{{steps.supply.block_number}}"] },
        },
      ],
    },
    shareText: "📊 A daily supply snapshot of your token in Google Sheets, every morning at 08:00 WIB.",
  },
  {
    slug: "new-contract-telegram",
    name: "New contract from a deployer → Telegram",
    summary: "Spot every contract a wallet or CREATE factory deploys.",
    description: "Follows a deployer's nonce and posts each new contract it creates (wallets and factories that deploy with CREATE). Useful to catch launches from a known team or launchpad factory.",
    category: "developers",
    tags: ["deployments", "launches", "telegram"],
    placeholders: [
      { key: "deployer", label: "Deployer (wallet or factory)", type: "address", example: EXAMPLE_WALLET },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "CONTRACT_DEPLOYED", params: { deployer: p("deployer") } },
      actions: [
        {
          step_id: "post",
          type: "TELEGRAM",
          params: { connection_id: p("chat"), text: '🆕 <code>{{trigger.deployer | short}}</code> deployed <code>{{trigger.contract}}</code>\n<a href="{{trigger.explorer_url}}">Open the contract</a>' },
        },
      ],
    },
    shareText: "🆕 Be first to see every new contract from a team or launchpad factory, in Telegram.",
  },
  {
    slug: "large-transfer-webhook",
    name: "Large transfers → your server",
    summary: "A signed, idempotent webhook for every transfer above an amount.",
    description:
      "Sends IGNITRA's run.action envelope (HMAC-SHA256 signed, same idempotency key on every retry) to your endpoint for each confirmed transfer of at least the amount. Verify X-Ignitra-Signature with your webhook secret from Settings.",
    category: "developers",
    tags: ["webhook", "token", "backend"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "min_amount", label: "Minimum amount (token units)", type: "decimal", default: "1000" },
      { key: "url", label: "Your webhook URL", type: "url" },
    ],
    definition: {
      trigger: { type: "TOKEN_TRANSFER", params: { token: p("token") } },
      conditions: { all: [{ field: "amount_decimal", op: ">=", value: p("min_amount") }] },
      actions: [{ step_id: "hook", type: "WEBHOOK", params: { url: p("url") } }],
    },
    shareText: "⚡ Large transfers of any Robinhood Chain token → your backend. Signed, retried, never twice.",
  },
  {
    slug: "mint-burn-telegram",
    name: "Mints and burns → Telegram",
    summary: "Track supply changes of your token as they happen.",
    description: "Posts every mint (from the zero address) and burn (to the zero address) of the token, with the amount and the transaction.",
    category: "security",
    tags: ["supply", "mint", "telegram"],
    placeholders: [
      { key: "token", label: "Token", type: "address", example: USDG },
      { key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" },
    ],
    definition: {
      trigger: { type: "TOKEN_TRANSFER", params: { token: p("token") } },
      conditions: {
        any: [
          { field: "is_mint", op: "==", value: true },
          { field: "is_burn", op: "==", value: true },
        ],
      },
      actions: [
        {
          step_id: "post",
          type: "TELEGRAM",
          params: { connection_id: p("chat"), text: `🪙 <b>{{trigger.token.symbol}} supply change: {{trigger.amount_formatted}}</b>\n{{trigger.from | short}} → {{trigger.to | short}} (mint = {{trigger.is_mint}})\n${tx}` },
        },
      ],
    },
    shareText: "🪙 Every mint and burn of your token, posted to Telegram as it happens.",
  },
  {
    slug: "inbound-telegram-relay",
    name: "Your app → Telegram (inbound webhook)",
    summary: "Give any system a URL that posts its events to Telegram.",
    description:
      'Creates a private signed URL. POST JSON like {"title": "Deploy finished", "message": "v1.4 is live"} and it lands in your chat. Add an Idempotency-Key header to make retries safe.',
    category: "developers",
    tags: ["inbound", "webhook", "telegram"],
    placeholders: [{ key: "chat", label: "Telegram chat", type: "connection", connectionType: "telegram" }],
    definition: {
      trigger: { type: "INBOUND_WEBHOOK", params: {} },
      actions: [
        {
          step_id: "relay",
          type: "TELEGRAM",
          params: { connection_id: p("chat"), text: '📨 <b>{{trigger.body.title | default: "New event"}}</b>\n{{trigger.body.message | default: ""}}' },
        },
      ],
    },
    shareText: "📨 One URL, any app: POST JSON, get a Telegram message. Signed and deduplicated.",
  },
];

export function findOfficialTemplate(slug: string): FlowTemplate | undefined {
  return OFFICIAL_TEMPLATES.find((t) => t.slug === slug);
}
