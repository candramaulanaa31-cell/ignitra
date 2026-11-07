CREATE TABLE "auth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_nonces_format" CHECK (nonce ~ '^[A-Za-z0-9]{8,64}$')
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbound_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"content_type" text,
	"body" jsonb NOT NULL,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bytes" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_events_dedupe_length" CHECK (char_length(dedupe_key) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "inbound_hooks" (
	"flow_id" text PRIMARY KEY NOT NULL,
	"salt" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"chain_id" integer NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_token_hash_format" CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "usage_monthly" (
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"runs" bigint DEFAULT 0 NOT NULL,
	"plan_limited" bigint DEFAULT 0 NOT NULL,
	"limit_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_monthly_pkey" PRIMARY KEY("user_id","period"),
	CONSTRAINT "usage_monthly_period_format" CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "usage_monthly_nonneg" CHECK (runs >= 0 and plan_limited >= 0)
);
--> statement-breakpoint
ALTER TABLE "flow_evaluations" DROP CONSTRAINT "flow_evaluations_outcome_valid";--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "plan_limited" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "missed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_hooks" ADD CONSTRAINT "inbound_hooks_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_monthly" ADD CONSTRAINT "usage_monthly_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_nonces_expires_idx" ON "auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_dedupe_key" ON "inbound_events" USING btree ("flow_id","dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_request_key" ON "inbound_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "inbound_events_received_idx" ON "inbound_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "inbound_events_flow_received_idx" ON "inbound_events" USING btree ("flow_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "flow_evaluations" ADD CONSTRAINT "flow_evaluations_outcome_valid" CHECK (outcome in ('conditions_failed', 'rate_limited', 'plan_limited', 'undetermined', 'missed'));