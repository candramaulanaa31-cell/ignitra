CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"actor" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor" CHECK (actor in ('session', 'api_key', 'operator', 'system')),
	CONSTRAINT "audit_log_action_format" CHECK (action ~ '^[a-z_]+[.][a-z_]+$')
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_owner_idx" ON "audit_log" USING btree ("owner_id","id");