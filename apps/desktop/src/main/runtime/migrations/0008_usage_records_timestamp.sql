-- The Usage page (P0-11.1) counts a period's Usage Records for every Harness at once, which the
-- (harness_id, timestamp) index cannot serve: this one can.
CREATE INDEX usage_records_timestamp ON usage_records (timestamp);
