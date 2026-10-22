/** Shared protocol v1 models and pure presentation validation helpers. */
import { createHash } from 'node:crypto';

export const PRESENTATION_PROTOCOL_VERSION = 1 as const;
export const DESCRIPTION_PAGE_CODE_POINTS = 320;
export const PRESENTER_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export type PresentationRole = 'receiver' | 'controller' | 'audience';
export type PresentationMode = 'map' | 'photo' | 'description';
export type PresentationView = PresentationMode;

export interface PresentationFrame { scale: number; centerX: number; centerY: number; }
export type PresentationAnimationEasing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';
export interface PresentationIconStyle {
  size: number;
  animationEnabled: boolean;
  pulseSize: number;
  pulseSpeed: number;
  bobbingRotation: number;
  bobbingSpeed: number;
  animationEasing: PresentationAnimationEasing;
}
export interface PresentationState {
  revision: number;
  ideaEpoch: number;
  selectedIdeaId: string | null;
  mode: PresentationMode;
  camera: { latitude: number; longitude: number; zoom: number };
  mapStyle: 'streets' | 'satellite';
  railVisible: boolean;
  theme: 'light' | 'dark';
  albumItemId: string | null;
  photoFrame: PresentationFrame;
  captionVisible: boolean;
  descriptionPage: number;
  audienceDisplay: { showQr: boolean; showCode: boolean };
  iconStyle: PresentationIconStyle;
}

export interface PresentationIdea {
  id: string;
  contentVersion: string;
  creationDate: string;
  status: string;
  summary: string;
  details: string;
  authorName?: string;
  descriptionPages: string[];
  location: { latitude: number | null; longitude: number | null; address: string; description: string };
  emoji?: string;
  album: Array<
    | { id: string; kind: 'photo'; url: string; caption: string }
    | { id: string; kind: 'streetmix'; url: string; streetmixId: string; thumbnailPath: string; stale: boolean }
  >;
}

export interface PresentationErrorPayload { error: string; message: string; }

export class PresentationError extends Error {
  constructor(public status: number, public code: string, message: string, public current?: unknown, public retryAfter?: number) {
    super(message);
    this.name = 'PresentationError';
  }
  toPayload(): PresentationErrorPayload & { current?: unknown } {
    return { error: this.code, message: this.message, ...(this.current === undefined ? {} : { current: this.current }) };
  }
}

export const initialPresentationState = (): PresentationState => ({
  revision: 0, ideaEpoch: 0, selectedIdeaId: null, mode: 'map',
  camera: { latitude: 32.7767, longitude: -96.797, zoom: 13 },
  mapStyle: 'streets', railVisible: true, theme: 'dark', albumItemId: null,
  photoFrame: { scale: 1, centerX: 0.5, centerY: 0.5 }, captionVisible: true,
  descriptionPage: 0, audienceDisplay: { showQr: false, showCode: false },
  iconStyle: { size: 100, animationEnabled: true, pulseSize: 1, pulseSpeed: 1, bobbingRotation: 0, bobbingSpeed: 1, animationEasing: 'ease-in-out' },
});

export function canonicalDescriptionPages(description: string): string[] {
  if (typeof description !== 'string' || description.trim().length === 0) return [''];
  const chars = Array.from(description);
  const pages: string[] = [];
  let start = 0;
  while (start < chars.length) {
    if (chars.length - start <= DESCRIPTION_PAGE_CODE_POINTS) {
      const last = chars.slice(start).join('').trimEnd();
      if (last || pages.length === 0) pages.push(last);
      break;
    }

    const maxEnd = start + DESCRIPTION_PAGE_CODE_POINTS;
    let paragraph = -1;
    for (let i = start; i < maxEnd; i++) {
      if (chars[i] === '\n' && (chars[i + 1] === '\n' || chars[i - 1] === '\n')) paragraph = i;
    }

    const sentenceEnd = lastPunctuationBoundary(chars, start, maxEnd, '.!?。！？…');
    const clauseEnd = lastPunctuationBoundary(chars, start, maxEnd, ',;，；');
    const naturalEnd = Math.max(paragraph, sentenceEnd);
    let boundary = naturalEnd >= start ? naturalEnd : clauseEnd;
    if (boundary < start) {
      for (let i = start; i < maxEnd; i++) if (/\s/u.test(chars[i])) boundary = i;
    }
    const end = boundary >= start ? boundary : maxEnd;
    const page = chars.slice(start, end).join('').trimEnd();
    if (page || pages.length === 0) pages.push(page);
    start = end;
    while (start < chars.length && /\s/u.test(chars[start])) start++;
  }
  return pages.length ? pages : [''];
}

