/** Durable Firestore store for presentation sessions, participants, receipts, and shared limits. */
import type { Firestore, Transaction } from '@google-cloud/firestore';

export interface StoredDocument { id: string; data: Record<string, any>; }
export interface PresentationTransaction {
  get(path: string): Promise<Record<string, any> | undefined>;
  set(path: string, data: Record<string, any>, merge?: boolean): void;
  update(path: string, data: Record<string, any>): void;
  delete(path: string): void;
}
export interface PresentationStore {
  runTransaction<T>(operation: (transaction: PresentationTransaction) => Promise<T>): Promise<T>;
  get(path: string): Promise<Record<string, any> | undefined>;
  list(collectionPath: string): Promise<StoredDocument[]>;
}

export const presentationPaths = {
  session: (id: string) => `presentationSessions/${id}`,
  participant: (sessionId: string, participantId: string) => `presentationSessions/${sessionId}/participants/${participantId}`,
  participantCollection: (sessionId: string) => `presentationSessions/${sessionId}/participants`,
  bootstrapReceipt: (keyHash: string) => `presentationBootstrapReceipts/${keyHash}`,
  stateReceipt: (sessionId: string, keyHash: string) => `presentationSessions/${sessionId}/receipts/${keyHash}`,
  codeLookup: (purpose: 'presenter' | 'audience', codeHash: string) => `presentationCodeLookups/${purpose}_${codeHash}`,
  rateLimit: (scope: string, identityHash: string, bucket: number) => `presentationRateLimits/${scope}_${identityHash}_${bucket}`,
};

/** Firestore adapter intentionally accepts the database so tests can use a separate demo project/database. */
export class FirestorePresentationStore implements PresentationStore {
  constructor(private readonly db: Firestore) {}

  async runTransaction<T>(operation: (transaction: PresentationTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (transaction: Transaction) => operation({
      get: async path => {
        const snapshot = await transaction.get(this.db.doc(path));
        return snapshot.exists ? snapshot.data() as Record<string, any> : undefined;
      },
      set: (path, data, merge = false) => {
        const ref = this.db.doc(path);
        if (merge) transaction.set(ref, data, { merge: true });
        else transaction.set(ref, data);
      },
      update: (path, data) => transaction.update(this.db.doc(path), data),
      delete: path => transaction.delete(this.db.doc(path)),
    }), { maxAttempts: 8 });
  }

  async get(path: string): Promise<Record<string, any> | undefined> {
    const snapshot = await this.db.doc(path).get();
    return snapshot.exists ? snapshot.data() as Record<string, any> : undefined;
  }

  async list(collectionPath: string): Promise<StoredDocument[]> {
    const snapshot = await this.db.collection(collectionPath).get();
    return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() as Record<string, any> }));
  }
}
