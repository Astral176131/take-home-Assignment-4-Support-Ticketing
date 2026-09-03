-- A short, human-readable ticket label ("SUP-14"), sourced from an auto-incrementing
-- integer. The uuid `id` column remains the real primary key everywhere; `number` is a
-- display concern only, added because a UUID cannot be said aloud or scanned in a
-- spreadsheet — not part of the brief's original schema.

CREATE SEQUENCE "tickets_number_seq" AS INTEGER START WITH 1;

ALTER TABLE "tickets"
  ADD COLUMN "number" INTEGER NOT NULL DEFAULT nextval('tickets_number_seq');

ALTER SEQUENCE "tickets_number_seq" OWNED BY "tickets"."number";

CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");
