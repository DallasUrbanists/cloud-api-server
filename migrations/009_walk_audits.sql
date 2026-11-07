-- Walk-audit data is deliberately separate from CRM and Firebase accounts.
-- Applying this migration is an explicit operator action, never a startup step.
BEGIN;

CREATE TABLE walk_audit_contributors (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  firebase_uid text NOT NULL UNIQUE CHECK (length(btrim(firebase_uid)) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  created_on timestamptz NOT NULL DEFAULT now(),
  updated_on timestamptz NOT NULL DEFAULT now(),
  next_generation_on timestamptz
);

CREATE TABLE walk_audit_studies (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_by integer NOT NULL REFERENCES walk_audit_contributors(id) ON DELETE RESTRICT,
  neighborhood text NOT NULL CHECK (length(btrim(neighborhood)) BETWEEN 1 AND 200),
  created_on timestamptz NOT NULL DEFAULT now(),
  updated_on timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  location_gps jsonb NOT NULL CHECK (jsonb_typeof(location_gps) = 'object'),
  location_description text NOT NULL CHECK (length(location_description) <= 500),
  area jsonb NOT NULL CHECK (jsonb_typeof(area) = 'object'),
  intersections jsonb NOT NULL CHECK ((jsonb_typeof(intersections) = 'object' AND intersections->>'type' = 'FeatureCollection' AND jsonb_typeof(intersections->'features') = 'array') IS TRUE),
  segments jsonb NOT NULL CHECK ((jsonb_typeof(segments) = 'object' AND segments->>'type' = 'FeatureCollection' AND jsonb_typeof(segments->'features') = 'array') IS TRUE),
  thumbnail_png bytea NOT NULL CHECK (octet_length(thumbnail_png) > 0),
  thumbnail_content_type text NOT NULL DEFAULT 'image/png' CHECK (thumbnail_content_type = 'image/png'),
  source_metadata jsonb NOT NULL CHECK (jsonb_typeof(source_metadata) = 'object')
);

CREATE TABLE walk_audit_worksheets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 100),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) <= 4000),
  source_url text NOT NULL CHECK (length(source_url) <= 2048),
  recommend_for text[] NOT NULL CHECK (cardinality(recommend_for) > 0 AND recommend_for <@ ARRAY['intersection', 'street-segment']::text[] AND array_position(recommend_for, NULL) IS NULL),
  prompts jsonb NOT NULL CHECK (jsonb_typeof(prompts) = 'array'),
  created_on timestamptz NOT NULL DEFAULT now(),
  updated_on timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, version)
);

CREATE TABLE walk_audit_audits (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  study_id integer NOT NULL REFERENCES walk_audit_studies(id) ON DELETE CASCADE,
  created_by integer NOT NULL REFERENCES walk_audit_contributors(id) ON DELETE RESTRICT,
  worksheet_id integer NOT NULL REFERENCES walk_audit_worksheets(id) ON DELETE RESTRICT,
  created_on timestamptz NOT NULL DEFAULT now(),
  updated_on timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  type text NOT NULL CHECK (type IN ('intersection', 'street-segment')),
  feature_id text NOT NULL CHECK (length(btrim(feature_id)) BETWEEN 1 AND 255),
  location_gps jsonb NOT NULL CHECK (jsonb_typeof(location_gps) = 'object'),
  location_description text NOT NULL CHECK (length(location_description) <= 500),
  geojson jsonb NOT NULL CHECK (jsonb_typeof(geojson) = 'object'),
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  UNIQUE (id, study_id)
);

CREATE TABLE walk_audit_drafts (
  id uuid PRIMARY KEY,
  study_id integer NOT NULL REFERENCES walk_audit_studies(id) ON DELETE CASCADE,
  created_by integer NOT NULL REFERENCES walk_audit_contributors(id) ON DELETE RESTRICT,
  created_on timestamptz NOT NULL DEFAULT now(),
  updated_on timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  editing_audit_id integer,
  editing_audit_version integer CHECK (editing_audit_version > 0),
  type text CHECK (type IN ('intersection', 'street-segment')),
  worksheet_id integer REFERENCES walk_audit_worksheets(id) ON DELETE RESTRICT,
  feature_id text CHECK (feature_id IS NULL OR length(btrim(feature_id)) BETWEEN 1 AND 255),
  location_gps jsonb CHECK (location_gps IS NULL OR jsonb_typeof(location_gps) = 'object'),
  location_description text CHECK (location_description IS NULL OR length(location_description) <= 500),
  geojson jsonb CHECK (geojson IS NULL OR jsonb_typeof(geojson) = 'object'),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(answers) = 'object'),
  CHECK ((editing_audit_id IS NULL) = (editing_audit_version IS NULL)),
  FOREIGN KEY (editing_audit_id, study_id) REFERENCES walk_audit_audits(id, study_id) ON DELETE CASCADE
);

CREATE TABLE walk_audit_reports (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  study_id integer NOT NULL REFERENCES walk_audit_studies(id) ON DELETE CASCADE,
  created_by integer NOT NULL REFERENCES walk_audit_contributors(id) ON DELETE RESTRICT,
  created_on timestamptz NOT NULL DEFAULT now(),
  updated_on timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) <= 20000),
  audit_ids integer[] NOT NULL,
  completion numeric(6,5) NOT NULL CHECK (completion BETWEEN 0 AND 1),
  captured_data jsonb NOT NULL CHECK (jsonb_typeof(captured_data) = 'object')
);

CREATE INDEX walk_audit_studies_creator_date ON walk_audit_studies(created_by, created_on DESC, id DESC);
CREATE INDEX walk_audit_audits_study_date ON walk_audit_audits(study_id, created_on DESC, id DESC);
CREATE INDEX walk_audit_audits_creator_date ON walk_audit_audits(created_by, created_on DESC, id DESC);
CREATE INDEX walk_audit_audits_study_feature ON walk_audit_audits(study_id, type, feature_id);
CREATE INDEX walk_audit_drafts_owner_updated ON walk_audit_drafts(created_by, updated_on DESC, id DESC);
CREATE INDEX walk_audit_drafts_study ON walk_audit_drafts(study_id);
CREATE INDEX walk_audit_reports_study_date ON walk_audit_reports(study_id, created_on DESC, id DESC);

COMMIT;
