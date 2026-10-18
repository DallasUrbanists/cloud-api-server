import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import booleanIntersects from '@turf/boolean-intersects';
import { pool } from '../config/db.js';
import { BoundaryError, type ServiceDescriptor } from '../models/boundary.js';
import { DALLAS_CITY_LAYER, shapeSources } from '../services/boundarySources.js';
import { dallasCityShape, queryFeatures, validShape } from '../services/shapes/arcgis.js';

export async function generateBoundarySeed(options: { metadataOnly?: boolean; sources?: string[]; hoaFile?: string; cityLimitsOnly?: boolean } = {}): Promise<{ sql: string; counts: Record<string, number> }> {
  const signal = AbortSignal.timeout(600000);
  const city = await dallasCityShape(signal);
  const counts: Record<string, number> = { cityLimits: 1 };
  const contactGuidance: Record<string, string> = {
    congress119: 'Federal legislation, federal agency assistance, interstate infrastructure, and national policy affecting constituents.',
    congress120: 'Federal legislation, federal agency assistance, interstate infrastructure, and national policy affecting constituents.',
    texasSenate: 'Texas legislation, state budgets, state agency assistance, and statewide infrastructure or regulatory policy.',
    texasHouse: 'Texas legislation, state budgets, state agency assistance, and statewide infrastructure or regulatory policy.',
    sboe: 'Texas public-school curriculum standards, instructional materials, graduation requirements, and education policy within SBOE authority.',
    countyJudge: 'Countywide budgets, emergency management, county administration, and Commissioners Court policy.',
    commissioners: 'Dallas County budgets, county roads and facilities, county services, and Commissioners Court decisions affecting this precinct.',
    council: 'Dallas municipal budgets, streets, housing, city services, ordinances, land-use decisions, and capital improvements.',
    cpc: 'Dallas zoning applications, land-use planning, development proposals, subdivision review, and planning recommendations.',
    parks: 'Dallas parks, recreation facilities and programs, trails, park maintenance, and park capital improvements.',
    disd: 'Dallas ISD budgets, district governance, school facilities, attendance policy, and superintendent oversight.',
    pids: 'District-funded maintenance, public-realm improvements, safety programs, assessments, management, and service plans.',
    neighborhoods: 'Neighborhood priorities, community organizing, local development, public spaces, and resident coordination.',
    hoas: 'Association governance, covenants, common property, assessments, and member maintenance concerns.',
  };
  const records: Record<string, any>[] = [
    { source_key: 'city:dallas', entity_name: 'City of Dallas', body_name: null, district_name: null,
      shape: options.metadataOnly ? null : city, shape_pending: !!options.metadataOnly,
      shape_synced_at: options.metadataOnly ? null : new Date().toISOString(), states: ['TX'], cities: [], counties: [], zips: [],
      description: `The municipal limits of the City of Dallas, Texas. Geometry sourced from ${DALLAS_CITY_LAYER}.`,
      when_to_contact: 'Dallas municipal services, infrastructure, public safety, city ordinances, and issues within the City of Dallas.',
      shape_service: { file: 'arcgis.js', function: 'fetchShape', params: { source: 'dallasCity', key: 'Dallas' } } },
    ...(!options.cityLimitsOnly ? [{ source_key: 'texas:senate', entity_name: 'United States', body_name: 'Senate', district_name: 'Texas', shape: null, states: ['TX'], description: 'The statewide constituency of the two United States senators representing Texas.', when_to_contact: 'Federal legislation, federal agency assistance, and issues affecting Texas residents.', research_service: { file: 'congress.js', function: 'researchMembers', params: { chamber: 'Senate' } } }] : []),
  ];
  for (const [id, source] of (options.cityLimitsOnly ? [] : Object.entries(shapeSources))) {
    if (options.sources && !options.sources.includes(id)) continue;
    const features = await queryFeatures(source.layer, source.where ?? '1=1', signal, city);
    counts[id] = features.length;
    for (const feature of features) {
      const key = feature.properties[source.keyField];
      if (key === undefined || key === null) throw new BoundaryError(502, 'SOURCE_INVALID', `Missing district key in ${id}.`);
      const district = /^\d+$/.test(String(key)) ? String(Number(key)) : String(key);
      const entity = source.nameField ? String(feature.properties[source.nameField] ?? '').trim() : source.entity;
      if (!entity) throw new BoundaryError(502, 'SOURCE_INVALID', `Missing organization name in ${id}.`);
      const research: ServiceDescriptor = source.research === 'congress'
        ? { file: 'congress.js', function: 'researchMembers', params: { chamber: 'House of Representatives', district, session: id === 'congress120' ? 120 : 119 } }
        : source.research === 'openStates'
          ? { file: 'openStates.js', function: 'researchLegislators', params: { chamber: id === 'texasSenate' ? 'upper' : 'lower', district } }
          : { file: 'official.js', function: 'researchRoster', params: { urls: source.urls, title: source.title,
            expectedMembers: ['countyJudge', 'commissioners', 'council', 'cpc', 'parks', 'sboe', 'disd'].includes(id) ? 1 : undefined,
            candidateUrls: typeof feature.properties.Asso_WEB === 'string' && /^https:\/\//.test(feature.properties.Asso_WEB) ? [feature.properties.Asso_WEB] : [] } };
      records.push({ source_key: `${id}:${key}`, entity_name: entity, body_name: source.body,
        district_name: id === 'countyJudge' ? null : source.nameField ? null : `${id === 'commissioners' ? 'Precinct' : 'District'} ${district}`,
        shape: options.metadataOnly ? null : feature.geometry, shape_pending: !!options.metadataOnly,
        shape_synced_at: options.metadataOnly ? null : new Date().toISOString(),
        states: ['TX'], cities: [], counties: [], zips: [],
        description: `${entity} ${source.body}${source.nameField || id === 'countyJudge' ? '' : `, ${id === 'commissioners' ? 'Precinct' : 'District'} ${district}`}. Geometry sourced from ${source.layer}.`,
        when_to_contact: contactGuidance[id],
        shape_service: { file: 'arcgis.js', function: 'fetchShape', params: { source: id, key, ...(source.nameField ? { name: entity } : {}) } },
        research_service: research, effective_date: source.effectiveDate ?? null, expiration_date: source.expirationDate ?? null,
      });
    }
  }
  if (options.hoaFile && !options.cityLimitsOnly) {
    const collection = JSON.parse(await readFile(options.hoaFile, 'utf8'));
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('HOA input must be a verified GeoJSON FeatureCollection.');
    counts.verifiedHoas = 0;
    for (const feature of collection.features) {
      if (!validShape(feature.geometry) || typeof feature.properties?.name !== 'string' || typeof feature.properties?.sourceUrl !== 'string' || !/^https:\/\//.test(feature.properties.sourceUrl)) throw new Error('HOA features require valid geometry, name, and sourceUrl.');
      if (!booleanIntersects(city, feature.geometry)) continue;
      records.push({ source_key: `verifiedHoa:${feature.properties.sourceUrl}:${feature.properties.name}`, entity_name: feature.properties.name, body_name: 'Board', district_name: null, states: ['TX'], shape: feature.geometry,
        description: `Verified HOA boundary. Source: ${feature.properties.sourceUrl}.`, when_to_contact: 'Association governance, common property, covenants, maintenance, and issues affecting members.',
        research_service: { file: 'official.js', function: 'researchRoster', params: { urls: ['https://www.hoa.texas.gov/'], title: 'President' } } });
      counts.verifiedHoas++;
    }
  }
  const data = `[\n${records.map(record => JSON.stringify(record)).join(',\n')}\n]`.replace(/'/g, "''");
  if (data.includes('$seed$')) throw new Error('Source data contains an unsupported SQL delimiter.');
  const sql = `BEGIN;
LOCK TABLE boundaries IN SHARE ROW EXCLUSIVE MODE;
-- Generated from official public GIS sources; exact geometries, without simplification.
-- Existing locally maintained geometry and descriptions are preserved.
DO $seed$
DECLARE record jsonb; existing_id integer;
BEGIN
  FOR record IN SELECT jsonb_array_elements('${data}'::jsonb) LOOP
    SELECT id INTO existing_id FROM boundaries
      WHERE source_key = record ->> 'source_key'
      OR (source_key IS NULL AND entity_name = record ->> 'entity_name'
        AND body_name IS NOT DISTINCT FROM record ->> 'body_name'
        AND district_name IS NOT DISTINCT FROM record ->> 'district_name'
        AND effective_date IS NOT DISTINCT FROM (record ->> 'effective_date')::date)
      ORDER BY id LIMIT 1;
    IF existing_id IS NULL THEN
      INSERT INTO boundaries(source_key, entity_name, body_name, district_name, shape, shape_pending,
        cities, counties, zips, states, description, when_to_contact, shape_service, research_service, effective_date, expiration_date, last_shape_sync, last_shape_success)
      VALUES(record ->> 'source_key', record ->> 'entity_name', record ->> 'body_name', record ->> 'district_name',
        NULLIF(record -> 'shape', 'null'::jsonb), COALESCE((record ->> 'shape_pending')::boolean, false),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(record -> 'cities', '[]'))),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(record -> 'counties', '[]'))),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(record -> 'zips', '[]'))),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(record -> 'states', '[]'))),
        record ->> 'description', record ->> 'when_to_contact', record -> 'shape_service', record -> 'research_service',
        (record ->> 'effective_date')::date, (record ->> 'expiration_date')::date,
        (record ->> 'shape_synced_at')::timestamptz, (record ->> 'shape_synced_at')::timestamptz);
    ELSE
      UPDATE boundaries SET source_key = record ->> 'source_key',
        shape = COALESCE(shape, NULLIF(record -> 'shape', 'null'::jsonb)),
        shape_pending = shape IS NULL AND COALESCE((record ->> 'shape_pending')::boolean, false),
        last_shape_sync = CASE WHEN shape IS NULL OR shape = record -> 'shape' THEN COALESCE(last_shape_sync, (record ->> 'shape_synced_at')::timestamptz) ELSE last_shape_sync END,
        last_shape_success = CASE WHEN shape IS NULL OR shape = record -> 'shape' THEN COALESCE(last_shape_success, (record ->> 'shape_synced_at')::timestamptz) ELSE last_shape_success END,
        states = CASE WHEN cardinality(states) = 0 THEN ARRAY['TX'] ELSE states END,
        description = CASE WHEN description = '' THEN record ->> 'description' ELSE description END,
        when_to_contact = CASE WHEN when_to_contact = '' THEN record ->> 'when_to_contact' ELSE when_to_contact END,
        shape_service = COALESCE(shape_service, record -> 'shape_service'),
        research_service = COALESCE(research_service, record -> 'research_service'),
        expiration_date = COALESCE(expiration_date, (record ->> 'expiration_date')::date)
      WHERE id = existing_id;
    END IF;
  END LOOP;
END $seed$;
UPDATE representatives r SET research_service = b.research_service FROM boundaries b WHERE b.id = r.boundary_id AND r.research_service IS NULL;
COMMIT;
`;
  return { sql, counts };
}
if (process.argv[1]?.endsWith('seedBoundaries.ts') || process.argv[1]?.endsWith('seedBoundaries.js')) {
  try {
    const args = process.argv.slice(2);
    const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : undefined;
    const sqlFileIndex = args.indexOf('--sql-file');
    const sqlFile = sqlFileIndex >= 0 ? args[sqlFileIndex + 1] : undefined;
    const hoaFile = args.includes('--hoa-file') ? args[args.indexOf('--hoa-file') + 1] : undefined;
    const apply = args.includes('--apply');
    if (sqlFile && !apply) throw new Error('--sql-file requires --apply.');
    if (output && sqlFile) throw new Error('Choose either --output or --sql-file.');
    const generated = sqlFile ? { sql: await readFile(sqlFile, 'utf8'), counts: { suppliedSql: 1 } }
      : await generateBoundarySeed({ metadataOnly: args.includes('--metadata-only'), hoaFile, cityLimitsOnly: args.includes('--city-limits-only') });
    console.log(JSON.stringify({ counts: generated.counts, bytes: Buffer.byteLength(generated.sql) }));
    if (output) { await writeFile(output, generated.sql, { flag: 'wx' }); console.log(`Wrote SQL to ${output}.`); }
    else if (!apply) console.log('Dry run only. Supply --output <new.sql> to write an unapplied SQL seed.');
    if (apply) { await pool.query(generated.sql); console.log('Applied the boundary seed.'); await pool.end(); }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Boundary seed generation failed.'); process.exitCode = 1; }
}
