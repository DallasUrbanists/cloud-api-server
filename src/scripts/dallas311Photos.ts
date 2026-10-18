/** Uses captured source-record images without inventing or retrieving additional URLs. */
import { validateRecommendablePhotos } from '../models/recommendableAction.js';

export function captured311Photos(files: Iterable<string>, records: Record<string, { photoUrls?: unknown }>): string[] {
  const photos: string[] = [];
  for (const file of new Set(files)) {
    const record = records[file];
    if (!record) throw new Error(`Missing saved 311 photo source: ${file}`);
    const result = validateRecommendablePhotos(record.photoUrls);
    if (result.error) throw new Error(`${file}: ${result.error}`);
    photos.push(...result.photos!);
  }
  return [...new Set(photos)];
}
