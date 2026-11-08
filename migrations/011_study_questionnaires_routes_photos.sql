-- Additive only: an operator applies this after 010; application startup does
-- not run migrations. Existing audits, answers, geometry and reports stay put.
BEGIN;

ALTER TABLE walk_audit_worksheets ADD COLUMN is_template boolean NOT NULL DEFAULT true;
ALTER TABLE walk_audit_worksheets DROP CONSTRAINT walk_audit_worksheets_recommend_for_check;
ALTER TABLE walk_audit_worksheets ADD CONSTRAINT walk_audit_worksheets_recommend_for_check
  CHECK (cardinality(recommend_for) > 0 AND recommend_for <@ ARRAY['intersection', 'street-segment', 'point']::text[] AND array_position(recommend_for, NULL) IS NULL);
ALTER TABLE walk_audit_audits DROP CONSTRAINT walk_audit_audits_type_check;
ALTER TABLE walk_audit_audits ADD CONSTRAINT walk_audit_audits_type_check CHECK (type IN ('intersection', 'street-segment', 'point'));
ALTER TABLE walk_audit_drafts DROP CONSTRAINT walk_audit_drafts_type_check;
ALTER TABLE walk_audit_drafts ADD CONSTRAINT walk_audit_drafts_type_check CHECK (type IN ('intersection', 'street-segment', 'point'));

ALTER TABLE walk_audit_audits ADD COLUMN route_selection jsonb
  CHECK (route_selection IS NULL OR jsonb_typeof(route_selection) = 'object');
ALTER TABLE walk_audit_drafts ADD COLUMN route_selection jsonb
  CHECK (route_selection IS NULL OR jsonb_typeof(route_selection) = 'object');

CREATE TABLE walk_audit_study_questionnaires (
  study_id integer NOT NULL REFERENCES walk_audit_studies(id) ON DELETE CASCADE,
  audit_type text NOT NULL CHECK (audit_type IN ('intersection', 'street-segment', 'point')),
  worksheet_id integer NOT NULL REFERENCES walk_audit_worksheets(id) ON DELETE RESTRICT,
  catalog_version text NOT NULL CHECK (length(btrim(catalog_version)) BETWEEN 1 AND 100),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
  PRIMARY KEY (study_id, audit_type)
);

-- Fail before backfilling when a type has neither a historical assignment nor
-- its explicit default. The surrounding transaction rolls back all DDL too.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM walk_audit_studies s
    CROSS JOIN (VALUES ('intersection', 'intersection-observation'), ('street-segment', 'street-observation')) AS t(audit_type, slug)
    WHERE NOT EXISTS (SELECT 1 FROM walk_audit_audits a WHERE a.study_id=s.id AND a.type=t.audit_type)
      AND NOT EXISTS (SELECT 1 FROM walk_audit_worksheets w WHERE w.slug=t.slug)
  ) THEN
    RAISE EXCEPTION 'Study questionnaire backfill needs the intersection-observation and street-observation default worksheet slugs. Apply the existing worksheet seed and retry.';
  END IF;
END $$;

INSERT INTO walk_audit_study_questionnaires (study_id, audit_type, worksheet_id, catalog_version, source_metadata)
SELECT s.id, t.audit_type,
  COALESCE(
    (SELECT a.worksheet_id FROM walk_audit_audits a WHERE a.study_id=s.id AND a.type=t.audit_type ORDER BY a.created_on DESC, a.id DESC LIMIT 1),
    (SELECT w.id FROM walk_audit_worksheets w WHERE w.slug=t.slug ORDER BY w.version DESC, w.id DESC LIMIT 1)
  ),
  'legacy-template-v1', '{}'::jsonb
FROM walk_audit_studies s
CROSS JOIN (VALUES ('intersection', 'intersection-observation'), ('street-segment', 'street-observation')) AS t(audit_type, slug);

ALTER TABLE walk_audit_audits ADD CONSTRAINT walk_audit_audits_photo_parent UNIQUE (id, study_id, created_by);
ALTER TABLE walk_audit_drafts ADD CONSTRAINT walk_audit_drafts_photo_parent UNIQUE (id, study_id, created_by);

CREATE TABLE walk_audit_photos (
  id uuid PRIMARY KEY,
  study_id integer NOT NULL,
  created_by integer NOT NULL,
  draft_id uuid,
  audit_id integer,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 2097152),
  image_bytes bytea NOT NULL CHECK (octet_length(image_bytes) = byte_count),
  created_on timestamptz NOT NULL DEFAULT now(),
  CHECK ((draft_id IS NULL) <> (audit_id IS NULL)),
  FOREIGN KEY (draft_id, study_id, created_by) REFERENCES walk_audit_drafts(id, study_id, created_by) ON DELETE CASCADE,
  FOREIGN KEY (audit_id, study_id, created_by) REFERENCES walk_audit_audits(id, study_id, created_by) ON DELETE CASCADE,
  UNIQUE (draft_id, slot),
  UNIQUE (audit_id, slot)
);

COMMIT;
