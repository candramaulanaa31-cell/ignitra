CREATE TABLE "owner_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"flow_id" text,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_https" CHECK (endpoint like 'https://%')
);
--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "runs_succeeded" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "runs_partial" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "runs_failed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "runs_skipped" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "flow_stats" ADD COLUMN "last_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "revert_notice" jsonb;--> statement-breakpoint
ALTER TABLE "owner_notifications" ADD CONSTRAINT "owner_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_notifications" ADD CONSTRAINT "owner_notifications_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_notifications_user_idx" ON "owner_notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "owner_notifications_unpushed_idx" ON "owner_notifications" USING btree ("created_at") WHERE pushed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "runs_claim_idx" ON "runs" USING btree ("next_attempt_at","created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "runs_lease_idx" ON "runs" USING btree ("lease_until") WHERE status = 'running';