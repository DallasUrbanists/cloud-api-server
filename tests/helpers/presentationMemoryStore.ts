import type { PresentationStore, PresentationTransaction, StoredDocument } from '../../src/services/presentationStore.js';

/** Serialized Firestore-shaped fixture with rollback-on-error transaction semantics. */
export class PresentationMemoryStore implements PresentationStore {
  readonly documents = new Map<string, Record<string, any>>();
  private queue: Promise<unknown> = Promise.resolve();

  async runTransaction<T>(operation: (transaction: PresentationTransaction) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const writes: Array<() => void> = [];
      let hasWritten = false;
      const transaction: PresentationTransaction = {
        get: async path => {
          if (hasWritten) throw new Error('Transaction reads must precede writes.');
          const data = this.documents.get(path);
          return data === undefined ? undefined : structuredClone(data);
        },
        set: (path, data, merge = false) => {
          hasWritten = true;
          writes.push(() => this.documents.set(path, merge ? { ...(this.documents.get(path) ?? {}), ...structuredClone(data) } : structuredClone(data)));
        },
        update: (path, data) => {
          hasWritten = true;
          writes.push(() => {
            const existing = this.documents.get(path);
            if (!existing) throw new Error(`Cannot update missing document ${path}`);
            this.documents.set(path, { ...existing, ...structuredClone(data) });
          });
        },
        delete: path => { hasWritten = true; writes.push(() => this.documents.delete(path)); },
      };
      const result = await operation(transaction);
      writes.forEach(write => write());
      return result;
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async get(path: string): Promise<Record<string, any> | undefined> {
    const data = this.documents.get(path);
    return data === undefined ? undefined : structuredClone(data);
  }

  async list(collectionPath: string): Promise<StoredDocument[]> {
    const prefix = `${collectionPath}/`;
    return [...this.documents.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, data]) => ({ id: path.slice(prefix.length), data: structuredClone(data) }));
  }
}
