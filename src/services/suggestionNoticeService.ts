/** Committed suggestion changes shared by all local WebSocket connections. */
import { isDeepStrictEqual } from 'node:util';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { mapDocToSuggestion } from './suggestionService.js';
import type { Suggestion } from '../models/suggestion.js';

export interface SuggestionNotice {
  type: 'suggestion.created' | 'suggestion.updated' | 'suggestion.deleted';
  suggestionId: number;
}

/** Minimal listener boundary, also usable with the Firestore emulator or test snapshots. */
export interface SuggestionSnapshot {
  docChanges(): Array<{ type: 'added' | 'modified' | 'removed'; doc: { id: string; data(): unknown } }>;
}
export type SuggestionWatch = (next: (snapshot: SuggestionSnapshot) => void, error: (error: unknown) => void) => () => void;
interface Subscriber {
  ready(): void;
  notice(notice: SuggestionNotice): void;
  failed(): void;
}

/** Lazily owns one collection listener, suppressing its initial snapshot and internal-only writes. */
export class SuggestionNoticeService {
  private subscribers = new Set<Subscriber>();
  private baseline = new Map<string, Suggestion>();
  private initialized = false;
  private running = false;
  private generation = 0;
  private unsubscribe?: () => void;

  constructor(private readonly watch: SuggestionWatch = (next, error) =>
    getPublicImprovementsDb().collection('suggestion').onSnapshot(next, error)) {}

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
      console.warn(JSON.stringify({ event: 'suggestion_listener_failed' }));
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
              if (this.initialized && previous) this.broadcast({ type: 'suggestion.deleted', suggestionId: previous.id });
              continue;
            }
            // A stable fallback prevents legacy missing dates from generating false changes.
            const suggestion = mapDocToSuggestion(change.doc.data(), change.doc.id, '1970-01-01T00:00:00.000Z');
            if (!Number.isSafeInteger(suggestion.id) || suggestion.id < 1) continue;
            this.baseline.set(change.doc.id, suggestion);
            if (this.initialized && !isDeepStrictEqual(previous, suggestion)) {
              this.broadcast({ type: previous ? 'suggestion.updated' : 'suggestion.created', suggestionId: suggestion.id });
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

  private broadcast(notice: SuggestionNotice): void {
    for (const subscriber of this.subscribers) subscriber.notice(notice);
  }
}
