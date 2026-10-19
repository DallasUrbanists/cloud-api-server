/** Read-only Streetmix PNG relay. Streetmix disallows cross-origin hotlinking. */
import { StreetmixError } from '../models/streetmix.js';

const limit = 5 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export async function readStreetmixThumbnail(id: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Buffer> {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new StreetmixError(404, 'THUMBNAIL_UNAVAILABLE', 'Preview unavailable.');
  try {
    const response = await fetcher(`https://streetmix.net/api/v1/streets/${id}/image`, {
      headers: { Accept: 'image/png' }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if ([204, 404].includes(response.status)) throw new StreetmixError(404, 'THUMBNAIL_UNAVAILABLE', 'Preview unavailable.');
    if (!response.ok || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/png' || !response.body) throw new Error('Invalid thumbnail response');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) throw new Error('Thumbnail too large');
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const image = Buffer.concat(chunks);
    if (!image.subarray(0, 8).equals(pngSignature)) throw new Error('Invalid PNG');
    return image;
  } catch (error) {
    if (error instanceof StreetmixError) throw error;
    throw new StreetmixError(503, 'THUMBNAIL_UNAVAILABLE', 'Preview unavailable.');
  }
}
