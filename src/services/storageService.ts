import crypto from 'crypto';
import { getStorage, getSuggestionPhotosBucketName } from '../config/storage.js';

export interface GenerateUploadUrlOptions {
  contentType?: string;
  filename?: string;
}

export interface UploadUrlResult {
  uploadUrl: string;
  publicUrl: string;
  filePath: string;
  expiresAt: string;
}

const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

/**
 * Service for managing file uploads and signed URLs with Google Cloud Storage.
 */
export class StorageService {
  /**
   * Generates a V4 signed PUT URL for uploading an image directly to GCS.
   */
  static async generateUploadUrl(options: GenerateUploadUrlOptions = {}): Promise<UploadUrlResult> {
    const contentType = (options.contentType || 'image/webp').toLowerCase().trim();

    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(
        `Invalid content type "${contentType}". Allowed types: ${ALLOWED_CONTENT_TYPES.join(', ')}`
      );
    }

    const extension = options.filename && options.filename.includes('.')
      ? options.filename.split('.').pop()!.toLowerCase()
      : contentType.split('/')[1] || 'webp';

    const uniqueId = crypto.randomUUID();
    const timestamp = Date.now();
    const filePath = `suggestions/uploads/${timestamp}-${uniqueId}.${extension}`;

    const bucketName = getSuggestionPhotosBucketName();
    const storage = getStorage();
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(filePath);

    // 15-minute expiration
    const expiresMs = Date.now() + 15 * 60 * 1000;
    const expiresAt = new Date(expiresMs).toISOString();

    const [uploadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresMs,
      contentType,
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

    return {
      uploadUrl,
      publicUrl,
      filePath,
      expiresAt,
    };
  }
}
