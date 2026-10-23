/**
 * Deployment identity and staging isolation checks without network or filesystem I/O.
 * Client factories call this before allocating resources, including during ESM import.
 * @module
 */
export const STAGING = {
  project: 'urbanists-mixer-slides-helper',
  service: 'urbanists-cloud-api-staging',
  region: 'us-central1',
  database: 'public-improvements-staging',
  bucket: 'urbanists-suggestion-photos-staging-143738155808',
  sqlDatabase: 'urbanists_staging',
  sqlUser: 'urbanists_staging',
  instance: 'urbanists-mixer-slides-helper:us-south1:contacts-relationships-db',
  origin: 'https://map-staging-143738155808.web.app',
} as const;

export type DeploymentEnv = Readonly<Record<string, string | undefined>>;

/** Detects staging by either declared environment or the reserved Cloud Run service. */
export function isStaging(env: DeploymentEnv = process.env): boolean {
  return env.DEPLOY_ENV === 'staging' || env.K_SERVICE === STAGING.service;
}

/**
 * Parses effective identifiers and rejects unsafe staging settings. Errors name only
 * variables, never their values. Non-staging deployments retain their existing defaults.
 * @throws When staging is incomplete, misidentified, or targets another environment.
 */
export function deploymentConfig(env: DeploymentEnv = process.env) {
  const staging = isStaging(env);
  if (staging) {
    const required = {
      DEPLOY_ENV: 'staging', NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: STAGING.project,
      PUBLIC_IMPROVEMENTS_DB: STAGING.database, ASSIST_QUOTA_DB: STAGING.database,
      SUGGESTION_PHOTOS_BUCKET: STAGING.bucket, DB_NAME: STAGING.sqlDatabase,
      DB_USER: STAGING.sqlUser, INSTANCE_CONNECTION_NAME: STAGING.instance,
      ALLOWED_ORIGINS: STAGING.origin,
    };
    for (const [name, expected] of Object.entries(required)) {
      if (env[name] !== expected) throw new Error(`Unsafe staging configuration: ${name}`);
    }
    if (env.K_SERVICE && env.K_SERVICE !== STAGING.service) throw new Error('Unsafe staging configuration: K_SERVICE');
    if (!/^[a-f0-9]{40}$/.test(env.BUILD_COMMIT ?? '')) throw new Error('Unsafe staging configuration: BUILD_COMMIT');
    if (!env.DB_PASSWORD?.trim()) throw new Error('Unsafe staging configuration: DB_PASSWORD');
    let keys: unknown;
    try { keys = JSON.parse(env.API_KEYS_JSON ?? ''); } catch { /* report only the variable */ }
    if (!Array.isArray(keys) || keys.length === 0 || keys.some(key => !key || typeof key.key !== 'string' || !key.key.trim())) {
      throw new Error('Unsafe staging configuration: API_KEYS_JSON');
    }
    for (const flag of ['BOUNDARY_SYNC_ENABLED', 'STREETMIX_ENABLED', 'PRESENTATION_ENABLED', 'PRESENTATION_WEBSOCKET_ENABLED']) {
      if (!['true', 'false'].includes(env[flag] ?? '')) throw new Error(`Unsafe staging configuration: ${flag}`);
    }
    if (env.PRESENTATION_WEBSOCKET_ENABLED === 'true' && env.PRESENTATION_ENABLED !== 'true') {
      throw new Error('Unsafe staging configuration: PRESENTATION_WEBSOCKET_ENABLED');
    }
    // A deployed staging service must use its attached identity, not a credential file or emulator.
    if (env.K_SERVICE && ['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'].some(key => env[key])) {
      throw new Error('Unsafe staging configuration: credential or emulator override');
    }
  }
  return {
    staging,
    environment: env.DEPLOY_ENV || env.NODE_ENV || 'unknown',
    database: env.PUBLIC_IMPROVEMENTS_DB || 'public-improvements',
    bucket: env.SUGGESTION_PHOTOS_BUCKET || 'urbanists-suggestion-photos',
    buildCommit: env.BUILD_COMMIT || null,
    ...(env.K_REVISION ? { revision: env.K_REVISION } : {}),
  };
}

/** Validates explicit auxiliary store overrides before constructing a Firestore client. */
export function firestoreDatabase(databaseId?: string, env: DeploymentEnv = process.env): string {
  const config = deploymentConfig(env);
  const target = databaseId || config.database;
  if (config.staging && target !== STAGING.database) throw new Error('Unsafe staging Firestore database override');
  return target;
}
