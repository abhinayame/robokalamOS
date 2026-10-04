import { beforeAll, describe, expect, it } from 'vitest';
import { queryOne } from '../src/db/pool.js';
import { buildWorld, newLearner, uniq, type World } from './helpers.js';

let w: World;
beforeAll(async () => { w = await buildWorld(); });

describe('concurrent membership changes', () => {
  it('never oversubscribes a batch when many enrolments race for the last seats', async () => {
    const batch = (await w.admin.post('/api/batches', { name: `Race ${uniq()}`, program_id: w.program, course_id: w.courseRobotics, academic_year: '2026-27', capacity: 3 })).body.data.id;
    const learners = await Promise.all(Array.from({ length: 8 }, () => newLearner(w)));
    const results = await Promise.all(learners.map((l) => w.admin.post(`/api/learners/${l.id}/batches`, { batch_id: batch })));
    const ok = results.filter((r) => r.status === 201).length;
    const full = results.filter((r) => r.status === 409 && r.body.error.code === 'CAPACITY_EXCEEDED').length;
    expect(ok).toBe(3);
    expect(ok + full).toBe(8);
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [batch]))!.n).toBe(3);
  });

  it('the same learner enrolled twice at once still has exactly one membership', async () => {
    const l = await newLearner(w);
    const rs = await Promise.all(Array.from({ length: 5 }, () => w.admin.post(`/api/learners/${l.id}/batches`, { batch_id: w.batches.roboA })));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect((await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE learner_id = $1`, [l.id]))!.n).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('concurrent creates with the same mobile produce one learner, the rest conflict', async () => {
    const m = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => w.admin.post('/api/learners', { full_name: `Racer ${i}`, mobile: m })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    expect(rs.some((r) => r.status >= 500)).toBe(false);
  });
});
