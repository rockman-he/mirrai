-- mirrai: idempotent-migration
--
-- How far the memories already reach: the time of the last message a
-- backfill has actually read. The interface shows it before a new run,
-- so the user uploads only what comes after it instead of paying for
-- the same conversations twice.

ALTER TABLE "memory_backfills" ADD COLUMN IF NOT EXISTS "coveredUntil" timestamp;
