-- Why a Connection's last test failed when the Provider sent no text of its own for
-- `last_test_error`: it did not answer in time, or answered with something its API does not
-- return. It holds the IPC error code the UI translates, and is NULL otherwise.
ALTER TABLE connections ADD COLUMN last_test_failure TEXT
  CHECK (last_test_failure IN ('provider_timeout', 'unexpected_response'));
