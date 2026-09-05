-- An acknowledgement now silences an alert for a fixed window rather than for the whole
-- ack cycle, so the moment it was made has to be recorded. Nullable: rows acknowledged
-- before this column existed have no timestamp, and are treated as already expired.
ALTER TABLE "tickets" ADD COLUMN "acked_at" TIMESTAMP(3);
