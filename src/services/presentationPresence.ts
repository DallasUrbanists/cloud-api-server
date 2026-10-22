/** Shared REST and WebSocket validation for role-scoped presentation presence. */
import { PresentationError } from '../models/presentation.js';
import type { PresentationRole } from '../models/presentation.js';
import type { PresenceReport } from './presentationService.js';

export const PRESENTATION_RENDER_ERRORS = new Set([
  'MAP_UNAVAILABLE', 'IMAGE_UNAVAILABLE', 'STREETMIX_UNAVAILABLE', 'CONTENT_UNAVAILABLE',
  'TILE_UNAVAILABLE', 'RENDER_FAILED', 'NETWORK_ERROR', 'TIMEOUT', 'UNKNOWN',
]);

function object(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', message);
  return value as Record<string, any>;
}

function exactKeys(value: Record<string, any>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Presence contains missing or unsupported fields.');
  }
}

export function validatePresentationPresence(input: unknown, role: PresentationRole): PresenceReport | undefined {
  if (input === undefined) return undefined;
  const presence = object(input, 'Presence must be an object.');
  const permitted = role === 'audience' ? ['localView'] : role === 'receiver' ? ['appliedRevision', 'viewport', 'renderStatus', 'renderError'] : [];
  if (Object.keys(presence).some(key => !permitted.includes(key))) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Presence contains fields that are not available to this role.');
  if (role === 'audience' && presence.localView !== undefined && !['map', 'photo', 'description'].includes(presence.localView)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'localView is invalid.');
  if (role !== 'receiver') return presence as PresenceReport;
  if (presence.appliedRevision !== undefined && (!Number.isSafeInteger(presence.appliedRevision) || presence.appliedRevision < 0)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'appliedRevision must be a nonnegative integer.');
  if (presence.viewport !== undefined) {
    const viewport = object(presence.viewport, 'viewport must be an object.');
    exactKeys(viewport, ['width', 'height']);
    if (![viewport.width, viewport.height].every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 16384)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Viewport dimensions must be finite positive values no greater than 16384.');
  }
  if (presence.renderStatus !== undefined && !['loading', 'ready', 'error'].includes(presence.renderStatus)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'renderStatus is invalid.');
  if (presence.renderError !== undefined && presence.renderError !== null && (typeof presence.renderError !== 'string' || !PRESENTATION_RENDER_ERRORS.has(presence.renderError))) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'renderError is not an allowed code.');
  return presence as PresenceReport;
}
