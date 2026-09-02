-- The brief's schema lists replies.author_id as a foreign key, but the initial
-- migration created it as a bare column. Without the constraint the database cannot
-- stop a reply pointing at a user that does not exist, and the API cannot join to
-- show who wrote it.

-- AddForeignKey
ALTER TABLE "replies" ADD CONSTRAINT "replies_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
