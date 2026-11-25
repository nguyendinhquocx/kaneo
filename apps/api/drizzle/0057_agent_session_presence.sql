CREATE TABLE "agent_session_presence" (
	"session_id" text PRIMARY KEY NOT NULL,
	"agent_principal_id" text NOT NULL,
	"host" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"cwd" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_session_presence_last_seen_idx" ON "agent_session_presence" USING btree ("last_seen_at");