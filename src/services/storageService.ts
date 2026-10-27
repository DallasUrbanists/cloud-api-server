/**
 * Direct-to-Cloud-Storage image upload signing for idea photos.
 * No bytes pass through this service and signing does not verify the future file's contents.
 * @module
 */
import crypto from 'crypto';
import { getStorage, getIdeaPhotosBucketName } from '../config/storage.js';

/** Optional image type/filename hints; the signer selects the bucket and unique path. */
export interface GenerateUploadUrlOptions {
  contentType?: string;
  filename?: string;
}

/** Expiring write capability plus the intended public object address; not proof an upload has completed. */
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
  'image/svg+xml',
];

/**
 * Service for managing file uploads and signed URLs with Google Cloud Storage.
 */
export class StorageService {
  /**
   * Signs an expiring write URL with a unique object path after checking the declared image type.
   * @remarks A provided filename only influences its extension. Public readability depends
   * on bucket policy; this does not upload, inspect, sanitize, or delete image bytes.
   * @example
   * Let's imagine adding a photo of the bus stop to an idea. This gives the
   * browser a temporary delivery address so it can send the picture to storage.
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
      : contentType === 'image/svg+xml'
        ? 'svg'
        : contentType.split('/')[1] || 'webp';

    const uniqueId = crypto.randomUUID();
    const timestamp = Date.now();
    const filePath = `ideas/uploads/${timestamp}-${uniqueId}.${extension}`;

    const bucketName = getIdeaPhotosBucketName();
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
