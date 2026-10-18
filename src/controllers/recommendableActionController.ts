/**
 * HTTP orchestration for candidate extraction, staff review, and catalog reads/updates.
 *
 * @remarks
 * Routes apply access policies; services own source retrieval and persistence.
 * Request/response contracts are maintained in OpenAPI rather than repeated here.
 *
 * @see [HTTP contracts](../docs/swagger.ts)
 * @module
 */
import type { Request, Response, NextFunction } from 'express';
import { validateRecommendableInput, validateRecommendablePhotos } from '../models/recommendableAction.js';
import { RecommendableActionService } from '../services/recommendableActionService.js';
import { validateMatchInput } from '../models/recommendableMatch.js';

/** Adapts Express requests to the reusable-action workflow without owning access policy. */
export class RecommendableActionController {
  /** Match free text without writing suggestions or recommended actions. */
  static async match(req: Request, res: Response, next: NextFunction): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Unsupported Media Type', message: 'Send an application/json request body.' });
      return;
    }
    const validation = validateMatchInput(req.body);
    if (!validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    try { res.json(await RecommendableActionService.findMatches(validation.data, abort.signal)); }
    catch (error) { if (!abort.signal.aborted) next(error); }
    finally { res.removeListener('close', onClose); }
  }

  /**
   * Extracts source-backed content, validates it with submitted boundaries, and queues review.
   *
   * @remarks
   * A response closing before completion aborts extraction. The listener is removed
   * on every exit; extraction failures are translated here rather than passed to next.
   * A candidate is persisted only after model validation succeeds.
   */
  static async submit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const sourceUrl = req.body?.sourceUrl;
    const description = req.body?.description;
    const photos = validateRecommendablePhotos(req.body?.photos);
    if (photos.error) { res.status(400).json({ error: 'Bad Request', message: photos.error }); return; }
    if (typeof sourceUrl !== 'string' || typeof description !== 'string' || !description.trim() || description.length > 5000
      || (req.body.boundaries !== undefined && !Array.isArray(req.body.boundaries))) {
      res.status(400).json({ error: 'Bad Request', message: 'sourceUrl and a non-empty description (up to 5000 characters) are required; boundaries may be supplied as an array of IDs.' });
      return;
    }
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    try {
      const proposal = await RecommendableActionService.extractCandidate(sourceUrl, description.trim(), abort.signal);
      const validation = validateRecommendableInput({ ...proposal, photos: photos.photos!, boundaries: req.body.boundaries ?? [] });
      if (!validation.data) { res.status(502).json({ error: 'Extraction output invalid', message: validation.error }); return; }
      const data = await RecommendableActionService.createCandidate(validation.data);
      if (!res.destroyed) res.status(201).json({ message: 'Recommendable Action candidate submitted for review.', data });
    } catch (error: any) {
      if (!res.destroyed) res.status(error?.status ?? 502).json({ error: error?.status === 400 ? 'Bad Request' : 'Extraction Failed', message: error?.message ?? 'Recommendable Action extraction failed.' });
    } finally { res.off('close', onClose); }
  }

  /** Returns the review collection with its result count; forwards read failures to Express. */
  static async candidates(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try { const data = await RecommendableActionService.listCandidates(); res.json({ data, count: data.length }); }
    catch (error) { next(error); }
  }

  /** Returns approved catalog entries, excluding closed and uncertain entries from this view. */
  static async approved(req: Request, res: Response, next: NextFunction): Promise<void> {
    const search = req.query.search;
    if (search !== undefined && typeof search !== 'string') {
      res.status(400).json({ error: 'Bad Request', message: 'search must be a string.' }); return;
    }
    try { const data = await RecommendableActionService.listApproved(search as string | undefined); res.json({ data, count: data.length }); }
    catch (error) { next(error); }
  }

  /** Returns one approved catalog entry; hidden catalog states share the not-found response. */
  static async getApproved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await RecommendableActionService.getApproved(String(req.params.id));
      if (!data) { res.status(404).json({ error: 'Not Found', message: 'Recommendable Action not found.' }); return; }
      res.json({ data });
    } catch (error) { next(error); }
  }

  /**
   * Validates the review decision and delegates rejection or versioned publication.
   * Missing candidates are handled locally; service failures go to Express error handling.
   */
  static async review(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.body?.decision !== 'approve' && req.body?.decision !== 'reject') {
      res.status(400).json({ error: 'Bad Request', message: 'decision must be approve or reject.' }); return;
    }
    try {
      const data = await RecommendableActionService.reviewCandidate(String(req.params.id), req.body.decision);
      if (!data) { res.status(404).json({ error: 'Not Found', message: 'Recommendable Action candidate not found.' }); return; }
      res.json({ data });
    } catch (error) { next(error); }
  }

  /** Validates a catalog state change and requests a versioned update, handling a missing entry. */
  static async updateStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    const status = req.body?.status;
    if (!['approved', 'closed', 'uncertain'].includes(status)) {
      res.status(400).json({ error: 'Bad Request', message: 'status must be approved, closed, or uncertain.' }); return;
    }
    try {
      const data = await RecommendableActionService.setCatalogStatus(String(req.params.id), status);
      if (!data) { res.status(404).json({ error: 'Not Found', message: 'Recommendable Action not found.' }); return; }
      res.json({ data });
    } catch (error) { next(error); }
  }
}
