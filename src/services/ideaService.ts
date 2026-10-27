/**
 * Firestore persistence and normalization for civic ideas in public-improvements.
 *
 * @remarks
 * Counter allocation is transactional, but allocation and document creation are
 * separate writes. Nested action/log lifecycles live in RecommendedActionService.
 * @module
 */
import { Timestamp, FieldValue } from '@google-cloud/firestore';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { ideasCollectionName, ideasCounterFieldName } from '../config/ideas.js';
import { BoundaryService } from './boundaryService.js';
import { ideaStreetmixSummary } from '../models/ideaStreetmix.js';
import { canonicalizeIdeaPhotos } from './ideaMediaService.js';
import {
  Idea,
  CreateIdeaDTO,
  UpdateIdeaDTO,
  IdeaStatus,
  IdeaContent,
} from '../models/idea.js';

const COUNTER_DOC_PATH = '_metadata/counters';

/**
 * Converts known timestamp forms; missing values use now, while other values are stringified rather than validated.
 */
function toIsoDateString(val: any, fallback: string): string {
  if (!val) return fallback;
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val.toDate === 'function') {
    return val.toDate().toISOString();
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  return String(val);
}

/**
 * Projects stored fields with legacy defaults; does not validate persisted status or coordinate values.
 */
export function mapDocToIdea(docData: any, docId: string, fallbackDate = new Date().toISOString()): Idea {
  const idNumber = typeof docData.id === 'number' ? docData.id : parseInt(docId, 10) || 0;

  const content: IdeaContent = {
    summary: docData.content?.summary || '',
    details: docData.content?.details || '',
  };

  if (Array.isArray(docData.content?.photos)) {
    content.photos = docData.content.photos.map((p: any) => ({
      url: p.url || '',
      caption: p.caption || '',
      timestamp: toIsoDateString(p.timestamp, fallbackDate),
    }));
  }

  return {
    id: idNumber,
    ...(typeof docData.emoji === 'string' && docData.emoji ? { emoji: docData.emoji } : {}),
    boundaryIds: Array.isArray(docData.boundaryIds) ? docData.boundaryIds : [],
    creationDate: toIsoDateString(docData.creationDate, fallbackDate),
    modificationDate: toIsoDateString(docData.modificationDate, fallbackDate),
    status: docData.status as IdeaStatus,
    author: {
      email: docData.author?.email || '',
      name: docData.author?.name || '',
    },
    content,
    streetmix: ideaStreetmixSummary(docData.streetmix, docData.location),
    location: {
      latitude: docData.location?.latitude,
      longitude: docData.location?.longitude,
      description: docData.location?.description || '',
      address: docData.location?.address || '',
    },
  };
}