function lastPunctuationBoundary(chars: string[], start: number, maxEnd: number, punctuation: string): number {
  const marks = new Set(Array.from(punctuation));
  const closingMarks = new Set(Array.from("\"'”’»)]}"));
  let boundary = -1;
  for (let i = start; i < maxEnd; i++) {
    if (!marks.has(chars[i])) continue;
    let end = i + 1;
    while (end < chars.length && marks.has(chars[end])) end++;
    if (punctuation.includes('.') || punctuation.includes('!') || punctuation.includes('?')) {
      while (end < chars.length && closingMarks.has(chars[end])) end++;
    }
    if (end <= maxEnd && (end === chars.length || /\s/u.test(chars[end]))) boundary = end;
  }
  return boundary;
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function finiteCoordinate(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function safePhotoUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    // Public media URLs never carry query credentials or fragments into this API.
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

export function publicPresentationIdea(suggestion: any, sessionId = '{sessionId}'): PresentationIdea {
  const id = String(suggestion?.id ?? '');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
  const photos = Array.isArray(suggestion?.content?.photos) ? suggestion.content.photos : [];
  const seen = new Map<string, number>();
  const album: PresentationIdea['album'] = [];
  for (const photo of photos) {
    if (typeof photo?.url !== 'string') continue;
    const url = safePhotoUrl(photo.url);
    if (!url) continue;
    const identity = sha256(url).slice(0, 24);
    const duplicate = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, duplicate);
    album.push({ id: `photo:${identity}${duplicate > 1 ? `:${duplicate}` : ''}`, kind: 'photo', url, caption: typeof photo.caption === 'string' ? photo.caption : '' });
  }
  const streetmix = suggestion?.streetmix;
  if (streetmix && typeof streetmix.streetmixId === 'string' && typeof streetmix.streetmixUrl === 'string') {
    const match = /^https:\/\/streetmix\.net\/-\/(\d+)$/.exec(streetmix.streetmixUrl);
    if (match) album.push({
      id: `streetmix:${streetmix.streetmixId}`, kind: 'streetmix', url: `https://streetmix.net/-/${match[1]}`,
      streetmixId: streetmix.streetmixId, thumbnailPath: `/api/public-improvements/presentation/sessions/${sessionId}/ideas/${id}/streetmix-thumbnail`, stale: streetmix.stale === true,
    });
  }
  const raw = {
    id,
    creationDate: typeof suggestion.creationDate === 'string' ? suggestion.creationDate : new Date(0).toISOString(),
    status: typeof suggestion.status === 'string' ? suggestion.status : 'new',
    summary: typeof suggestion.content?.summary === 'string' ? suggestion.content.summary : '',
    details: typeof suggestion.content?.details === 'string' ? suggestion.content.details : '',
    ...(typeof suggestion.author?.name === 'string' && suggestion.author.name.trim() ? { authorName: suggestion.author.name.trim() } : {}),
    descriptionPages: canonicalDescriptionPages(typeof suggestion.content?.details === 'string' ? suggestion.content.details : ''),
    location: {
      latitude: finiteCoordinate(suggestion.location?.latitude, -90, 90) ? suggestion.location.latitude : null,
      longitude: finiteCoordinate(suggestion.location?.longitude, -180, 180) ? suggestion.location.longitude : null,
      address: typeof suggestion.location?.address === 'string' ? suggestion.location.address : '',
      description: typeof suggestion.location?.description === 'string' ? suggestion.location.description : '',
    },
    ...(typeof suggestion.emoji === 'string' && suggestion.emoji ? { emoji: suggestion.emoji } : {}),
    album,
  };
  const contentVersion = sha256(JSON.stringify(raw));
  return { ...raw, contentVersion };
}

export function normalizeCode(value: unknown): string {
  if (typeof value !== 'string') throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Enter a valid joining code.');
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)) throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', 'Enter a valid joining code.');
  return code;
}

