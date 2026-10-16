import { BoundaryError, type ServiceDescriptor } from '../models/boundary.js';
import { fetchShape } from './shapes/arcgis.js';
import { researchMembers } from './research/congress.js';
import { researchLegislators } from './research/openStates.js';
import { researchRoster } from './research/official.js';
import type { ResearchContext } from './research/types.js';

const researchRegistry = {
  'congress.js:researchMembers': researchMembers,
  'openStates.js:researchLegislators': researchLegislators,
  'official.js:researchRoster': researchRoster,
};
export function validateAdapter(descriptor: ServiceDescriptor, kind: 'shape' | 'research'): void {
  const name = `${descriptor.file}:${descriptor.function}`;
  if (!descriptor.params || typeof descriptor.params !== 'object' || Array.isArray(descriptor.params)
    || (kind === 'shape' ? name !== 'arcgis.js:fetchShape' : !Object.hasOwn(researchRegistry, name))) {
    throw new BoundaryError(503, 'SERVICE_INVALID', 'The configured sync adapter is not approved.');
  }
}
export function ensureProvider(descriptor: ServiceDescriptor, kind: 'shape' | 'research'): void {
  validateAdapter(descriptor, kind);
  const required = descriptor.file === 'congress.js' ? 'CONGRESS_GOV_API_KEY'
    : descriptor.file === 'openStates.js' ? 'OPEN_STATES_API_KEY'
      : descriptor.file === 'official.js' ? 'GEMINI_API_KEY' : undefined;
  if (required && !process.env[required]?.trim()) throw new BoundaryError(503, 'PROVIDER_NOT_CONFIGURED', 'The configured research provider is not available.');
}
export function runShape(descriptor: ServiceDescriptor, signal: AbortSignal) {
  validateAdapter(descriptor, 'shape');
  return fetchShape(descriptor.params, signal);
}
export function runResearch(descriptor: ServiceDescriptor, context: ResearchContext) {
  validateAdapter(descriptor, 'research');
  return researchRegistry[`${descriptor.file}:${descriptor.function}` as keyof typeof researchRegistry](descriptor.params, context);
}
