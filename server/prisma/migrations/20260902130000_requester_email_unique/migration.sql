-- One requester record per email address, so a customer's ticket history can never
-- split across two rows. Emails are lowercased in the application before insert.

-- CreateIndex
CREATE UNIQUE INDEX "requesters_email_key" ON "requesters"("email");
