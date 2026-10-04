import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { exec, query, queryOne } from '../src/db/pool.js';
import { app, buildWorld, client, login, newLearner, PASSWORD, uniq, type World } from './helpers.js';
import { resumeImports } from '../src/modules/import/runner.js';
import { cleanRow, readCsv, parseDate } from '../src/modules/import/validate.js';

let w: World, other: World;
let teacher: ReturnType<typeof client>, branchAdmin: ReturnType<typeof client>, tokenOf: Record<string, string> = {};
const csv = (lines: string[]) => lines.join('\r\n') + '\r\n';
const HEAD = 'full_name,mobile,email,gender,date_of_birth,school,location,enrolled_on,branch,batches,parent_name,parent_mobile,parent_email,relationship';
let tok = '';
const preview = (body: string, who = tok, name = 'kids.csv') => request(app).post(`/api/import/learners/preview?file_name=${name}`).set('Authorization', `Bearer ${who}`).set('Content-Type', 'text/csv').send(body);
const call = (m: 'get' | 'post', url: string, who = tok, body?: object) => { const r = request(app)[m](url).set('Authorization', `Bearer ${who}`); return body ? r.send(body) : r; };
async function finished(id: string, who = tok) {
  for (let i = 0; i < 100; i++) { const j = (await call('get', `/api/import/${id}`, who)).body.data; if (j.status !== 'running') return j; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('import did not finish');
}
const mob = (n: number) => `98${String(70000000 + n)}`;

beforeAll(async () => {
  w = await buildWorld(); other = await buildWorld();
  tok = await login(w.adminEmail);
  teacher = client(await login(w.teachers.t1.email));
  const bu = `bra-${uniq()}@test.dev`; await w.admin.post('/api/users', { full_name: 'Branch Admin', email: bu, password: PASSWORD, roles: [{ role: 'branch_admin', branch_id: w.branchB }] });
  tokenOf.branch = await login(bu);
});

describe('reading and cleaning a file', () => {
  it('understands header aliases, a BOM, quotes and Excel-style dates, and refuses unusable files', () => {
    const f = readCsv('﻿Name,Phone,DOB,Batch,Parent Name,Parent Phone\r\n"Kumar, Aarav",9876543210,21/05/2014,"RK-1|RK-2",Sunil,9876500001\r\n');
    expect(f.rows[0]!.cells).toMatchObject({ full_name: 'Kumar, Aarav', mobile: '9876543210', date_of_birth: '21/05/2014', batches: 'RK-1|RK-2', parent_name: 'Sunil' });
    expect(() => readCsv('mobile\r\n9876543210\r\n')).toThrow(/full_name/);
    expect(() => readCsv('full_name\r\n')).toThrow(/no data rows/);
    expect(() => readCsv('full_name,name\r\nA,B\r\n')).toThrow(/twice/);
    expect(parseDate('31/02/2020')).toBeNull(); expect(parseDate('2020-02-29')).toBe('2020-02-29'); expect(parseDate('5-6-2015')).toBe('2015-06-05');
  });
  it('explains each problem in words', () => {
    const user: any = { access: { orgWide: true, branchIds: [] } };
    const r = cleanRow({ full_name: 'A', mobile: '123', gender: 'x', date_of_birth: '2099-01-01', batches: 'nope' }, { branches: [], batches: [] }, user);
    expect(r.clean).toBeNull(); expect(r.errors.join(' ')).toMatch(/name is required/); expect(r.errors.join(' ')).toMatch(/not a valid 10 digit/); expect(r.errors.join(' ')).toMatch(/future/); expect(r.errors.join(' ')).toMatch(/Unknown batch/);
    expect(cleanRow({ full_name: 'No Contact' }, { branches: [], batches: [] }, user).errors[0]).toMatch(/mobile or an email/);
  });
});

describe('preview writes nothing and tells the truth', () => {
  it('serves a template, rejects non-CSV, and checks every row', async () => {
    const t = await call('get', '/api/import/learners/template.csv'); expect(t.status).toBe(200); expect(t.text).toContain('full_name,mobile');
    expect((await preview('')).status).toBe(400);
    expect((await preview('just text')).status).toBe(400);
    const before = Number((await queryOne(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1`, [w.orgId]))!.n);
    const exists = await newLearner(w, { full_name: 'Existing Esha', mobile: '9870000099' });
    const r = await preview(csv([HEAD,
      `Good One,${mob(1)},good1@kids.test,female,2014-05-21,DAV,Chennai,2026-06-01,CHN,Robotics Batch A|Python Batch B,Parent One,${mob(901)},p1@fam.test,mother`,
      `Good Two,${mob(2)},,male,,,,,,Robotics Batch A,Parent One,${mob(901)},,father`,         // sibling: same parent mobile
      `,${mob(3)},,,,,,,,,,,,`,                                                                  // no name
      `=Bad Mobile,12345,,,,,,,,,,,,`,
      `Bad Batch,${mob(4)},,,,,,,,No Such Batch,,,,`,
      `Bad Branch,${mob(5)},,,,,,,Mars,,,,,`,
      `No Contact,,,,,,,,,,,,,`,
      `Dup In File,${mob(1)},,,,,,,,,,,,`,
      `Existing Again,9870000099,,,,,,,,Python Batch B,,,,`,
      `Formula Guy,${mob(6)},,,,,,,,,=cmd|' /C calc'!A0,${mob(902)},,`,
    ]));
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d.total_rows).toBe(10);
    expect(d.counts).toMatchObject({ valid: 3, error: 5, duplicate: 2 });
    expect(d.existing_duplicates).toBe(1);
    const msgs = d.problems.map((p: any) => `${p.row_no}:${p.message}`).join('\n');
    expect(msgs).toContain('4:Learner name is required'); expect(msgs).toContain('Unknown batch "No Such Batch"'); expect(msgs).toContain('Unknown branch "Mars"'); expect(msgs).toContain('Same mobile as row 2'); expect(msgs).toContain('Already in the system: Existing Esha');
    expect(Number((await queryOne(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1`, [w.orgId]))!.n)).toBe(before + 1);       // only `exists`, which the test itself made
    void exists;
    const prob = await call('get', `/api/import/${d.id}/problems.csv`);
    expect(prob.status).toBe(200); expect(prob.text).toContain('problem'); expect(prob.text).toContain(`'=Bad Mobile`);                        // spreadsheet formulas are defused
  });
  it('refuses oversized files, and keeps jobs private to their owner and organization', async () => {
    const big = csv([HEAD, ...Array.from({ length: 5001 }, (_, i) => `K${i} Kid,${mob(10000 + i)}`)]);
    const r = await preview(big); expect(r.status).toBe(400); expect(r.body.error.message).toContain('at most 5,000');
    const ok1 = await preview(csv([HEAD, `Private Kid,${mob(50)}`])); const id = ok1.body.data.id;
    expect((await call('get', `/api/import/${id}`, await login(other.adminEmail))).status).toBe(404);
    expect((await call('get', `/api/import/${id}`, tokenOf.branch)).status).toBe(404);
    expect((await call('get', `/api/import/${id}/problems.csv`, await login(other.adminEmail))).status).toBe(404);
    expect((await teacher.get('/api/import/learners/template.csv')).status).toBe(403);
    const cancel = await call('post', `/api/import/${id}/cancel`); expect(cancel.body.data.discarded).toBe(true);
    expect((await call('get', `/api/import/${id}`)).status).toBe(404);
  });
});

