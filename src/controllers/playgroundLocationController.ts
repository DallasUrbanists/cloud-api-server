import type { Request, Response, NextFunction } from 'express';

const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

/** Server-side Google Places proxy; credentials never enter the page or response. */
export class PlaygroundLocationController {
  static async search(req: Request, res: Response, next: NextFunction): Promise<void> {
    const disconnect = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnect.abort(); };
    res.on('close', onClose);
    res.set('Cache-Control', 'no-store');
    try {
      const { input, placeId, sessionToken } = req.query;
      if (typeof sessionToken !== 'string' || !/^[a-zA-Z0-9_-]{16,64}$/.test(sessionToken)) throw invalid('Supply a valid autocomplete session token.');
      const details = placeId !== undefined;
      if (details ? typeof placeId !== 'string' || !/^[a-zA-Z0-9_-]{1,300}$/.test(placeId)
        : typeof input !== 'string' || input.trim().length < 3 || input.length > 200) throw invalid('Enter 3–200 address characters or select a valid address suggestion.');
      const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
      if (!apiKey) throw Object.assign(new Error('Address search is not configured. Set GOOGLE_MAPS_API_KEY with Places API (New) enabled, or use coordinates/current location.'), { status: 503 });
      const url = details ? `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId as string)}?sessionToken=${encodeURIComponent(sessionToken)}`
        : 'https://places.googleapis.com/v1/places:autocomplete';
      const response = await fetch(url, {
        method: details ? 'GET' : 'POST', signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(10000)]),
        headers: { 'X-Goog-Api-Key': apiKey, 'Content-Type': 'application/json',
          'X-Goog-FieldMask': details ? 'location,formattedAddress' : 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text' },
        ...(details ? {} : { body: JSON.stringify({ input: (input as string).trim(), sessionToken, languageCode: 'en',
          locationBias: { circle: { center: { latitude: 32.7767, longitude: -96.797 }, radius: 50000 } } }) }),
      });
      if (!response.ok) throw Object.assign(new Error('Google address search is unavailable. Check the server key, Places API (New) access and quota, or use coordinates/current location.'), { status: 503 });
      const data = await response.json() as any;
      if (details) {
        const { latitude, longitude } = data?.location ?? {};
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || typeof data.formattedAddress !== 'string') throw new Error('Invalid address location.');
        res.json({ latitude, longitude, address: data.formattedAddress });
      } else {
        if (data?.suggestions !== undefined && !Array.isArray(data.suggestions)) throw new Error('Invalid address suggestions.');
        res.json({ suggestions: (data?.suggestions ?? []).flatMap((item: any) => {
          const p = item?.placePrediction;
          return typeof p?.placeId === 'string' && typeof p?.text?.text === 'string' ? [{ placeId: p.placeId, text: p.text.text }] : [];
        }).slice(0, 5) });
      }
    } catch (error: any) {
      if (disconnect.signal.aborted) return;
      next(error.status ? error : Object.assign(new Error('Address search could not complete. Retry or use coordinates/current location.'), { status: 503 }));
    } finally { res.off('close', onClose); }
  }
}
