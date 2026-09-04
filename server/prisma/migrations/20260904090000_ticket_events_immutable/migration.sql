-- Enforces that ticket_events is append-only at the database level, not only by there
-- being no UPDATE/DELETE route in the API.
--
-- A plain REVOKE would not work here: the role the application connects as OWNS this
-- table (it created it via migrations), and a table owner's privileges are inherent —
-- Postgres lets an owner bypass its own REVOKEs, since REVOKE can only take away
-- privileges that were explicitly GRANTed, never the ownership privilege itself.
-- Confirmed empirically before writing this migration (current_user = tableowner on both
-- the dev and test databases), rather than assumed.
--
-- A trigger has no such exception: it fires for any writer with any privileges, including
-- the table's owner, which is what actually backs up "even a compromised API key with a
-- bug in it can't rewrite history."

CREATE FUNCTION forbid_ticket_events_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ticket_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_events_immutable
  BEFORE UPDATE OR DELETE ON "ticket_events"
  FOR EACH ROW EXECUTE FUNCTION forbid_ticket_events_mutation();
