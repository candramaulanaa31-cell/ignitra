CREATE TABLE "onchain_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"flow_id" text,
	"run_id" text,
	"step_id" text,
	"idempotency_key" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"to_address" text NOT NULL,
	"function_signature" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"value_wei" text DEFAULT '0' NOT NULL,
	"status" text NOT NULL,
	"mandate" jsonb,
	"nonce" integer,
	"raw_tx" text,
	"tx_hash" text,
	"block_number" bigint,
	"gas_used" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onchain_actions_status" CHECK (status in ('simulated', 'denied', 'signed', 'sent', 'confirmed', 'reverted', 'failed')),
	CONSTRAINT "onchain_actions_value" CHECK (value_wei ~ '^[0-9]{1,78}$')
);
--> statement-breakpoint
CREATE TABLE "onchain_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"chain_id" integer NOT NULL,
	"label" text NOT NULL,
	"safe_address" text NOT NULL,
	"roles_address" text NOT NULL,
	"role_key" text NOT NULL,
	"session_key_address" text NOT NULL,
	"session_key_enc" jsonb,
	"scope" jsonb NOT NULL,
	"mandate_connection_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"grant_tx_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "onchain_grants_status" CHECK (status in ('pending', 'active', 'revoked', 'expired')),
	CONSTRAINT "onchain_grants_addresses" CHECK (safe_address ~ '^0x[0-9a-f]{40}$' and roles_address ~ '^0x[0-9a-f]{40}$' and session_key_address ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "onchain_grants_key_wiped" CHECK (status in ('pending', 'active') or session_key_enc is null)
);
--> statement-breakpoint
ALTER TABLE "onchain_actions" ADD CONSTRAINT "onchain_actions_grant_id_onchain_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."onchain_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_actions" ADD CONSTRAINT "onchain_actions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_grants" ADD CONSTRAINT "onchain_grants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onchain_grants" ADD CONSTRAINT "onchain_grants_mandate_connection_id_connections_id_fk" FOREIGN KEY ("mandate_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onchain_actions_idempotency_key" ON "onchain_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "onchain_actions_grant_idx" ON "onchain_actions" USING btree ("grant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "onchain_actions_owner_idx" ON "onchain_actions" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "onchain_grants_owner_idx" ON "onchain_grants" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onchain_grants_role_key" ON "onchain_grants" USING btree ("roles_address","role_key");