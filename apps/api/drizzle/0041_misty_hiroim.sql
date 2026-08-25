ALTER TABLE "execution_schedule_occurrence" ADD COLUMN "claim_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_schedule" ADD COLUMN "request_key" text;--> statement-breakpoint
UPDATE "execution_schedule" SET "request_key" = 'legacy:' || "id" WHERE "request_key" IS NULL;--> statement-breakpoint
ALTER TABLE "execution_schedule" ALTER COLUMN "request_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_schedule" ADD CONSTRAINT "execution_schedule_request_key_unique" UNIQUE("request_key");