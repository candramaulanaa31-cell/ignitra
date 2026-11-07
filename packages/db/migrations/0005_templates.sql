CREATE TABLE "template_stats" (
	"slug" text PRIMARY KEY NOT NULL,
	"uses" bigint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"placeholders" jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"visibility" text DEFAULT 'unlisted' NOT NULL,
	"hidden_at" timestamp with time zone,
	"source_flow_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_slug_format" CHECK (slug ~ '^[a-z0-9-]{3,80}$'),
	CONSTRAINT "templates_category_valid" CHECK (category in ('trading', 'community', 'treasury', 'security', 'reporting', 'developers')),
	CONSTRAINT "templates_visibility_valid" CHECK (visibility in ('unlisted', 'public'))
);
--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_source_flow_id_flows_id_fk" FOREIGN KEY ("source_flow_id") REFERENCES "public"."flows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "templates_slug_key" ON "templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "templates_owner_idx" ON "templates" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "templates_public_idx" ON "templates" USING btree ("created_at") WHERE visibility = 'public' and hidden_at is null;