BEGIN;

CREATE TABLE operation_groups (
  id uuid PRIMARY KEY,
  owner_uid text NOT NULL,
  client_action_id uuid NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  action_type text NOT NULL CHECK (length(action_type) BETWEEN 1 AND 64),
  event_id bigint,
  manifest jsonb NOT NULL,
  begin_hash text NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 0 AND 1048576),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','committed','undone','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  open_expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours',
  begin_retry_expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '90 days',
  committed_at timestamptz,
  undo_expires_at timestamptz,
  commit_order bigint,
  receipt jsonb,
  undo_receipt jsonb,
  UNIQUE(owner_uid, client_action_id)
);
CREATE INDEX operation_history_idx ON operation_groups(owner_uid, source, commit_order DESC) WHERE commit_order IS NOT NULL;
CREATE TABLE operation_accounts (owner_uid text PRIMARY KEY, next_order bigint NOT NULL DEFAULT 0);
CREATE TABLE operation_items (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES operation_groups(id) ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource IN ('contacts','checkins')),
  record_id bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('PUT','DELETE')),
  command jsonb NOT NULL,
  expected jsonb NOT NULL,
  preimage jsonb,
  post_state jsonb,
  predecessors jsonb,
  UNIQUE(group_id, resource, record_id)
);
CREATE TABLE operation_inverse_receipts (
  group_id uuid PRIMARY KEY REFERENCES operation_groups(id) ON DELETE CASCADE,
  transitions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operation_history_cursors (
  id uuid PRIMARY KEY,
  owner_uid text NOT NULL,
  scope jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '24 hours'
);
CREATE TABLE operation_retries (
  owner_uid text NOT NULL,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_uid, scope, key)
);
CREATE TABLE resource_revisions (
  resource text NOT NULL,
  record_id bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  head text NOT NULL DEFAULT gen_random_uuid()::text,
  present boolean NOT NULL DEFAULT true,
  PRIMARY KEY(resource, record_id)
);
CREATE TABLE resource_transitions (
  resource text NOT NULL,
  record_id bigint NOT NULL,
  revision bigint NOT NULL,
  kind text NOT NULL DEFAULT 'ordinary' CHECK (kind IN ('ordinary','commit','undo')),
  group_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(resource, record_id, revision)
);

CREATE FUNCTION track_resource_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid bigint; rev bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN rid := OLD.id; ELSE rid := NEW.id; END IF;
  IF TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Tracked resource IDs are immutable';
  END IF;
  INSERT INTO resource_revisions(resource,record_id,present)
    VALUES(TG_TABLE_NAME,rid,TG_OP <> 'DELETE')
  ON CONFLICT(resource,record_id) DO UPDATE SET
    revision = resource_revisions.revision + 1,
    incarnation = CASE WHEN TG_OP = 'INSERT' THEN gen_random_uuid() ELSE resource_revisions.incarnation END,
    head = gen_random_uuid()::text, present = TG_OP <> 'DELETE'
  RETURNING revision INTO rev;
  INSERT INTO resource_transitions(resource,record_id,revision) VALUES(TG_TABLE_NAME,rid,rev);
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

INSERT INTO resource_revisions(resource,record_id) SELECT 'contacts',id FROM contacts;
INSERT INTO resource_revisions(resource,record_id) SELECT 'checkins',id FROM checkins;
INSERT INTO resource_revisions(resource,record_id) SELECT 'events',id FROM events;
CREATE TRIGGER contacts_revision AFTER INSERT OR UPDATE OR DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION track_resource_revision();
CREATE TRIGGER checkins_revision AFTER INSERT OR UPDATE OR DELETE ON checkins FOR EACH ROW EXECUTE FUNCTION track_resource_revision();
CREATE TRIGGER events_revision AFTER INSERT OR UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION track_resource_revision();
CREATE UNIQUE INDEX checkins_contact_event_unique ON checkins(contact_id,event_id) WHERE contact_id IS NOT NULL;

CREATE FUNCTION operation_cleanup() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  LOCK TABLE events, contacts, checkins IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM operation_items WHERE group_id IN (
    SELECT id FROM operation_groups WHERE
    (state IN ('committed','undone') AND undo_expires_at <= clock_timestamp()) OR
    (state IN ('open','cancelled') AND open_expires_at <= clock_timestamp())
  );
  UPDATE operation_retries r SET receipt = r.receipt - ARRAY['source','action_type','event_id','display_summary','affected_record_count','payload_bytes']
      FROM operation_groups g WHERE r.receipt->>'group_id'=g.id::text AND
      (g.undo_expires_at <= clock_timestamp() OR (g.state IN ('open','cancelled') AND g.open_expires_at <= clock_timestamp()));
    UPDATE operation_groups SET manifest = '[]', source='expired', action_type='expired', event_id=NULL,
      payload_bytes=0, receipt = NULL, undo_receipt = NULL
      WHERE undo_expires_at <= clock_timestamp() OR (state IN ('open','cancelled') AND open_expires_at <= clock_timestamp());
    -- Retain transitions from each unexpired action's target/dependency baseline onward.
    DELETE FROM resource_transitions t WHERE t.created_at < clock_timestamp() - interval '90 days'
      AND NOT EXISTS (
        SELECT 1 FROM operation_items i JOIN operation_groups g ON g.id=i.group_id
        CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(i.post_state->'target') || COALESCE(i.post_state->'dependencies','[]'::jsonb)) s
        WHERE g.state='committed' AND g.undo_expires_at>clock_timestamp()
          AND s->>'resource'=t.resource AND (s->>'id')::bigint=t.record_id
          AND (s->>'revision')::bigint < t.revision
      );
    DELETE FROM operation_history_cursors WHERE expires_at <= clock_timestamp();
    DELETE FROM operation_retries r WHERE r.created_at < clock_timestamp() - interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM operation_groups g WHERE r.receipt->>'group_id'=g.id::text AND g.begin_retry_expires_at>clock_timestamp());
    DELETE FROM operation_groups g WHERE g.created_at < clock_timestamp() - interval '90 days'
      AND g.begin_retry_expires_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM resource_transitions t WHERE t.group_id=g.id);
END $$;
COMMIT;
