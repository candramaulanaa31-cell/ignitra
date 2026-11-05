CREATE TABLE "chain_cursors" (
	"chain_id" integer NOT NULL,
	"stream" text NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_cursors_pkey" PRIMARY KEY("chain_id","stream"),
	CONSTRAINT "chain_cursors_stream_valid" CHECK (stream in ('confirmed', 'pending')),
	CONSTRAINT "chain_cursors_block_nonneg" CHECK (block_number >= 0)
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chain_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chain_id" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"block_timestamp" timestamp with time zone,
	"tx_hash" text NOT NULL,
	"tx_index" integer NOT NULL,
	"log_index" integer NOT NULL,
	"address" text NOT NULL,
	"topic0" text,
	"topics" jsonb NOT NULL,
	"data" text NOT NULL,
	"event_name" text,
	"event_signature" text,
	"args" jsonb,
	"abi_source" text,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"revert_reason" text,
	CONSTRAINT "chain_events_identity_key" UNIQUE("chain_id","block_hash","log_index"),
	CONSTRAINT "chain_events_status_valid" CHECK (status in ('pending', 'confirmed', 'reverted')),
	CONSTRAINT "chain_events_confirmed_has_ts" CHECK (status <> 'confirmed' or confirmed_at is not null),
	CONSTRAINT "chain_events_reverted_has_ts" CHECK (status <> 'reverted' or reverted_at is not null),
	CONSTRAINT "chain_events_address_canonical" CHECK (address ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "chain_events_hashes_canonical" CHECK (block_hash ~ '^0x[0-9a-f]{64}$' and tx_hash ~ '^0x[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "chain_sync_status" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"head_block" bigint NOT NULL,
	"confirmed_head" bigint NOT NULL,
	"confirmed_cursor" bigint NOT NULL,
	"pending_cursor" bigint,
	"watch_count" integer NOT NULL,
	"rpc" jsonb NOT NULL,
	"last_error" text,
	"last_deep_reorg_at" timestamp with time zone,
	"last_tick_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_abis" (
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"abi" jsonb,
	"implementation" text,
	"source" text NOT NULL,
	"error" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_abis_pkey" PRIMARY KEY("chain_id","address"),
	CONSTRAINT "contract_abis_status_valid" CHECK (status in ('verified', 'unverified', 'error')),
	CONSTRAINT "contract_abis_verified_has_abi" CHECK (status <> 'verified' or abi is not null),
	CONSTRAINT "contract_abis_address_canonical" CHECK (address ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"id" text PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"address" text NOT NULL,
	"topic0" text,
	"fast" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"flow_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_identity_key" UNIQUE NULLS NOT DISTINCT("chain_id","address","topic0","flow_id"),
	CONSTRAINT "watches_address_canonical" CHECK (address ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "watches_topic0_format" CHECK (topic0 is null or topic0 ~ '^0x[0-9a-f]{64}$'),
	CONSTRAINT "watches_source_valid" CHECK (source in ('flow', 'manual')),
	CONSTRAINT "watches_flow_iff_source_flow" CHECK ((source = 'flow') = (flow_id is not null))
);
--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_events_status_block_idx" ON "chain_events" USING btree ("chain_id","status","block_number");--> statement-breakpoint
CREATE INDEX "chain_events_address_block_idx" ON "chain_events" USING btree ("chain_id","address","block_number");--> statement-breakpoint
CREATE INDEX "chain_events_tx_idx" ON "chain_events" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX "watches_chain_idx" ON "watches" USING btree ("chain_id");