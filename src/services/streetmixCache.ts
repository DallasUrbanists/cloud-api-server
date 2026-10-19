/**
 * Cross-instance source and publication caching, with fenced 90-second read leases.
 * Publishing intent never expires automatically: an uncertain create must not repeat.
 * @module
 */
import { randomUUID } from 'node:crypto';
import { getFirestoreDb } from '../config/firestore.js';
import { StreetmixError } from '../models/streetmix.js';
import type { StreetmixDraft } from './streetmixStore.js';

/** Shared state is separate from per-application request receipts and quotas. */
export interface StreetmixCacheRecord {
  state: 'working' | 'ready' | 'publishing' | 'published' | 'failed';
  attempt: string;
  expiresAtMs: number;
  value?: unknown;
  draft?: StreetmixDraft;
  publication?: { id: string; namespacedId: number };
}

/** Injectable distributed ownership boundary. Only the current attempt may write. */
export interface StreetmixCache {
  claim(id: string, signal: AbortSignal): Promise<{ owner: boolean; record: StreetmixCacheRecord }>;
  update(id: string, attempt: string, patch: Partial<StreetmixCacheRecord>, signal: AbortSignal): Promise<void>;
}

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  let cancel: () => void = () => {};
  try {
    deadline.throwIfAborted();
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new StreetmixError(signal.aborted ? 504 : 503, signal.aborted ? 'GENERATION_TIMEOUT' : 'STORAGE_UNAVAILABLE', 'Shared street cache is unavailable. Retry with the same request key.'));
      deadline.addEventListener('abort', cancel, { once: true });
    })]);
  } catch (error) {
    if (error instanceof StreetmixError) throw error;
    throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Shared street cache is unavailable. Retry with the same request key.');
  } finally { deadline.removeEventListener('abort', cancel); }
}

/** Atomic leases deduplicate work across replicas; ready entries alone receive TTL cleanup. */
export class FirestoreStreetmixCache implements StreetmixCache {
  async claim(id: string, signal: AbortSignal) {
    const db = getFirestoreDb(), ref = db.collection('streetmix-location-cache').doc(id);
    return bounded(db.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data() as StreetmixCacheRecord | undefined;
      if (current && (!['working', 'ready', 'publishing', 'published', 'failed'].includes(current.state) || !Number.isSafeInteger(current.expiresAtMs) || typeof current.attempt !== 'string'
        || current.state === 'ready' && current.value === undefined || current.state === 'published' && (!current.publication || !current.draft))) throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Shared street cache is incomplete. Publication will not be repeated.');
      if (current && (['publishing', 'published'].includes(current.state) || current.state !== 'failed' && current.expiresAtMs > Date.now())) return { owner: false, record: current };
      const record: StreetmixCacheRecord = { state: 'working', attempt: randomUUID(), expiresAtMs: Date.now() + 90000 };
      transaction.set(ref, record);
      return { owner: true, record };
    }, { maxAttempts: 3 }), signal);
  }

  async update(id: string, attempt: string, patch: Partial<StreetmixCacheRecord>, signal: AbortSignal): Promise<void> {
    const db = getFirestoreDb(), ref = db.collection('streetmix-location-cache').doc(id);
    await bounded(db.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data() as StreetmixCacheRecord | undefined;
      if (current?.attempt !== attempt) throw new StreetmixError(409, 'RESERVATION_EXPIRED', 'Another request owns this location. Retry with the same key.');
      transaction.update(ref, { ...patch, ...(patch.state === 'ready' ? { expiresAt: new Date(patch.expiresAtMs ?? current.expiresAtMs) } : {}) });
    }, { maxAttempts: 3 }), signal);
  }
}

/** Waits without starting duplicate work; each caller retains its own cancellation/deadline. */
export async function waitForStreetmixCache(cache: StreetmixCache, id: string, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    const claimed = await cache.claim(id, signal);
    if (claimed.owner || !(claimed.record.state === 'working' || claimed.record.state === 'publishing' && claimed.record.expiresAtMs > Date.now())) return claimed;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new StreetmixError(504, 'GENERATION_TIMEOUT', 'Waiting for this location exceeded the request deadline. Retry with the same key.')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 750);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
