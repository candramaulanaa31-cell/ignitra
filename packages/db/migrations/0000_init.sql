CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"secret_enc" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_label_length" CHECK (char_length(label) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "flow_versions" (
	"flow_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_versions_pkey" PRIMARY KEY("flow_id","version"),
	CONSTRAINT "flow_versions_version_positive" CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"status_reason" text,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flows_status_valid" CHECK (status in ('active', 'paused', 'disabled')),
	CONSTRAINT "flows_name_length" CHECK (char_length(name) between 1 and 120),
	CONSTRAINT "flows_current_version_positive" CHECK (current_version >= 1)
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"position" integer NOT NULL,
	"action_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"request" jsonb,
	"response" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_steps_pkey" PRIMARY KEY("run_id","step_id"),
	CONSTRAINT "run_steps_status_valid" CHECK (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "run_steps_attempts_nonneg" CHECK (attempts >= 0),
	CONSTRAINT "run_steps_position_nonneg" CHECK (position >= 0),
	CONSTRAINT "run_steps_finished_iff_final" CHECK ((finished_at is null) = (status in ('pending', 'running')))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"flow_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_event" jsonb NOT NULL,
	"conditions_result" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_status_valid" CHECK (status in ('queued', 'running', 'succeeded', 'partial', 'failed', 'skipped')),
	CONSTRAINT "runs_finished_iff_final" CHECK ((finished_at is null) = (status in ('queued', 'running')))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_address_canonical" CHECK (address ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "users_plan_valid" CHECK (plan in ('free', 'builder', 'team'))
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_flow_version_fkey" FOREIGN KEY ("flow_id","flow_version") REFERENCES "public"."flow_versions"("flow_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_owner_idx" ON "connections" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "flows_owner_idx" ON "flows" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "flows_status_idx" ON "flows" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_position_key" ON "run_steps" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_key_key" ON "runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "runs_flow_created_idx" ON "runs" USING btree ("flow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_open_idx" ON "runs" USING btree ("status","created_at") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "users_address_key" ON "users" USING btree ("address");