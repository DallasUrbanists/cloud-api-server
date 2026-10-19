/**
 * Streetmix creation and read-back verification against the pinned schema fixture.
 * Creation is deliberately never retried, including on network and parse errors.
 * @module
 */
import { StreetmixError, type StreetmixDesign } from '../models/streetmix.js';
import { streetmixJson } from './streetmixSources.js';

const API = 'https://streetmix.net/api/v1/streets';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A minimal confirmed receipt, excluding provider IP/user metadata. */
export interface StreetmixPublication { id: string; namespacedId: number }

/** Dispatches exactly one anonymous create; any missing receipt is an uncertain outcome. */
export async function publishStreetmix(design: StreetmixDesign, signal: AbortSignal): Promise<StreetmixPublication> {
  try {
    signal.throwIfAborted();
    const data = await streetmixJson(API, signal, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: design.street.name, data: design, clientUpdatedAt: new Date().toISOString() }) }, false);
    if (!uuid.test(data?.id) || !Number.isSafeInteger(data.namespacedId) || data.namespacedId < 1 || data.creatorId) throw new Error('Invalid receipt');
    return { id: data.id, namespacedId: data.namespacedId };
  } catch {
    throw new StreetmixError(502, 'PUBLICATION_UNCERTAIN', 'Streetmix publication may have succeeded. Retry only with the same request key; another street will not be created.');
  }
}

/** Confirms the stored cross-section before exposing a successful URL. */
export async function verifyStreetmix(publication: StreetmixPublication, design: StreetmixDesign, signal: AbortSignal): Promise<void> {
  const data = await streetmixJson(`${API}/${publication.id}`, signal);
  const street = data?.data?.street;
  if (data?.id !== publication.id || data?.namespacedId !== publication.namespacedId || data?.creatorId
    || street?.schemaVersion !== design.street.schemaVersion || street?.units !== design.street.units
    || street?.width !== design.street.width || !Array.isArray(street?.segments)
    || street.segments.length !== design.street.segments.length
    || street.segments.some((segment: any, index: number) => {
      const expected = design.street.segments[index];
      return segment?.id !== expected.id || segment?.type !== expected.type || segment?.variantString !== expected.variantString || segment?.width !== expected.width || segment?.elevation !== expected.elevation;
    })) throw new StreetmixError(502, 'PUBLICATION_VERIFICATION_FAILED', 'Streetmix created a street, but its stored design could not be verified. Retry with the same key to verify it again.');
}

/** Builds only anonymous, provider-owned URLs from a validated numeric namespace ID. */
export function streetmixUrl(publication: StreetmixPublication): string {
  return `https://streetmix.net/-/${publication.namespacedId}`;
}