export function validateUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new PresentationError(422, 'INVALID_PRESENTATION_REQUEST', `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

const stateKeys = ['selectedIdeaId', 'mode', 'camera', 'mapStyle', 'railVisible', 'theme', 'albumItemId', 'photoFrame', 'captionVisible', 'descriptionPage', 'audienceDisplay', 'iconStyle'];
export function validateWritableState(input: unknown, previousIconStyle?: PresentationIconStyle): Omit<PresentationState, 'revision' | 'ideaEpoch'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'State must be a complete object.');
  const state = input as Record<string, any>;
  if (Object.keys(state).some(key => !stateKeys.includes(key)) || stateKeys.some(key => key !== 'iconStyle' && !(key in state))) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'State must contain only the documented writable fields.');
  const id = state.selectedIdeaId;
  if (id !== null && (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Selected idea ID is invalid.');
  if (!['map', 'photo', 'description'].includes(state.mode)) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Presentation mode is invalid.');
  const camera = state.camera;
  if (!camera || typeof camera !== 'object' || Array.isArray(camera) || Object.keys(camera).sort().join(',') !== 'latitude,longitude,zoom'
      || !finiteCoordinate(camera.latitude, -85.05112878, 85.05112878) || !finiteCoordinate(camera.longitude, -180, 180) || !finiteCoordinate(camera.zoom, 1, 20)) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Map camera values are invalid.');
  if (!['streets', 'satellite'].includes(state.mapStyle) || typeof state.railVisible !== 'boolean' || !['light', 'dark'].includes(state.theme)
      || (state.albumItemId !== null && typeof state.albumItemId !== 'string') || typeof state.captionVisible !== 'boolean'
      || !Number.isSafeInteger(state.descriptionPage) || state.descriptionPage < 0) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Presentation state has an invalid field.');
  const frame = state.photoFrame;
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || Object.keys(frame).sort().join(',') !== 'centerX,centerY,scale'
      || !finiteCoordinate(frame.scale, 1, 4) || !finiteCoordinate(frame.centerX, 0, 1) || !finiteCoordinate(frame.centerY, 0, 1)) throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Photo framing values are invalid.');
  const audienceDisplay = state.audienceDisplay;
  if (!audienceDisplay || typeof audienceDisplay !== 'object' || Array.isArray(audienceDisplay) || Object.keys(audienceDisplay).sort().join(',') !== 'showCode,showQr'
      || typeof audienceDisplay.showQr !== 'boolean' || typeof audienceDisplay.showCode !== 'boolean') throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Audience display settings are invalid.');
  const iconStyle = state.iconStyle ?? previousIconStyle ?? initialPresentationState().iconStyle;
  const legacyIconStyleKeys = 'animationEnabled,bobbingRotation,bobbingSpeed,pulseSize,pulseSpeed,size';
  const iconStyleKeys = 'animationEasing,animationEnabled,bobbingRotation,bobbingSpeed,pulseSize,pulseSpeed,size';
  const normalizedAnimationEasing = iconStyle?.animationEasing ?? 'ease-in-out';
  if (!iconStyle || typeof iconStyle !== 'object' || Array.isArray(iconStyle)
      || ![legacyIconStyleKeys, iconStyleKeys].includes(Object.keys(iconStyle).sort().join(','))
      || !finiteCoordinate(iconStyle.size, 50, 400) || typeof iconStyle.animationEnabled !== 'boolean'
      || !finiteCoordinate(iconStyle.pulseSize, 1, 3) || !finiteCoordinate(iconStyle.pulseSpeed, 0.5, 3)
      || !finiteCoordinate(iconStyle.bobbingRotation, 0, 90) || !finiteCoordinate(iconStyle.bobbingSpeed, 0.5, 3)
      || !['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'].includes(normalizedAnimationEasing)) {
    throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Icon style settings are invalid.');
  }
  if (id === null && state.mode !== 'map') throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'A cleared selection supports map mode only.');
  return structuredClone({ ...state, iconStyle: { ...iconStyle, animationEasing: normalizedAnimationEasing } }) as Omit<PresentationState, 'revision' | 'ideaEpoch'>;
}

export function normalizeStateForIdea(
  requested: Omit<PresentationState, 'revision' | 'ideaEpoch'>,
  current: PresentationState,
  idea: PresentationIdea | null,
): Omit<PresentationState, 'revision' | 'ideaEpoch'> {
  const changedIdea = current.selectedIdeaId !== requested.selectedIdeaId;
  const next = structuredClone(requested);
  if (!idea) {
    if (next.selectedIdeaId !== null) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
    next.mode = 'map'; next.albumItemId = null; next.descriptionPage = 0;
    next.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
    return next;
  }
  if (idea.id !== next.selectedIdeaId) throw new PresentationError(404, 'IDEA_UNAVAILABLE', 'This idea is unavailable.');
  if (changedIdea) {
    next.albumItemId = idea.album[0]?.id ?? null;
    next.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
    next.descriptionPage = 0;
    const { latitude, longitude } = idea.location;
    if (latitude !== null && longitude !== null && latitude >= -85.05112878 && latitude <= 85.05112878) next.camera = { latitude, longitude, zoom: 16 };
    if (idea.album.length === 0) next.mode = 'description';
  }
  next.descriptionPage = Math.min(next.descriptionPage, idea.descriptionPages.length);
  if (next.albumItemId !== null && !idea.album.some(item => item.id === next.albumItemId)) {
    throw new PresentationError(422, 'INVALID_PRESENTATION_STATE', 'Selected album item is unavailable.');
  }
  if (next.albumItemId !== current.albumItemId) next.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
  const selected = idea.album.find(item => item.id === next.albumItemId);
  if (selected?.kind === 'streetmix') next.photoFrame = { scale: 1, centerX: 0.5, centerY: 0.5 };
  return next;
}

export function effectiveCaptionVisible(state: PresentationState, idea: PresentationIdea | null): boolean {
  return state.captionVisible && idea?.album.find(item => item.id === state.albumItemId)?.kind !== 'streetmix';
}
