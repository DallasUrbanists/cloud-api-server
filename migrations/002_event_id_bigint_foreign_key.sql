BEGIN;

-- Verify/clean non-numeric legacy values before running this migration:
-- SELECT event_id FROM checkins WHERE event_id !~ '^\\d+$';

ALTER TABLE checkins
  DROP CONSTRAINT IF EXISTS checkins_event_id_fkey;

ALTER TABLE checkins
  ALTER COLUMN event_id TYPE BIGINT
  USING event_id::BIGINT;

ALTER TABLE checkins
  ADD CONSTRAINT checkins_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES events(id);

CREATE INDEX IF NOT EXISTS checkins_event_id_idx
  ON checkins (event_id);

COMMIT;
