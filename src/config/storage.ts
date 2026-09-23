import { Storage } from '@google-cloud/storage';

let storageInstance: Storage | null = null;

/**
 * Returns the singleton Google Cloud Storage client.
 */
export function getStorage(): Storage {
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
  return process.env.SUGGESTION_PHOTOS_BUCKET || 'urbanists-suggestion-photos';
}
