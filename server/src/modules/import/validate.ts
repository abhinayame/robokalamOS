import { parse as parseCsv } from 'csv-parse/sync';
import { normalizeMobile } from '../../lib/phone.js';
import { canWriteBranch } from '../../lib/scope.js';
import type { AuthUser } from '../../middleware/auth.js';

export const MAX_ROWS = 5000;

/** Header spellings accepted for each column (compared lowercase, spaces/underscores ignored). */
const ALIASES: Record<string, string[]> = {
  full_name: ['fullname', 'name', 'learnername', 'studentname', 'student'],
  mobile: ['mobile', 'phone', 'mobilenumber', 'learnermobile', 'contact'],
  email: ['email', 'emailid', 'learneremail'],
  gender: ['gender', 'sex'],
  date_of_birth: ['dateofbirth', 'dob', 'birthdate'],
  school: ['school', 'schoolname'],
  location: ['location', 'city', 'area'],
  enrolled_on: ['enrolledon', 'joiningdate', 'joindate', 'admissiondate'],
  branch: ['branch', 'branchname', 'branchcode', 'centre', 'center'],
  batches: ['batches', 'batch', 'batchcode', 'batchname', 'batchcodes'],
  parent_name: ['parentname', 'guardianname', 'fathername', 'mothername'],
  parent_mobile: ['parentmobile', 'parentphone', 'guardianmobile', 'guardianphone'],
  parent_email: ['parentemail', 'guardianemail'],
  relationship: ['relationship', 'relation'],
};
export const COLUMNS = Object.keys(ALIASES);
const squash = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export const TEMPLATE_CSV = [
  'full_name,mobile,email,gender,date_of_birth,school,location,enrolled_on,branch,batches,parent_name,parent_mobile,parent_email,relationship',
  'Aarav Kumar,9876543210,aarav@example.com,male,2014-05-21,DAV School,Chennai,2026-06-01,CHN,RK-BAT-0001|RK-BAT-0002,Sunil Kumar,9876500001,sunil@example.com,father',
  'Diya Iyer,,diya@example.com,female,12/09/2015,PSBB,Chennai,,,Robotics Batch A,Lakshmi Iyer,9876500002,,mother',
].join('\r\n') + '\r\n';

export interface ParsedFile { rows: { rowNo: number; cells: Record<string, string> }[]; unknownHeaders: string[] }

/** CSV text -> rows keyed by our column names. Throws a plain-English Error for an unusable file. */
export function readCsv(text: string): ParsedFile {
  let table: string[][];
  try { table = parseCsv(text, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true, relax_quotes: true }) as string[][]; }
  catch (e: any) { throw new Error(`That file could not be read as CSV (${String(e?.message ?? e).slice(0, 120)}). Save it as "CSV UTF-8" and try again.`); }
  if (table.length < 2) throw new Error('The file has no data rows. Use the template: one header row, then one learner per row.');
  const header = table[0]!.map(squash); const map = new Map<number, string>(); const seen = new Set<string>(); const unknown: string[] = [];
  header.forEach((h, i) => {
    const col = COLUMNS.find((c) => squash(c) === h || ALIASES[c]!.includes(h));
    if (!col) { if (h) unknown.push(table[0]![i]!); return; }
    if (seen.has(col)) throw new Error(`The column "${col}" appears twice in the header row.`);
    seen.add(col); map.set(i, col);
  });
  if (!seen.has('full_name')) throw new Error('The header row needs a "full_name" column. Download the template to see the expected columns.');
  if (table.length - 1 > MAX_ROWS) throw new Error(`The file has ${(table.length - 1).toLocaleString('en-IN')} rows. Import at most ${MAX_ROWS.toLocaleString('en-IN')} at a time.`);
  const rows = table.slice(1).map((r, k) => {
    const cells: Record<string, string> = {};
    for (const [i, col] of map) cells[col] = (r[i] ?? '').trim().slice(0, 300);
    return { rowNo: k + 2, cells };
  }).filter((r) => Object.values(r.cells).some((v) => v !== ''));
  return { rows, unknownHeaders: unknown };
}

export interface Lookups {
  branches: { id: string; name: string; code: string }[];
  batches: { id: string; name: string; batch_code: string; status: string; branch_id: string | null }[];
}
export interface Clean {
  full_name: string; mobile: string | null; email: string | null; gender: string | null; date_of_birth: string | null; school: string | null; location: string | null;
  enrolled_on: string | null; branch_id: string | null; batch_ids: string[]; batch_labels: string[];
  parent: { full_name: string; mobile: string | null; email: string | null; relationship: string } | null;
}

