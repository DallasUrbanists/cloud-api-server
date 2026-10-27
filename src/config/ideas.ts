/** Selects the temporary source or destination layout used by the Ideas domain. */
export type IdeasDataLayout = 'legacy' | 'ideas';

/** Resolves the layout and fails closed for deployed services that omit the cutover setting. */
export function getIdeasDataLayout(env: Readonly<Record<string, string | undefined>> = process.env): IdeasDataLayout {
  const value = env.IDEAS_DATA_LAYOUT;
  if (value === 'legacy' || value === 'ideas') return value;
  if (value !== undefined && value !== '') throw new Error('IDEAS_DATA_LAYOUT must be legacy or ideas.');
  if (env.K_SERVICE || env.DEPLOY_ENV || env.NODE_ENV === 'production') {
    throw new Error('IDEAS_DATA_LAYOUT is required in deployed environments.');
  }
  return 'ideas';
}

/** Returns the root collection selected for the active rollout layout. */
export function ideasCollectionName(env: Readonly<Record<string, string | undefined>> = process.env): 'suggestion' | 'idea' {
  return getIdeasDataLayout(env) === 'ideas' ? 'idea' : 'suggestion';
}

/** Returns the sequential counter field paired with the selected collection. */
export function ideasCounterFieldName(env: Readonly<Record<string, string | undefined>> = process.env): 'lastSuggestionId' | 'lastIdeaId' {
  return getIdeasDataLayout(env) === 'ideas' ? 'lastIdeaId' : 'lastSuggestionId';
}

/** Returns the root path for an Idea and its existing action, log, and Streetmix children. */
export function ideaDocumentPath(id: string | number, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return `${ideasCollectionName(env)}/${String(id)}`;
}

/** Indicates the coordinated window in which affected Idea writes and reads are temporarily unavailable. */
export function ideasMaintenanceEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.IDEAS_MAINTENANCE === 'true';
}
