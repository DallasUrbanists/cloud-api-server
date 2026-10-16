import booleanIntersects from '@turf/boolean-intersects';
import { BoundaryError, type BoundaryShape } from '../../models/boundary.js';
import { fetchJson } from '../boundaryHttp.js';
import { DALLAS_CITY_LAYER, shapeSources } from '../boundarySources.js';

export interface ShapeFeature { type: 'Feature'; geometry: BoundaryShape; properties: Record<string, any>; }
export function validShape(value: unknown): value is BoundaryShape {
  if (!value || typeof value !== 'object') return false;
  const shape = value as BoundaryShape;
  if (!['Polygon', 'MultiPolygon'].includes(shape.type) || !Array.isArray(shape.coordinates)) return false;
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  return polygons.length > 0 && polygons.every(polygon => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring =>
    Array.isArray(ring) && ring.length >= 4 &&     ring.every(position => Array.isArray(position) && position.length >= 2 && position.length === polygon[0][0].length
      && position.every(Number.isFinite) && Math.abs(position[0]) <= 180 && Math.abs(position[1]) <= 90)
    && JSON.stringify(ring[0]) === JSON.stringify(ring.at(-1))));
}
export async function queryFeatures(layer: string, where: string, signal: AbortSignal, intersects?: BoundaryShape): Promise<ShapeFeature[]> {
  const metadata = await fetchJson(`${layer}?f=json`, signal);
  if (metadata.error || metadata.geometryType !== 'esriGeometryPolygon') throw new BoundaryError(502, 'SOURCE_INVALID', 'Expected a polygon GIS layer.');
  const query = new URL(`${layer}/query`);
  const params = new URLSearchParams({ where, outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson', resultRecordCount: '100', resultOffset: '0', orderByFields: metadata.objectIdField ?? metadata.objectIdFieldName ?? 'OBJECTID' });
  if (intersects) {
    const positions = intersects.type === 'Polygon' ? intersects.coordinates.flat() : intersects.coordinates.flat(2);
    const extent = positions.reduce((box, [lon, lat]) => ({ xmin: Math.min(box.xmin, lon), ymin: Math.min(box.ymin, lat), xmax: Math.max(box.xmax, lon), ymax: Math.max(box.ymax, lat) }), { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity });
    params.set('geometry', JSON.stringify({ ...extent, spatialReference: { wkid: 4326 } }));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  const features: ShapeFeature[] = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    params.set('resultOffset', String(offset));
    query.search = params.toString();
    const result = await fetchJson(query, signal);
    if (result.error || result.type !== 'FeatureCollection' || !Array.isArray(result.features)) throw new BoundaryError(502, 'SOURCE_INVALID', 'GIS query did not return GeoJSON features.');
    for (const feature of result.features) {
      if (!validShape(feature.geometry) || !feature.properties) throw new BoundaryError(502, 'SOURCE_INVALID', 'GIS source returned invalid polygon geometry.');
      if (!intersects || booleanIntersects(feature.geometry, intersects)) features.push(feature);
    }
    if (!result.exceededTransferLimit && !result.properties?.exceededTransferLimit && result.features.length < 100) return features;
  }
  throw new BoundaryError(502, 'SOURCE_TOO_LARGE', 'GIS result exceeds the maximum feature count.');
}
export async function fetchShape(params: Record<string, unknown>, signal: AbortSignal): Promise<BoundaryShape> {
  const source = typeof params.source === 'string' && Object.hasOwn(shapeSources, params.source) ? shapeSources[params.source] : undefined;
  const key = params.key;
  if (!source || !['string', 'number'].includes(typeof key) || !/^[A-Za-z0-9 ._-]{1,100}$/.test(String(key))) throw new BoundaryError(503, 'SERVICE_INVALID', 'Shape service configuration is invalid.');
  const escaped = String(key).replace(/'/g, "''");
  const keyCondition = `${source.keyField} = '${escaped}'`;
  const features = await queryFeatures(source.layer, source.where ? `(${source.where}) AND ${keyCondition}` : keyCondition, signal);
  if (!features.length) throw new BoundaryError(502, 'SHAPE_NOT_FOUND', 'The configured district was not found in its GIS source.');
  if (features.some(feature => String(feature.properties[source.keyField]) !== String(key)
    && (!/^\d+$/.test(String(feature.properties[source.keyField])) || !/^\d+$/.test(String(key)) || Number(feature.properties[source.keyField]) !== Number(key)))) {
    throw new BoundaryError(502, 'SOURCE_IDENTITY_CHANGED', 'The GIS source returned a different district identifier.');
  }
  if (source.nameField && params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim()
    || features.some(feature => String(feature.properties[source.nameField!]).trim().toLowerCase() !== String(params.name).trim().toLowerCase()))) {
    throw new BoundaryError(502, 'SOURCE_IDENTITY_CHANGED', 'The GIS feature no longer matches the configured organization. Review its source identifier before refreshing geometry.');
  }
  if (features.length === 1) return features[0].geometry;
  return { type: 'MultiPolygon', coordinates: features.flatMap(feature => feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates) };
}
export async function dallasCityShape(signal: AbortSignal): Promise<BoundaryShape> {
  const features = await queryFeatures(DALLAS_CITY_LAYER, '1=1', signal);
  if (!features.length) throw new BoundaryError(502, 'SHAPE_NOT_FOUND', 'Dallas city limits were not found.');
  return { type: 'MultiPolygon', coordinates: features.flatMap(feature => feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates) };
}
