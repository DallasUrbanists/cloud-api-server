import { Timestamp, FieldValue } from '@google-cloud/firestore';
import { getPublicImprovementsDb } from '../config/firestore.js';
import {
  Suggestion,
  CreateSuggestionDTO,
  UpdateSuggestionDTO,
  SuggestionStatus,
} from '../models/suggestion.js';

const COLLECTION_NAME = 'suggestion';
const COUNTER_DOC_PATH = '_metadata/counters';

/**
 * Helper to convert Firestore timestamp or string to ISO string.
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
 * Maps raw Firestore document data to the typed Suggestion model.
 */
function mapDocToSuggestion(docData: any, docId: string): Suggestion {
  const idNumber = typeof docData.id === 'number' ? docData.id : parseInt(docId, 10) || 0;

  return {
    id: idNumber,
    creationDate: toIsoDateString(docData.creationDate),
    modificationDate: toIsoDateString(docData.modificationDate),
    status: docData.status as SuggestionStatus,
    author: {
      email: docData.author?.email || '',
      name: docData.author?.name || '',
    },
    content: {
      summary: docData.content?.summary || '',
      details: docData.content?.details || '',
    },
    location: {
      latitude: docData.location?.latitude,
      longitude: docData.location?.longitude,
      description: docData.location?.description || '',
      address: docData.location?.address || '',
    },
  };
}

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
   * Retrieves all suggestions with optional filtering.
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
   * Retrieves a single suggestion by its integer ID.
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
   * Creates a new suggestion.
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
   * Updates an existing suggestion by ID.
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
   * Deletes a suggestion by ID.
   */
  static async delete(id: number): Promise<boolean> {
    const db = getPublicImprovementsDb();
    const docRef = db.collection(COLLECTION_NAME).doc(id.toString());
    const doc = await docRef.get();

    if (!doc.exists) {
      return false;
    }

    await docRef.delete();
    return true;
  }
}
