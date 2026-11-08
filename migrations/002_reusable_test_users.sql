ALTER TABLE participants ADD COLUMN test_created_by TEXT REFERENCES participants(id) ON DELETE SET NULL;
CREATE INDEX participants_test_pool ON participants(test_created_by) WHERE is_test;
