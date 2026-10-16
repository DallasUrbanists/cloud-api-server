import { createHash } from 'node:crypto';
import { recommendableSources } from '../data/recommendableSources.js';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { BoundaryService } from '../services/boundaryService.js';
import { RecommendableActionService } from '../services/recommendableActionService.js';
import { readOfficialDocument } from '../services/research/official.js';

async function run(): Promise<void> {
  const db = getPublicImprovementsDb();
  const controller = new AbortController();
  let candidates = 0;
  for (const source of recommendableSources) {
    try {
      const page = await readOfficialDocument(source.url, controller.signal);
      const fingerprint = createHash('sha256').update(page.text).digest('hex');
      const stateRef = db.collection('recommendableSources').doc(source.key);
      const state = await stateRef.get();
      if (state.get('fingerprint') === fingerprint) continue;
      const boundaries = await BoundaryService.findAll({ ...source.boundaryQuery, limit: 100 });
      const id = createHash('sha256').update(`${source.key}:${fingerprint}`).digest('hex').slice(0, 40);
      try {
        const proposal = await RecommendableActionService.extractCandidate(source.url, source.description, controller.signal);
        const input = { ...proposal, boundaries: boundaries.map(boundary => boundary.id) };
        await RecommendableActionService.createCandidate(input, id, { sourceKey: source.key, sourceFingerprint: fingerprint });
      } catch (error: any) {
        if (error?.status !== 422) throw error;
        await RecommendableActionService.setCatalogStatus(source.key, 'uncertain');
        await stateRef.set({ sourceUrl: page.url, fingerprint, lastCheckedAt: new Date().toISOString(), opportunityFound: false });
        continue;
      }
      candidates++;
      await stateRef.set({ sourceUrl: page.url, fingerprint, lastCheckedAt: new Date().toISOString(), lastCandidateId: id });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'recommendable_source_scan_failed', sourceKey: source.key, message: error instanceof Error ? error.message : 'unknown error' }));
    }
  }
  console.log(JSON.stringify({ event: 'recommendable_source_scan_complete', sourceCount: recommendableSources.length, candidates }));
}

run().then(() => { process.exitCode = 0; }).catch(error => { console.error('Recommendable source scan failed:', error); process.exitCode = 1; });
