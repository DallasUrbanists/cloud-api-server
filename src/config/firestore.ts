import { Firestore } from '@google-cloud/firestore';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Registry/Cache for multiple Firestore database instances.
 * Enables scaling to multiple Firestore databases across services.
 */
const firestoreClients: Map<string, Firestore> = new Map();

/**
 * Returns or initializes a Firestore instance for a given database ID.
 * @param databaseId Name/ID of the Firestore database (e.g. 'public-improvements').
 *                   Defaults to process.env.PUBLIC_IMPROVEMENTS_DB or 'public-improvements'.
 */
export function getFirestoreDb(databaseId?: string): Firestore {
  const targetDb = databaseId || process.env.PUBLIC_IMPROVEMENTS_DB || 'public-improvements';

  if (!firestoreClients.has(targetDb)) {
    const options: ConstructorParameters<typeof Firestore>[0] = {
      databaseId: targetDb,
    };

    if (process.env.GOOGLE_CLOUD_PROJECT) {
      options.projectId = process.env.GOOGLE_CLOUD_PROJECT;
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      options.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    }

    const firestore = new Firestore(options);
    firestoreClients.set(targetDb, firestore);
  }

  return firestoreClients.get(targetDb)!;
}

/**
 * Convenience getter for the primary 'public-improvements' database.
 */
export function getPublicImprovementsDb(): Firestore {
  return getFirestoreDb(process.env.PUBLIC_IMPROVEMENTS_DB || 'public-improvements');
}