/** Stores base ideas; callers perform input validation and mutation authorization. */
export class IdeaService {
  /** Reads one public presentation source record, excluding an in-progress deletion. */
  static async getForPresentation(id: number): Promise<Idea | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const snapshot = await getPublicImprovementsDb().collection(ideasCollectionName()).doc(String(id)).get();
    if (!snapshot.exists || snapshot.get('_deleting') === true) return null;
    return mapDocToIdea(snapshot.data(), snapshot.id);
  }

  /** Returns a stable numeric-ID page for presentation catalogs, omitting records being deleted. */
  static async getPresentationPage(afterId: string | null, limit: number): Promise<{ items: Idea[]; nextCursor: string | null }> {
    const db = getPublicImprovementsDb();
    const after = afterId === null ? undefined : Number(afterId);
    let query = db.collection(ideasCollectionName()).orderBy('id', 'asc') as FirebaseFirestore.Query;
    if (after !== undefined) query = query.startAfter(after);
    let cursor = after;
    const items: Idea[] = [];
    while (items.length <= limit) {
      let page = query.limit(Math.max(limit + 1, 25));
      if (cursor !== undefined) page = db.collection(ideasCollectionName()).orderBy('id', 'asc').startAfter(cursor).limit(Math.max(limit + 1, 25)) as FirebaseFirestore.Query;
      const snapshot = await page.get();
      if (snapshot.empty) break;
      for (const doc of snapshot.docs) {
        cursor = Number(doc.get('id') ?? doc.id);
        if (doc.get('_deleting') === true) continue;
        items.push(mapDocToIdea(doc.data(), doc.id));
        if (items.length > limit) break;
      }
      if (items.length > limit || snapshot.size < Math.max(limit + 1, 25)) break;
    }
    const hasMore = items.length > limit;
    const visible = hasMore ? items.slice(0, limit) : items;
    return { items: visible, nextCursor: hasMore ? visible.at(-1)!.id.toString() : null };
  }

  /**
   * Generates the next sequential integer ID atomically using Firestore transactions.
   */
  private static async getNextId(): Promise<number> {
    const db = getPublicImprovementsDb();
    const counterRef = db.doc(COUNTER_DOC_PATH);

    return await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      const counterField = ideasCounterFieldName();
      let currentId = 0;

      if (counterDoc.exists) {
        currentId = counterDoc.data()?.[counterField] || 0;
      }

      const nextId = currentId + 1;
      transaction.set(
        counterRef,
        {
          [counterField]: nextId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return nextId;
    });
  }

  /**
   * Reads ideas ordered by stored identifier, with optional status/normalized-author filters and limit.
   * @remarks Returns base records only, not nested actions or activity; no implicit limit is added.
   * @example
   * Let's imagine browsing neighbors' ideas for improving streets. This brings back
   * the idea cards, or just the ones at a particular stage of progress.
   */
  static async getAll(filters?: {
    status?: IdeaStatus;
    authorEmail?: string;
    limit?: number;
  }): Promise<Idea[]> {
    const db = getPublicImprovementsDb();
    let query = db.collection(ideasCollectionName()).orderBy('id', 'asc') as FirebaseFirestore.Query;

    if (filters?.status) {
      query = query.where('status', '==', filters.status);
    }
    if (filters?.authorEmail) {
      query = query.where('author.email', '==', filters.authorEmail.toLowerCase().trim());
    }
    if (filters?.limit && filters.limit > 0) {
      query = query.limit(filters.limit);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => mapDocToIdea(doc.data(), doc.id));
  }

  /**
   * Reads one base record, returning null when absent; activity enrichment is a controller concern.
   */
  static async getById(id: number): Promise<Idea | null> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(ideasCollectionName()).doc(id.toString());
    const doc = await docRef.get();

    if (!doc.exists) {
      return null;
    }

    return mapDocToIdea(doc.data(), doc.id);
  }

  /** Stores a server-assigned emoji only if the idea does not already have one. */
  static async assignEmojiIfMissing(id: number, emoji: string): Promise<Idea | null> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(ideasCollectionName()).doc(id.toString());
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) return null;
      const data = snapshot.data() || {};
      if (typeof data.emoji !== 'string' || !data.emoji) transaction.update(docRef, { emoji });
      return mapDocToIdea({ ...data, emoji: typeof data.emoji === 'string' && data.emoji ? data.emoji : emoji }, snapshot.id);
    });
  }

  /**
   * Allocates or accepts an identifier, normalizes attribution, and writes the new base record.
   * @remarks Explicit-ID existence checking is read-before-set, not an atomic create;
   * auto-number allocation can leave gaps if the subsequent write fails. Resolves location boundaries before saving.
   * @example
   * Let's imagine a neighbor shares a wish for a bench. This saves the idea as a
   * new page in the community's notebook so it can be read later.
   */
  static async create(dto: CreateIdeaDTO): Promise<Idea> {
    const db = getPublicImprovementsDb();
    if (dto.content.photos) dto.content.photos = await canonicalizeIdeaPhotos(dto.content.photos, db);
    const nextId = dto.id ?? (await this.getNextId());
    const docRef = db.collection(ideasCollectionName()).doc(nextId.toString());

    // Check if provided ID already exists
    if (dto.id !== undefined) {
      const existing = await docRef.get();
      if (existing.exists) {
        throw new Error(`An idea with ID ${dto.id} already exists.`);
      }
    }

    const now = new Date();
    const docData = {
      id: nextId,
      boundaryIds: (await BoundaryService.findApplicableToLocation(dto.location ?? {})).map(boundary => boundary.id),
      creationDate: now.toISOString(),
      modificationDate: now.toISOString(),
      status: dto.status || 'new',
      author: {
        email: dto.author.email.toLowerCase().trim(),
        name: dto.author.name.trim(),
      },
      content: {
        summary: dto.content.summary.trim(),
        details: dto.content.details || '',
        ...(dto.content.photos !== undefined ? { photos: dto.content.photos } : {}),
      },
      location: {
        latitude: dto.location?.latitude ?? null,
        longitude: dto.location?.longitude ?? null,
        description: dto.location?.description || '',
        address: dto.location?.address || '',
      },
    };

    await docRef.set(docData);

    return mapDocToIdea(docData, nextId.toString());
  }

  /**
   * Merges supplied nested fields and advances modification time, returning null when absent.
   * @remarks Transactional field patches preserve server-managed metadata and fence deletion.
   * Boundary matching is not rerun here.
   */
  static async update(id: number, dto: UpdateIdeaDTO): Promise<Idea | null> {
    const db = getPublicImprovementsDb();
    if (dto.content?.photos) dto.content.photos = await canonicalizeIdeaPhotos(dto.content.photos, db);
    const docRef = db.collection(ideasCollectionName()).doc(id.toString());
    return db.runTransaction(async transaction => {
      const existingDoc = await transaction.get(docRef);

      if (!existingDoc.exists) {
        return null;
      }

      const existingData = existingDoc.data() || {};
      if (existingData._deleting) throw Object.assign(new Error('Idea deletion is in progress.'), { status: 409 });
      const now = new Date().toISOString();

      const updatedData: Record<string, any> = {
        modificationDate: now,
      };

      if (dto.status !== undefined) {
        updatedData.status = dto.status;
      }

      if (dto.author !== undefined) {
        updatedData.author = {
          ...existingData.author,
          ...(dto.author.email ? { email: dto.author.email.toLowerCase().trim() } : {}),
          ...(dto.author.name ? { name: dto.author.name.trim() } : {}),
        };
      }

      if (dto.content !== undefined) {
        updatedData.content = {
          ...existingData.content,
          ...(dto.content.summary ? { summary: dto.content.summary.trim() } : {}),
          ...(dto.content.details !== undefined ? { details: dto.content.details } : {}),
          ...(dto.content.photos !== undefined ? { photos: dto.content.photos } : {}),
        };
      }

      if (dto.location !== undefined) {
        updatedData.location = {
          ...existingData.location,
          ...(dto.location.latitude !== undefined ? { latitude: dto.location.latitude } : {}),
          ...(dto.location.longitude !== undefined ? { longitude: dto.location.longitude } : {}),
          ...(dto.location.description !== undefined ? { description: dto.location.description } : {}),
          ...(dto.location.address !== undefined ? { address: dto.location.address } : {}),
        };
      }

      transaction.update(docRef, updatedData);

      return mapDocToIdea({ ...existingData, ...updatedData }, id.toString());
    });
  }

  /**
   * Marks deletion in a transaction, recursively removes actions/logs, then deletes the parent.
   * @remarks Cleanup spans multiple operations; failure can leave partial child cleanup
   * and attempts to reopen the deletion flag for retry. Image objects are not deleted here.
   * @returns False for a missing parent; concurrent deletion or storage failures reject.
   */
  static async delete(id: number): Promise<boolean> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(ideasCollectionName()).doc(id.toString());
    let found = false;
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) return;
      found = true;
      if (doc.get('_deleting') === true) throw Object.assign(new Error('Idea deletion is already in progress.'), { status: 409 });
      transaction.update(docRef, { _deleting: true });
    });
    if (!found) return false;

    try {
      await db.recursiveDelete(docRef.collection('recommendedActions'));
      await db.recursiveDelete(docRef.collection('log'));
      for (const collection of ['streetmix', 'streetmixRequests', 'streetmixRequestKeys']) await db.recursiveDelete(docRef.collection(collection));
      await docRef.delete();
      return true;
    } catch (error) {
      // Partial child cleanup is safe to retry; reopen writes only after cleanup failed.
      await docRef.update({ _deleting: false }).catch(() => undefined);
      throw error;
    }
  }
}
