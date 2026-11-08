CREATE TABLE "chain_verification" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"verified_block" bigint NOT NULL,
	"checked_blocks" bigint DEFAULT 0 NOT NULL,
	"missing_total" bigint DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_missing_at" timestamp with time zone,
	"last_missing" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
