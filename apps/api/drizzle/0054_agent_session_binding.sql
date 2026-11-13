CREATE TABLE "agent_session_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_principal_id" text NOT NULL,
	"host_id" text NOT NULL,
	"session_id" text NOT NULL,
	"binding_generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_heartbeat_at" timestamp,
	"revoked_at" timestamp,
	"revoked_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"binding_id" text NOT NULL,
	"task_id" text NOT NULL,
	"client_action_key" text NOT NULL,
	"comment_id" text,
	"comment_updated_at" timestamp,
	"comment_content_hash" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"claimed_at" timestamp,
	"claimed_lease_expires_at" timestamp,
	"enqueued_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_delivery_action_key_unique" UNIQUE("binding_id","client_action_key")
);
--> statement-breakpoint
ALTER TABLE "agent_session_binding" ADD CONSTRAINT "agent_session_binding_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_binding" ADD CONSTRAINT "agent_session_binding_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_binding" ADD CONSTRAINT "agent_session_binding_agent_principal_id_agent_principal_id_fk" FOREIGN KEY ("agent_principal_id") REFERENCES "public"."agent_principal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_delivery" ADD CONSTRAINT "agent_session_delivery_binding_id_agent_session_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."agent_session_binding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_session_binding_active_task_unique" ON "agent_session_binding" USING btree ("task_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "agent_session_binding_principal_idx" ON "agent_session_binding" USING btree ("agent_principal_id");--> statement-breakpoint
CREATE INDEX "agent_session_binding_session_idx" ON "agent_session_binding" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "agent_session_delivery_state_idx" ON "agent_session_delivery" USING btree ("binding_id","state");