/** Committed idea changes shared by all local WebSocket connections. */
import { isDeepStrictEqual } from 'node:util';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { ideasCollectionName } from '../config/ideas.js';
import { mapDocToIdea } from './ideaService.js';
import type { Idea } from '../models/idea.js';

export interface IdeaNotice {
  type: 'idea.created' | 'idea.updated' | 'idea.deleted';
  ideaId: number;
}

/** Minimal listener boundary, also usable with the Firestore emulator or test snapshots. */
export interface IdeaSnapshot {
  docChanges(): Array<{ type: 'added' | 'modified' | 'removed'; doc: { id: string; data(): unknown } }>;
}
export type IdeaWatch = (next: (snapshot: IdeaSnapshot) => void, error: (error: unknown) => void) => () => void;
interface Subscriber {
  ready(): void;
  notice(notice: IdeaNotice): void;
  failed(): void;
}

/** Lazily owns one collection listener, suppressing its initial snapshot and internal-only writes. */
export class IdeaNoticeService {
  private subscribers = new Set<Subscriber>();
  private baseline = new Map<string, Idea>();
  private initialized = false;
  private running = false;
  private generation = 0;
  private unsubscribe?: () => void;

  constructor(private readonly watch: IdeaWatch = (next, error) =>
    getPublicImprovementsDb().collection(ideasCollectionName()).onSnapshot(next, error)) {}

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.initialized) subscriber.ready();
    if (!this.running) this.start();
    return () => {
      this.subscribers.delete(subscriber);
      if (!this.subscribers.size) this.stop();
    };
  }

  stop(): void {
    this.generation++;
    this.running = false;
    this.initialized = false;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
    this.baseline.clear();
  }

  private start(): void {
    this.running = true;
    const generation = ++this.generation;
    const fail = () => {
      if (generation !== this.generation) return;
      const subscribers = [...this.subscribers];
      this.subscribers.clear();
      this.stop();
      console.warn(JSON.stringify({ event: 'idea_listener_failed' }));
      for (const subscriber of subscribers) subscriber.failed();
    };
    try {
      const unsubscribe = this.watch(snapshot => {
        if (generation !== this.generation) return;
        try {
          for (const change of snapshot.docChanges()) {
            const previous = this.baseline.get(change.doc.id);
            if (change.type === 'removed') {
              this.baseline.delete(change.doc.id);
              if (this.initialized && previous) this.broadcast({ type: 'idea.deleted', ideaId: previous.id });
              continue;
            }
            // A stable fallback prevents legacy missing dates from generating false changes.
            const idea = mapDocToIdea(change.doc.data(), change.doc.id, '1970-01-01T00:00:00.000Z');
            if (!Number.isSafeInteger(idea.id) || idea.id < 1) continue;
            this.baseline.set(change.doc.id, idea);
            if (this.initialized && !isDeepStrictEqual(previous, idea)) {
              this.broadcast({ type: previous ? 'idea.updated' : 'idea.created', ideaId: idea.id });
            }
          }
          if (!this.initialized) {
            this.initialized = true;
            for (const subscriber of this.subscribers) subscriber.ready();
          }
        } catch { fail(); }
      }, fail);
      if (generation === this.generation) this.unsubscribe = unsubscribe;
      else unsubscribe();
    } catch { fail(); }
  }

  private broadcast(notice: IdeaNotice): void {
    for (const subscriber of this.subscribers) subscriber.notice(notice);
  }
}
