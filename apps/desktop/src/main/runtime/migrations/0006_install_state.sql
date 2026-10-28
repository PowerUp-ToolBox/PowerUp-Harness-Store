-- Where a Store install is (P0-10): a row is written as soon as the Store's `download` function
-- answered, `downloading`, and moves through `verifying`, `awaiting_consent` (the User has not
-- consented yet) and `unpacking` to `installed`. A failed or cancelled install deletes its row,
-- so those states are never stored. Only `installed` rows are installed Harnesses; the Runtime
-- deletes every other row at startup, with what that install left in downloads/. Every row
-- written before this migration is installed.
ALTER TABLE installs ADD COLUMN state TEXT NOT NULL DEFAULT 'installed'
  CHECK (state IN ('downloading', 'verifying', 'awaiting_consent', 'unpacking', 'installed'));
