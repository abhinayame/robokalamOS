import { Router } from 'express';
import { ok, parse, wrap } from '../../lib/http.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { sampleAudience, selectorSchema, summarizeAudience } from './resolver.js';

const router = Router();
router.use(requireOrg);

/**
 * Batch Selection Engine — preview what a selection means before any action is taken.
 * Returns batch count, raw membership count, UNIQUE learners and how many duplicates were removed.
 */
router.post('/resolve', requirePerm('selection:resolve'), wrap(async (req, res) => {
  const sel = parse(selectorSchema, req.body ?? {});
  const summary = await summarizeAudience(req.user!, orgIdOf(req), sel);
  const sample = await sampleAudience(req.user!, orgIdOf(req), sel);
  ok(res, { ...summary, sample });
}));

export default router;
