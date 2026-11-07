-- Original prompts; external material is linked for context, not copied.
-- Conflicts leave existing local versions untouched.
BEGIN;
INSERT INTO walk_audit_worksheets (slug, version, title, description, source_url, recommend_for, prompts)
VALUES
  ('intersection-observation', 1, 'Intersection observation', 'Record what it is like to cross at an intersection.',
   'https://www.transportation.gov/mission/health/Walkability', ARRAY['intersection'],
   '[{"id":"crossing-comfort","type":"choice","label":"How comfortable does crossing here feel?","required":true,"options":["comfortable","mixed","uncomfortable"]},{"id":"notes","type":"text","label":"What did you notice?","required":false,"maxLength":2000}]'::jsonb),
  ('street-observation', 1, 'Street observation', 'Record the experience of walking along a street.',
   'https://www.transportation.gov/mission/health/Walkability', ARRAY['street-segment'],
   '[{"id":"walking-comfort","type":"choice","label":"How comfortable does walking here feel?","required":true,"options":["comfortable","mixed","uncomfortable"]},{"id":"notes","type":"text","label":"What did you notice?","required":false,"maxLength":2000}]'::jsonb)
ON CONFLICT (slug, version) DO NOTHING;
COMMIT;