const GENDERS: Record<string, string> = { f: 'female', female: 'female', girl: 'female', m: 'male', male: 'male', boy: 'male', o: 'other', other: 'other', na: 'undisclosed', undisclosed: 'undisclosed' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY -> YYYY-MM-DD (null if not a real date). */
export function parseDate(s: string): string | null {
  let y: number, m: number, d: number; let x: RegExpMatchArray | null;
  if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +x[1]!; m = +x[2]!; d = +x[3]!; }
  else if ((x = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) { d = +x[1]!; m = +x[2]!; y = +x[3]!; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Check and clean one row. `errors` are fixable problems; the row is only importable when there are none. */
export function cleanRow(cells: Record<string, string>, lk: Lookups, user: AuthUser): { clean: Clean | null; errors: string[] } {
  const errors: string[] = []; const c = (k: string) => (cells[k] ?? '').trim();
  const name = c('full_name').replace(/\s+/g, ' ');
  if (name.length < 2) errors.push('Learner name is required (at least 2 letters).'); else if (name.length > 120) errors.push('Learner name is longer than 120 characters.');
  let mobile: string | null = null;
  if (c('mobile')) { mobile = normalizeMobile(c('mobile')); if (!mobile) errors.push(`Mobile "${c('mobile')}" is not a valid 10 digit Indian number (if Excel turned it into 9.8E+9, format the column as text).`); }
  const email = c('email').toLowerCase() || null; if (email && !EMAIL.test(email)) errors.push(`Email "${c('email')}" is not valid.`);
  let gender: string | null = null; if (c('gender')) { gender = GENDERS[c('gender').toLowerCase()] ?? null; if (!gender) errors.push(`Gender "${c('gender')}" should be female, male, other or blank.`); }
  let dob: string | null = null; if (c('date_of_birth')) { dob = parseDate(c('date_of_birth')); if (!dob) errors.push(`Date of birth "${c('date_of_birth')}" should look like 2014-05-21 or 21/05/2014.`); else if (dob > new Date().toISOString().slice(0, 10)) errors.push('Date of birth is in the future.'); }
  let enrolled: string | null = null; if (c('enrolled_on')) { enrolled = parseDate(c('enrolled_on')); if (!enrolled) errors.push(`Enrolled date "${c('enrolled_on')}" should look like 2026-06-01 or 01/06/2026.`); }
  let branchId: string | null = null;
  if (c('branch')) {
    const k = c('branch').toLowerCase(); const b = lk.branches.find((x) => x.code.toLowerCase() === k || x.name.toLowerCase() === k);
    if (!b) errors.push(`Unknown branch "${c('branch')}".`); else if (!canWriteBranch(user, b.id)) errors.push(`You cannot add learners to branch "${b.name}".`); else branchId = b.id;
  }
  const batchIds: string[] = []; const labels: string[] = [];
  for (const tok of c('batches').split(/[|;]/).map((t) => t.trim()).filter(Boolean)) {
    const k = tok.toLowerCase(); const matches = lk.batches.filter((x) => x.batch_code.toLowerCase() === k || x.name.toLowerCase() === k);
    if (!matches.length) { errors.push(`Unknown batch "${tok}". Use the batch code or its exact name.`); continue; }
    if (matches.length > 1) { errors.push(`Batch name "${tok}" matches ${matches.length} batches. Use the batch code instead.`); continue; }
    const b = matches[0]!;
    if (b.status === 'archived' || b.status === 'completed') { errors.push(`Batch "${tok}" is ${b.status} and cannot take new learners.`); continue; }
    if (!canWriteBranch(user, b.branch_id)) { errors.push(`You cannot enroll learners into "${b.name}" (another branch).`); continue; }
    if (!batchIds.includes(b.id)) { batchIds.push(b.id); labels.push(b.batch_code); }
  }
  if (batchIds.length > 20) errors.push('At most 20 batches per learner.');
  let parent: Clean['parent'] = null;
  const pn = c('parent_name').replace(/\s+/g, ' '); const pm = c('parent_mobile'); const pe = c('parent_email').toLowerCase();
  if (pn || pm || pe) {
    let pmob: string | null = null;
    if (pm) { pmob = normalizeMobile(pm); if (!pmob) errors.push(`Parent mobile "${pm}" is not a valid 10 digit Indian number.`); }
    if (pe && !EMAIL.test(pe)) errors.push(`Parent email "${pe}" is not valid.`);
    if (pn.length < 2) errors.push('Parent name is required when a parent mobile or email is given.');
    else parent = { full_name: pn.slice(0, 120), mobile: pmob, email: pe && EMAIL.test(pe) ? pe : null, relationship: (c('relationship') || 'guardian').toLowerCase().slice(0, 30) };
  }
  if (!mobile && !email && !errors.length) errors.push('Add a mobile or an email: without one, importing the same file twice would create the learner twice.');
  if (errors.length) return { clean: null, errors };
  return { clean: { full_name: name, mobile, email, gender, date_of_birth: dob, school: c('school') || null, location: c('location') || null, enrolled_on: enrolled, branch_id: branchId, batch_ids: batchIds, batch_labels: labels, parent }, errors };
}
