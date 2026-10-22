import type { PresentationStore, PresentationTransaction, StoredDocument } from '../../src/services/presentationStore.js';

/** Serialized Firestore-shaped fixture with rollback-on-error transaction semantics. */
export class PresentationMemoryStore implements PresentationStore {
  readonly documents = new Map<string, Record<string, any>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly documentWatchers = new Map<string, Set<(document: Record<string, any> | undefined) => void>>();
  private readonly collectionWatchers = new Map<string, Set<(documents: StoredDocument[]) => void>>();

  async runTransaction<T>(operation: (transaction: PresentationTransaction) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const writes: Array<() => void> = [];
      const changedPaths = new Set<string>();
      let hasWritten = false;
      const transaction: PresentationTransaction = {
        get: async path => {
          if (hasWritten) throw new Error('Transaction reads must precede writes.');
          const data = this.documents.get(path);
          return data === undefined ? undefined : structuredClone(data);
        },
        set: (path, data, merge = false) => {
          hasWritten = true;
          changedPaths.add(path);
          writes.push(() => this.documents.set(path, merge ? { ...(this.documents.get(path) ?? {}), ...structuredClone(data) } : structuredClone(data)));
        },
        update: (path, data) => {
          hasWritten = true;
          changedPaths.add(path);
          writes.push(() => {
            const existing = this.documents.get(path);
            if (!existing) throw new Error(`Cannot update missing document ${path}`);
            this.documents.set(path, { ...existing, ...structuredClone(data) });
          });
        },
        delete: path => { hasWritten = true; changedPaths.add(path); writes.push(() => this.documents.delete(path)); },
      };
      const result = await operation(transaction);
      writes.forEach(write => write());
      for (const path of changedPaths) this.publish(path);
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

  watchDocument(path: string, onChange: (document: Record<string, any> | undefined) => void, _onError: (error: unknown) => void): () => void {
    let watchers = this.documentWatchers.get(path);
    if (!watchers) this.documentWatchers.set(path, watchers = new Set());
    watchers.add(onChange);
    onChange(structuredClone(this.documents.get(path)));
    return () => { watchers!.delete(onChange); if (!watchers!.size) this.documentWatchers.delete(path); };
  }

  watchCollection(collectionPath: string, onChange: (documents: StoredDocument[]) => void, _onError: (error: unknown) => void): () => void {
    let watchers = this.collectionWatchers.get(collectionPath);
    if (!watchers) this.collectionWatchers.set(collectionPath, watchers = new Set());
    watchers.add(onChange);
    void this.list(collectionPath).then(onChange);
    return () => { watchers!.delete(onChange); if (!watchers!.size) this.collectionWatchers.delete(collectionPath); };
  }

  private publish(path: string): void {
    for (const callback of this.documentWatchers.get(path) ?? []) {
      try { callback(structuredClone(this.documents.get(path))); } catch { /* A test subscriber cannot fail the committed write. */ }
    }
    for (const [collection, callbacks] of this.collectionWatchers) {
      const prefix = `${collection}/`;
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      void this.list(collection).then(documents => {
        for (const callback of callbacks) {
          try { callback(documents); } catch { /* A test subscriber cannot fail the committed write. */ }
        }
      });
    }
  }
}
