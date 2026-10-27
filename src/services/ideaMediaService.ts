/** Canonicalizes verified legacy photo references after the Ideas media cutover. */
import { createHash } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
import { deploymentConfig, STAGING } from '../config/deployment.js';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { getIdeasDataLayout } from '../config/ideas.js';

const manifestPath = (sourceBucket: string, object: string) =>
  `_metadata/ideaMediaManifest/records/${createHash('sha256').update(`${sourceBucket}/${object}`).digest('hex')}`;

/** Rewrites only old owned-media URLs present in the migration's verified manifest. */
export async function canonicalizeIdeaPhotoUrl(value: string, db: Firestore = getPublicImprovementsDb()): Promise<string> {
  if (getIdeasDataLayout() !== 'ideas') return value;
  let url: URL;
  try { url = new URL(value); } catch { return value; }
  if (url.protocol !== 'https:' || url.username || url.password) return value;
  const config = deploymentConfig();
  const sourceBucket = config.staging ? STAGING.bucket : 'urbanists-suggestion-photos';
  let bucket: string, object: string;
  if (url.hostname === 'storage.googleapis.com' || url.hostname === 'storage.cloud.google.com') {
    const slash = url.pathname.indexOf('/', 1);
    if (slash < 0) return value;
    bucket = decodeURIComponent(url.pathname.slice(1, slash));
    object = decodeURIComponent(url.pathname.slice(slash + 1));
  } else if (url.hostname === `${sourceBucket}.storage.googleapis.com`) {
    bucket = sourceBucket; object = decodeURIComponent(url.pathname.slice(1));
  } else return value;
  if (bucket !== sourceBucket || !object.startsWith('suggestions/')) return value;
  const snapshot = await db.doc(manifestPath(sourceBucket, object)).get();
  const entry = snapshot.data();
  if (!entry || entry.sourceBucket !== sourceBucket || entry.sourceObject !== object || entry.destinationBucket !== config.bucket) return value;
  const canonical = new URL(String(entry.destinationUrl));
  canonical.search = url.search;
  canonical.hash = url.hash;
  return canonical.toString();
}

/** Preserves photo metadata while canonicalizing each verified URL before new writes. */
export async function canonicalizeIdeaPhotos<T extends { url: string }>(photos: T[] | undefined, db: Firestore = getPublicImprovementsDb()): Promise<T[] | undefined> {
  if (!photos?.length || getIdeasDataLayout() !== 'ideas') return photos;
  return Promise.all(photos.map(async photo => {
    const url = await canonicalizeIdeaPhotoUrl(photo.url, db);
    return url === photo.url ? photo : { ...photo, url };
  }));
}
