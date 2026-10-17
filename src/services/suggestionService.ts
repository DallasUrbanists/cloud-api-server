/**
 * Firestore persistence and normalization for civic suggestions in public-improvements.
 *
 * @remarks
 * Counter allocation is transactional, but allocation and document creation are
 * separate writes. Nested action/log lifecycles live in RecommendedActionService.
 * @module
 */
import { Timestamp, FieldValue } from '@google-cloud/firestore';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { BoundaryService } from './boundaryService.js';
import {
  Suggestion,
  CreateSuggestionDTO,
  UpdateSuggestionDTO,
  SuggestionStatus,
  SuggestionContent,
} from '../models/suggestion.js';

const COLLECTION_NAME = 'suggestion';
const COUNTER_DOC_PATH = '_metadata/counters';

/**
 * Converts known timestamp forms; missing values use now, while other values are stringified rather than validated.
 */
function toIsoDateString(val: any): string {
  if (!val) return new Date().toISOString();
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
function mapDocToSuggestion(docData: any, docId: string): Suggestion {
  const idNumber = typeof docData.id === 'number' ? docData.id : parseInt(docId, 10) || 0;

  const content: SuggestionContent = {
    summary: docData.content?.summary || '',
    details: docData.content?.details || '',
  };

  if (Array.isArray(docData.content?.photos)) {
    content.photos = docData.content.photos.map((p: any) => ({
      url: p.url || '',
      caption: p.caption || '',
      timestamp: toIsoDateString(p.timestamp),
    }));
  }

  return {
    id: idNumber,
    boundaryIds: Array.isArray(docData.boundaryIds) ? docData.boundaryIds : [],
    creationDate: toIsoDateString(docData.creationDate),
    modificationDate: toIsoDateString(docData.modificationDate),
    status: docData.status as SuggestionStatus,
    author: {
      email: docData.author?.email || '',
      name: docData.author?.name || '',
    },
    content,
    location: {
      latitude: docData.location?.latitude,
      longitude: docData.location?.longitude,
      description: docData.location?.description || '',
      address: docData.location?.address || '',
    },
  };
}

/** Stores base suggestions; callers perform input validation and mutation authorization. */
export class SuggestionService {
  /**
   * Generates the next sequential integer ID atomically using Firestore transactions.
   */
  private static async getNextId(): Promise<number> {
    const db = getPublicImprovementsDb();
    const counterRef = db.doc(COUNTER_DOC_PATH);

    return await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      let currentId = 0;

      if (counterDoc.exists) {
        currentId = counterDoc.data()?.lastSuggestionId || 0;
      }

      const nextId = currentId + 1;
      transaction.set(
        counterRef,
        {
          lastSuggestionId: nextId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return nextId;
    });
  }

  /**
   * Reads suggestions ordered by stored identifier, with optional status/normalized-author filters and limit.
   * @remarks Returns base records only, not nested actions or activity; no implicit limit is added.
   * @example
   * Let's imagine browsing neighbors' ideas for improving streets. This brings back
   * the suggestion cards, or just the ones at a particular stage of progress.
   */
  static async getAll(filters?: {
    status?: SuggestionStatus;
    authorEmail?: string;
    limit?: number;
  }): Promise<Suggestion[]> {
    const db = getPublicImprovementsDb();
    let query = db.collection(COLLECTION_NAME).orderBy('id', 'asc') as FirebaseFirestore.Query;

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
    return snapshot.docs.map((doc) => mapDocToSuggestion(doc.data(), doc.id));
  }

  /**
   * Reads one base record, returning null when absent; activity enrichment is a controller concern.
   */
  static async getById(id: number): Promise<Suggestion | null> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(COLLECTION_NAME).doc(id.toString());
    const doc = await docRef.get();

    if (!doc.exists) {
      return null;
    }

    return mapDocToSuggestion(doc.data(), doc.id);
  }

  /**
   * Allocates or accepts an identifier, normalizes attribution, and writes the new base record.
   * @remarks Explicit-ID existence checking is read-before-set, not an atomic create;
   * auto-number allocation can leave gaps if the subsequent write fails. Resolves location boundaries before saving.
   * @example
   * Let's imagine a neighbor shares a wish for a bench. This saves the idea as a
   * new page in the community's notebook so it can be read later.
   */
  static async create(dto: CreateSuggestionDTO): Promise<Suggestion> {
    const db = getPublicImprovementsDb();
    const nextId = dto.id ?? (await this.getNextId());
    const docRef = db.collection(COLLECTION_NAME).doc(nextId.toString());

    // Check if provided ID already exists
    if (dto.id !== undefined) {
      const existing = await docRef.get();
      if (existing.exists) {
        throw new Error(`A suggestion with ID ${dto.id} already exists.`);
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

    return mapDocToSuggestion(docData, nextId.toString());
  }

  /**
   * Merges supplied nested fields and advances modification time, returning null when absent.
   * @remarks This read/merge/write is not a transaction or deletion fence; callers must
   * not infer lost-update prevention from nested merging. Matching is not rerun here.
   */
  static async update(id: number, dto: UpdateSuggestionDTO): Promise<Suggestion | null> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(COLLECTION_NAME).doc(id.toString());
    const existingDoc = await docRef.get();

    if (!existingDoc.exists) {
      return null;
    }

    const existingData = existingDoc.data() || {};
    const now = new Date().toISOString();

    const updatedData: Record<string, any> = {
      ...existingData,
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

    await docRef.set(updatedData, { merge: true });

    return mapDocToSuggestion(updatedData, id.toString());
  }

  /**
   * Marks deletion in a transaction, recursively removes actions/logs, then deletes the parent.
   * @remarks Cleanup spans multiple operations; failure can leave partial child cleanup
   * and attempts to reopen the deletion flag for retry. Image objects are not deleted here.
   * @returns False for a missing parent; concurrent deletion or storage failures reject.
   */
  static async delete(id: number): Promise<boolean> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(COLLECTION_NAME).doc(id.toString());
    let found = false;
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) return;
      found = true;
      if (doc.get('_deleting') === true) throw Object.assign(new Error('Suggestion deletion is already in progress.'), { status: 409 });
      transaction.update(docRef, { _deleting: true });
    });
    if (!found) return false;

    try {
      await db.recursiveDelete(docRef.collection('recommendedActions'));
      await db.recursiveDelete(docRef.collection('log'));
      await docRef.delete();
      return true;
    } catch (error) {
      // Partial child cleanup is safe to retry; reopen writes only after cleanup failed.
      await docRef.update({ _deleting: false }).catch(() => undefined);
      throw error;
    }
  }
}