describe('confirming and importing', () => {
  it('needs an explicit confirmation with the reviewed number, then creates learners, shares a parent between siblings, joins batches and audits', async () => {
    const p = await preview(csv([HEAD,
      `Imp Aarav,${mob(21)},aarav21@kids.test,male,2014-05-21,DAV,Chennai,,CHN,Robotics Batch A|Python Batch B,Priya Parent,${mob(920)},priya@fam.test,mother`,
      `Imp Diya,${mob(22)},,female,12/09/2015,,,,,Robotics Batch A,Priya Parent,${mob(920)},,mother`,
      `Imp Kabir,,kabir@kids.test,,,,,,,,,,,`,
    ]));
    const id = p.body.data.id; expect(p.body.data.counts.valid).toBe(3);
    expect((await call('post', `/api/import/${id}/confirm`, tok, { expected_valid: 3 })).status).toBe(400);                              // no confirm flag
    const wrong = await call('post', `/api/import/${id}/confirm`, tok, { confirm: true, expected_valid: 99 }); expect(wrong.status).toBe(409); expect(wrong.body.error.code).toBe('PREVIEW_CHANGED');
    const go = await call('post', `/api/import/${id}/confirm`, tok, { confirm: true, expected_valid: 3 });
    expect(go.status).toBe(202);
    expect((await call('post', `/api/import/${id}/confirm`, tok, { confirm: true, expected_valid: 3 })).status).toBe(409);               // not twice
    const j = await finished(id);
    expect(j.status).toBe('completed'); expect(j.counts).toMatchObject({ created: 3, failed: 0 }); expect(j.progress_pct).toBe(100);
    const made = await query(`SELECT id, learner_code, full_name, date_of_birth, enrolled_on FROM learners WHERE org_id = $1 AND full_name LIKE 'Imp %' ORDER BY full_name`, [w.orgId]);
    expect(made).toHaveLength(3); expect(made[0]!.learner_code).toMatch(/-LRN-\d{6}$/);
    expect(String(made[1]!.date_of_birth).slice(0, 10)).toBe('2015-09-12');                                                                // 12/09/2015 read as day/month/year
    const parents = await query(`SELECT DISTINCT lp.parent_id FROM learner_parents lp WHERE lp.learner_id IN ($1,$2)`, [made[0]!.id, made[1]!.id]);
    expect(parents).toHaveLength(1);                                                                                                      // ONE parent record for both siblings
    const aarav = (await w.admin.get(`/api/learners/${made[0]!.id}`)).body.data;
    expect(aarav.memberships.filter((m: any) => m.membership_status === 'active')).toHaveLength(2);
    expect((await query(`SELECT COUNT(*) AS n FROM learner_activity WHERE learner_id = $1 AND type = 'learner.imported'`, [made[0]!.id]))[0].n).toBe(1);
    const a = (await query(`SELECT DISTINCT action FROM audit_logs WHERE org_id = $1`, [w.orgId])).map((r) => r.action);
    expect(a).toEqual(expect.arrayContaining(['import.started', 'import.completed', 'learner.created']));
    // uploading the same file again finds only duplicates and refuses to import nothing
    const again = await preview(csv([HEAD, `Imp Aarav,${mob(21)},,,,,,,,,,,,`]));
    expect(again.body.data.counts).toMatchObject({ valid: 0, duplicate: 1 });
    expect((await call('post', `/api/import/${again.body.data.id}/confirm`, tok, { confirm: true, expected_valid: 0 })).status).toBe(400);
  });
  it('skips existing learners by default and, when asked, only adds what is missing without overwriting their profile', async () => {
    const e1 = await newLearner(w, { full_name: 'Merge Me', mobile: mob(31), school: 'Original School' });
    const e2 = await newLearner(w, { full_name: 'Skip Me', mobile: mob(32) });
    const file = csv([HEAD, `Merge Renamed,${mob(31)},,,,Changed School,,,,Python Batch B,Fresh Parent,${mob(930)},,father`, `Skip Me Too,${mob(32)},,,,,,,,Python Batch B,,,,`, `Brand New,${mob(33)}`]);
    const p1 = await preview(file); expect(p1.body.data.counts).toMatchObject({ valid: 1, duplicate: 2 });
    await call('post', `/api/import/${p1.body.data.id}/confirm`, tok, { confirm: true, expected_valid: 1 });                              // default: skip
    const j1 = await finished(p1.body.data.id); expect(j1.counts).toMatchObject({ created: 1, skipped: 2, merged: 0 });
    expect((await w.admin.get(`/api/learners/${e1.id}`)).body.data.memberships).toHaveLength(0);
    const p2 = await preview(file);                                                                                                       // Brand New now exists too
    expect(p2.body.data.counts).toMatchObject({ valid: 0, duplicate: 3 });
    const go = await call('post', `/api/import/${p2.body.data.id}/confirm`, tok, { confirm: true, on_duplicate: 'merge', expected_valid: 0 });
    expect(go.status).toBe(202);
    const j2 = await finished(p2.body.data.id); expect(j2.counts).toMatchObject({ merged: 2, skipped: 1, failed: 0 });
    const m = (await w.admin.get(`/api/learners/${e1.id}`)).body.data;
    expect(m.full_name).toBe('Merge Me'); expect(m.school).toBe('Original School');                                                      // profile untouched
    expect(m.memberships.some((x: any) => x.batch_id === w.batches.pyB && x.membership_status === 'active')).toBe(true); expect(m.parents).toHaveLength(1);
    void e2;
  });
  it('lets a row fail alone when its batch is full, and says why', async () => {
    const small = await w.admin.post('/api/batches', { name: 'Tiny Batch', program_id: w.program, course_id: w.courseRobotics, branch_id: w.branchA, academic_year: '2026-27', status: 'active', capacity: 1 });
    expect(small.status).toBe(201);
    const p = await preview(csv([HEAD, `Cap One,${mob(41)},,,,,,,,Tiny Batch`, `Cap Two,${mob(42)},,,,,,,,Tiny Batch`, `Cap Free,${mob(43)}`]));
    expect(p.body.data.warnings.join(' ')).toContain('1 seat(s) left');
    await call('post', `/api/import/${p.body.data.id}/confirm`, tok, { confirm: true, expected_valid: 3 });
    const j = await finished(p.body.data.id); expect(j.counts).toMatchObject({ created: 2, failed: 1 });
    const failed = (await call('get', `/api/import/${p.body.data.id}/rows?status=failed`)).body.data[0];
    expect(failed.message).toMatch(/seat/i);
    expect((await queryOne(`SELECT COUNT(*) AS n FROM learners WHERE org_id = $1 AND full_name = 'Cap Two'`, [w.orgId]))!.n).toBe(0);      // rolled back, no half-created learner
  });
  it('holds a branch admin to their own branch', async () => {
    const p = await preview(csv([HEAD, `Branch Ok,${mob(61)},,,,,,,BLR,Python Batch B`, `Branch Bad,${mob(62)},,,,,,,CHN,Robotics Batch A`, `Branch Bad Batch,${mob(63)},,,,,,,,Robotics Batch A`]), tokenOf.branch);
    expect(p.body.data.counts).toMatchObject({ valid: 1, error: 2 });
    await call('post', `/api/import/${p.body.data.id}/confirm`, tokenOf.branch, { confirm: true, expected_valid: 1 });
    const j = await finished(p.body.data.id, tokenOf.branch); expect(j.counts.created).toBe(1);
    const l = await queryOne(`SELECT branch_id FROM learners WHERE org_id = $1 AND full_name = 'Branch Ok'`, [w.orgId]); expect(l!.branch_id).toBe(w.branchB);
  });
  it('can be cancelled while running and picks up where it stopped after a restart', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Resume ${i},${mob(300 + i)}`);
    const p = await preview(csv([HEAD, ...lines])); const id = p.body.data.id;
    // simulate a crash mid-way: job marked running, a few rows already created, one stuck "processing"
    const actor = { id: (await queryOne(`SELECT id FROM users WHERE email = $1`, [w.adminEmail]))!.id, email: w.adminEmail, fullName: 'Org Admin', orgWide: true, branchIds: [], isSuperAdmin: false };
    await exec(`UPDATE import_jobs SET status = 'running', confirmed_at = NOW(3), options = $2 WHERE id = $1`, [id, JSON.stringify({ on_duplicate: 'skip', actor })]);
    await exec(`UPDATE import_rows SET status = 'processing', claim_token = 'dead' WHERE job_id = $1 AND row_no <= 5`, [id]);
    await resumeImports();
    const j = await finished(id); expect(j.status).toBe('completed');
    expect(j.counts).toMatchObject({ created: 40, failed: 0 });
    const q = await preview(csv([HEAD, `Cancel A,${mob(200)}`, `Cancel B,${mob(201)}`])); 
    await exec(`UPDATE import_jobs SET status = 'running', options = $2 WHERE id = $1`, [q.body.data.id, JSON.stringify({ on_duplicate: 'skip', actor })]);
    const c = await call('post', `/api/import/${q.body.data.id}/cancel`); expect(c.status).toBe(200);
    const jc = (await call('get', `/api/import/${q.body.data.id}`)).body.data; expect(jc.status).toBe('cancelled'); expect(jc.counts.skipped).toBe(2);
  });
});
