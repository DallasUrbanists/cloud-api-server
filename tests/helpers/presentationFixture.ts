import { randomUUID, randomBytes } from 'node:crypto';
import { PresentationService, type EnrollmentRequest } from '../../src/services/presentationService.js';
import { initialPresentationState } from '../../src/models/presentation.js';
import { PresentationMemoryStore } from './presentationMemoryStore.js';

export function suggestion(id = 41, changes: Record<string, any> = {}): any {
  return {
    id, creationDate: '2026-10-21T12:00:00.000Z', modificationDate: '2026-10-21T12:00:00.000Z', status: 'new',
    author: { email: 'private@example.com', name: 'Public Author' }, uid: 'private-uid', internal: { generationRequest: 'secret' },
    content: { summary: 'Safer crossing', details: 'Add a protected crossing near the school.', photos: [
      { url: 'https://images.example/crossing.jpg?token=private', caption: 'Current conditions', timestamp: '2026-10-21T12:00:00.000Z', internal: 'private' },
    ] },
    location: { latitude: 32.78, longitude: -96.79, address: '100 Elm St', description: 'Near the school' },
    ...changes,
  };
}

export function makeFixture(options: { initialSuggestions?: any[]; now?: number } = {}) {
  const store = new PresentationMemoryStore();
  let now = options.now ?? Date.UTC(2026, 9, 21, 18, 0, 0);
  let codeNumber = 1;
  const codes: string[] = [];
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const makeCode = () => {
    if (codes.length) return codes.shift()!;
    let current = codeNumber++;
    let value = '';
    for (let i = 0; i < 8; i++) { value = alphabet[current & 31] + value; current >>>= 5; }
    return value;
  };
  const suggestions = new Map<number, any>((options.initialSuggestions ?? [suggestion()]).map(item => [item.id, item]));
  const service = new PresentationService(store, {
    now: () => now,
    code: makeCode,
    getSuggestion: async id => suggestions.get(id) ?? null,
    getSuggestionPage: async (afterId, limit) => {
      const available = [...suggestions.values()].filter(item => !afterId || item.id > Number(afterId)).sort((a, b) => a.id - b.id);
      const items = available.slice(0, limit);
      return { items, nextCursor: available.length > limit ? String(items.at(-1).id) : null };
    },
  });
  return { store, service, suggestions, now: () => now, setNow: (value: number) => { now = value; } };
}

export function participant(): EnrollmentRequest {
  return { protocolVersion: 1, participantId: randomUUID(), participantToken: randomBytes(32).toString('base64url') };
}

export async function createRoom(fixture = makeFixture(), actor = participant()) {
  const key = randomUUID();
  const created = await fixture.service.createSession(actor, key, 'create-ip');
  return { fixture, actor, created, key };
}

export function writableState(state: ReturnType<typeof initialPresentationState>): any {
  const { revision: _revision, ideaEpoch: _ideaEpoch, ...writable } = state;
  return structuredClone(writable);
}
