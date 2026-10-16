import { BoundaryError } from '../models/boundary.js';

export async function boundedFetch(url: URL | string, signal: AbortSignal, maximumBytes = 12_000_000, headers?: Record<string, string>, allowRedirect?: (url: URL) => boolean): Promise<{ bytes: Uint8Array; contentType: string; url: string }> {
  let current = new URL(url);
  let response: Response;
  for (let redirects = 0; ; redirects++) {
    response = await fetch(current, { signal, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get('location');
    const next = location ? new URL(location, current) : undefined;
    if (redirects >= 3 || !next || !allowRedirect?.(next)) throw new BoundaryError(502, 'SOURCE_REDIRECT_REJECTED', 'The external source redirected to an unapproved location.');
    current = next;
  }
  if (!response.ok) throw new BoundaryError(502, 'SOURCE_UNAVAILABLE', 'The external data source could not be retrieved.');
  if (Number(response.headers.get('content-length')) > maximumBytes) throw new BoundaryError(502, 'SOURCE_TOO_LARGE', 'External response exceeds the allowed size.');
  const reader = response.body?.getReader();
  if (!reader) throw new BoundaryError(502, 'SOURCE_INVALID', 'External data source returned no content.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximumBytes) throw new BoundaryError(502, 'SOURCE_TOO_LARGE', 'External response exceeds the allowed size.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') ?? '', url: current.toString() };
}
export async function fetchJson(url: URL | string, signal: AbortSignal, headers?: Record<string, string>): Promise<any> {
  const { bytes } = await boundedFetch(url, signal, 20_000_000, headers);
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new BoundaryError(502, 'SOURCE_INVALID', 'External data source returned invalid JSON.'); }
}
