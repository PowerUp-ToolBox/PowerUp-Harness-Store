-- The model a Connection's tests call when none is named: the one the User named for its last
-- passed test. NULL means the app's own choice (the catalogue's test model), or none yet.
ALTER TABLE connections ADD COLUMN test_model TEXT;
