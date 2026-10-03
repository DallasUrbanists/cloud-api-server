ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS firebase_uid TEXT;

CREATE INDEX IF NOT EXISTS contacts_firebase_uid_idx
  ON contacts (firebase_uid)
  WHERE firebase_uid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS checkins_contact_event_unique_idx
  ON checkins (contact_id, event_id)
  WHERE contact_id IS NOT NULL;
