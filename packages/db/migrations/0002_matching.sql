CREATE SEQUENCE "public"."chain_events_confirmed_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."chain_events_reverted_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "consumer_offsets" (
	"name" text PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_evaluations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "flow_evaluations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"flow_id" text NOT NULL,
	"flow_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"trigger_event" jsonb NOT NULL,
	"conditions_result" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_evaluations_outcome_valid" CHECK (outcome in ('conditions_failed', 'rate_limited', 'undetermined'))
);
--> statement-breakpoint
CREATE TABLE "flow_stats" (
	"flow_id" text PRIMARY KEY NOT NULL,
	"matched" bigint DEFAULT 0 NOT NULL,
	"runs" bigint DEFAULT 0 NOT NULL,
	"conditions_failed" bigint DEFAULT 0 NOT NULL,
	"rate_limited" bigint DEFAULT 0 NOT NULL,
	"undetermined" bigint DEFAULT 0 NOT NULL,
	"last_matched_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_state" (
	"flow_id" text PRIMARY KEY NOT NULL,
	"flow_version" integer NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chain_events" ADD COLUMN "confirmed_seq" bigint;--> statement-breakpoint
ALTER TABLE "chain_events" ADD COLUMN "reverted_seq" bigint;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "chain_event_id" bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "reverted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "revert_reason" text;--> statement-breakpoint
ALTER TABLE "flow_evaluations" ADD CONSTRAINT "flow_evaluations_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD CONSTRAINT "flow_stats_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_state" ADD CONSTRAINT "trigger_state_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_evaluations_key" ON "flow_evaluations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "flow_evaluations_flow_idx" ON "flow_evaluations" USING btree ("flow_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_confirmed_seq_key" ON "chain_events" USING btree ("confirmed_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_reverted_seq_key" ON "chain_events" USING btree ("reverted_seq");--> statement-breakpoint
CREATE INDEX "runs_chain_event_idx" ON "runs" USING btree ("chain_event_id");