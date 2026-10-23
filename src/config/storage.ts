import { Storage } from '@google-cloud/storage';
import { deploymentConfig } from './deployment.js';

let storageInstance: Storage | null = null;

/**
 * Validates staging settings before returning the singleton Cloud Storage client.
 * Client construction does not verify bucket permissions or readiness.
 */
export function getStorage(): Storage {
  deploymentConfig();
  if (!storageInstance) {
    storageInstance = new Storage({
      projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined,
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    });
  }
  return storageInstance;
}

/**
 * Returns the configured GCS bucket name for suggestion photos.
 */
export function getSuggestionPhotosBucketName(): string {
  return deploymentConfig().bucket;
}
