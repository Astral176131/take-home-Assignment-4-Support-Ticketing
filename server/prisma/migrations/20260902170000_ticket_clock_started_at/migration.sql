-- The SLA clock restarts when a closed ticket is reopened, so its start time can no
-- longer be assumed to be created_at. Storing it explicitly keeps elapsed-time filters
-- and dashboard aggregates as plain SQL, instead of replaying event history per ticket.

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN "clock_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing tickets have never been reopened, so their clock began when they were created.
UPDATE "tickets" SET "clock_started_at" = "created_at";
