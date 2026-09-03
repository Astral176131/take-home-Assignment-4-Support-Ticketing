-- Trigram matching, not full-text search: the brief's search test requires partial-word
-- matches ("print" inside "printer"), which Postgres full-text search cannot do because it
-- stems and tokenizes on word boundaries. pg_trgm's GIN operator class accelerates
-- ILIKE '%term%' directly, so the application query needs no special syntax.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "tickets_subject_trgm_idx" ON "tickets" USING gin ("subject" gin_trgm_ops);
CREATE INDEX "tickets_description_trgm_idx" ON "tickets" USING gin ("description" gin_trgm_ops);
