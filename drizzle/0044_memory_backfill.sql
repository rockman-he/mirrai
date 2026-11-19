-- mirrai: idempotent-migration
--
-- The memory backfill: a run that reads an uploaded chat log batch by
-- batch and stores what it finds as memories. The row is the progress:
-- which batch the run reached, how much it added, and whether it was
-- interrupted — so an interrupted run can be taken up again.

CREATE TABLE IF NOT EXISTS "memory_backfills" (
  "id" serial PRIMARY KEY NOT NULL,
  "personaId" integer NOT NULL,
  "userId" integer NOT NULL,
  "fileId" integer NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "totalBatches" integer DEFAULT 0 NOT NULL,
  "doneBatches" integer DEFAULT 0 NOT NULL,
  "memoriesAdded" integer DEFAULT 0 NOT NULL,
  "error" text,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "memory_backfills_persona_user_idx"
  ON "memory_backfills" ("personaId", "userId");
