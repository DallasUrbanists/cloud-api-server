/** Runtime validation for boundaries, worksheet definitions and answers. @module */
import { AreaFeature, AuditType, Position, Prompt, WalkAuditError } from '../models/walkAudit.js';

/** Reject invalid input without exposing internal errors. */
export function invalid(message: string): never { throw new WalkAuditError(400, 'INVALID_INPUT', message); }
/** Require a plain JSON object. */
export function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
/** Reject unexpected fields on a mutation. */
export function fields(value: unknown, allowed: string[], name = 'body'): Record<string, unknown> {
  const result = object(value, name);
  if (Object.keys(result).some(key => !allowed.includes(key))) invalid(`${name} contains an unknown field.`);
  return result;
}
/** Normalize a bounded text value. */
export function text(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${name} must be text.`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > max) invalid(`${name} has an invalid length.`);
  return result;
}
/** Validate a positive PostgreSQL integer identifier or version. */
export function positiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647) invalid(`${name} must be a positive integer.`);
  return value;
}
/** Validate an audit type. */
export function auditType(value: unknown): AuditType {
  if (value !== 'intersection' && value !== 'street-segment') invalid('type must be intersection or street-segment.');
  return value;
}

function same(a: Position, b: Position): boolean { return a[0] === b[0] && a[1] === b[1]; }
function cross(a: Position, b: Position, c: Position): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSegment(a: Position, b: Position, p: Position): boolean {
  return Math.abs(cross(a, b, p)) < 1e-12 && p[0] >= Math.min(a[0], b[0]) - 1e-12 && p[0] <= Math.max(a[0], b[0]) + 1e-12
    && p[1] >= Math.min(a[1], b[1]) - 1e-12 && p[1] <= Math.max(a[1], b[1]) + 1e-12;
}
function intersects(a: Position, b: Position, c: Position, d: Position): boolean {
  const x1 = cross(a, b, c), x2 = cross(a, b, d), x3 = cross(c, d, a), x4 = cross(c, d, b);
  return (x1 * x2 < 0 && x3 * x4 < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Validate a closed simple polygon and its approximate surface area before network I/O. */
export function validateArea(input: unknown): AreaFeature {
  const feature = fields(input, ['type', 'properties', 'geometry'], 'area');
  if (feature.type !== 'Feature') invalid('area must be a GeoJSON Feature.');
  const geometry = fields(feature.geometry, ['type', 'coordinates'], 'area geometry');
  if (geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) invalid('area must be a Polygon with one outer ring and no holes.');
  const raw = geometry.coordinates[0];
  if (!Array.isArray(raw) || raw.length < 4 || raw.length > 251) invalid('area must have 3 to 250 corners.');
  const ring: Position[] = raw.map((point: unknown) => {
    if (!Array.isArray(point) || point.length !== 2 || point.some(n => typeof n !== 'number' || !Number.isFinite(n)) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) invalid('area coordinates must be finite longitude/latitude pairs.');
    return [point[0], point[1]];
  });
  if (!same(ring[0], ring[ring.length - 1])) invalid('area ring must be closed.');
  const vertices = ring.slice(0, -1);
  if (new Set(vertices.map(p => `${p[0]},${p[1]}`)).size !== vertices.length) invalid('area corners must be distinct.');
  const longitudes = vertices.map(p => p[0]);
  if (Math.max(...longitudes) - Math.min(...longitudes) > 180) invalid('area must not cross the antimeridian.');
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[(i + n - 1) % n], b = vertices[i], c = vertices[(i + 1) % n];
    if (Math.abs(cross(a, b, c)) < 1e-12 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) invalid('area edges must not overlap.');
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (intersects(ring[i], ring[i + 1], ring[j], ring[j + 1])) invalid('area must not intersect itself.');
  }
  const latitude = vertices.reduce((sum, point) => sum + point[1], 0) / n;
  const sx = 111320 * Math.cos(latitude * Math.PI / 180), sy = 111320;
  let twiceArea = 0;
  const origin = ring[0];
  for (let i = 0; i < n; i++) twiceArea += ((ring[i][0] - origin[0]) * sx) * ((ring[i + 1][1] - origin[1]) * sy) - ((ring[i + 1][0] - origin[0]) * sx) * ((ring[i][1] - origin[1]) * sy);
  const squareMeters = Math.abs(twiceArea) / 2;
  if (!Number.isFinite(squareMeters) || squareMeters < 2500 || squareMeters > 75000000) invalid('area must be between 2,500 square meters and 75 square kilometers.');
  const properties = feature.properties === null || feature.properties === undefined ? {} : object(feature.properties, 'area properties');
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Boundary points count as inside, including points exactly on an edge. */
export function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(a, b, point)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Validate stable, nonduplicated worksheet prompt definitions. */
export function validatePrompts(input: unknown): Prompt[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) invalid('prompts must contain 1 to 100 entries.');
  const ids = new Set<string>();
  return input.map(item => {
    const p = fields(item, ['id', 'type', 'label', 'required', 'options', 'maxLength'], 'prompt');
    const id = text(p.id, 'prompt id', 100);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) invalid('prompt IDs must be unique lowercase slugs.');
    ids.add(id);
    const label = text(p.label, 'prompt label', 500);
    if (typeof p.required !== 'boolean') invalid('prompt required must be boolean.');
    if (p.type === 'choice') {
      if (p.maxLength !== undefined || !Array.isArray(p.options) || p.options.length < 2 || p.options.length > 50) invalid('choice prompts require 2 to 50 options.');
      const options = p.options.map(option => text(option, 'option', 200));
      if (new Set(options).size !== options.length) invalid('choice options must be unique.');
      return { id, type: 'choice' as const, label, required: p.required, options };
    }
    if (p.type === 'text') {
      if (p.options !== undefined || typeof p.maxLength !== 'number' || !Number.isInteger(p.maxLength) || p.maxLength < 1 || p.maxLength > 10000) invalid('text prompts require maxLength from 1 to 10000.');
      return { id, type: 'text' as const, label, required: p.required, maxLength: p.maxLength };
    }
    return invalid('prompt type must be choice or text.');
  });
}

/** Validate partial draft answers or complete submitted answers against a pinned worksheet. */
export function validateAnswers(input: unknown, prompts?: Prompt[], final = false): Record<string, string> {
  const answers = object(input, 'answers');
  if (Buffer.byteLength(JSON.stringify(answers), 'utf8') > 100000) throw new WalkAuditError(413, 'ANSWERS_TOO_LARGE', 'Answers exceed 100,000 bytes.');
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== 'string' || value.length > 10000) invalid('answers must contain bounded text values.');
    if (prompts) {
      const p = prompts.find(prompt => prompt.id === key);
      if (!p || (p.type === 'choice' && !p.options?.includes(value)) || (p.type === 'text' && value.length > p.maxLength!)) invalid('answers do not match the worksheet.');
    }
  }
  if (final && prompts?.some(p => p.required && (typeof answers[p.id] !== 'string' || !(answers[p.id] as string).trim()))) invalid('a required worksheet answer is missing.');
  return answers as Record<string, string>;
}
