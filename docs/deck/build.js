const pptxgen = require('pptxgenjs');
const React = require('react'); const RDS = require('react-dom/server'); const sharp = require('sharp');
const fa = require('react-icons/fa');
const { applyTheme } = require('/root/.claude/skills/synced/a9c09219-302c-4661-9390-92f6042fe16e_b14f1ca9-52df-4ef4-bd4e-0f8c53c9933e/pptx/scripts/apply_theme.js');

const THEME = { name: 'Robokalam Dev Guide', headFontFace: 'Cambria', bodyFontFace: 'Calibri', colors: {
  dk1: '1B2A41', lt1: 'FFFFFF', dk2: '0F1B33', lt2: 'F3F6FA', accent1: '0E9AA7', accent2: 'F2A93B', accent3: '5B6B82', accent4: '3B6FD4', accent5: 'D9534F', accent6: '2E9E6B', hlink: '3B6FD4', folHlink: '5B6B82' } };
const H = { ink: '1B2A41', navy: '0F1B33', teal: '0E9AA7', amber: 'F2A93B', slate: '5B6B82', light: 'F3F6FA', white: 'FFFFFF', red: 'D9534F', green: '2E9E6B', blue: '3B6FD4' };

const pres = new pptxgen(); pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = 'Robokalam Learner OS - Developer Guide v2'; pres.author = 'Robokalam'; pres.subject = 'Step-by-step guide for junior developers';
const C = pres.SchemeColor;
const W = 13.33;

pres.defineSlideMaster({ title: 'DARK', background: { color: H.navy }, objects: [], slideNumber: undefined });
pres.defineSlideMaster({ title: 'CONTENT', background: { color: H.white },
  objects: [
    { text: { text: 'Robokalam Learner OS  ·  Developer guide  ·  v2', options: { x: 0.6, y: 7.0, w: 6, h: 0.3, fontSize: 10, color: C.accent3, fontFace: '+mn-lt', margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: C.accent3, align: 'right', fontFace: '+mn-lt' } });

const SZ = { title: 34 };
let secOpen = '';
function section(name) { pres.addSection({ title: name }); secOpen = name; }

function content(kicker, title, notes) {
  const s = pres.addSlide({ masterName: 'CONTENT', sectionTitle: secOpen });
  s.addText(kicker.toUpperCase(), { x: 0.6, y: 0.35, w: 9, h: 0.3, fontSize: 12, bold: true, color: C.accent2, charSpacing: 3, fontFace: '+mn-lt', margin: 0, isTextBox: true, objectName: 'Kicker' });
  s.addText(title, { x: 0.6, y: 0.68, w: 12.1, h: 0.75, fontSize: SZ.title, bold: true, color: C.text1, fontFace: '+mj-lt', margin: 0, valign: 'top', isTextBox: true, objectName: 'Title' });
  if (notes) s.addNotes(notes);
  return s;
}
function card(s, x, y, w, h, o = {}) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: o.fill ?? C.background2 }, line: { color: o.line ?? C.background2, width: 0.75 }, shadow: o.shadow ? { type: 'outer', color: '000000', opacity: 0.12, blur: 6, offset: 2, angle: 90 } : undefined, objectName: o.name ?? 'Card' });
}
function text(s, t, x, y, w, h, o = {}) { s.addText(t, { x, y, w, h, fontSize: 16, color: C.text1, fontFace: '+mn-lt', margin: 0, valign: 'top', isTextBox: true, ...o }); }
function badge(s, n, x, y, d = 0.5, fill = C.accent1) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: `Step ${n}` });
  s.addText(String(n), { x, y, w: d, h: d, fontSize: d > 0.45 ? 18 : 14, bold: true, color: C.background1, align: 'center', valign: 'middle', margin: 0, fontFace: '+mn-lt', isTextBox: true });
}
function code(s, src, x, y, w, h, fs = 13) {
  s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.06, fill: { color: C.text2 }, line: { color: C.text2 }, objectName: 'Code block' });
  s.addText(src, { x: x + 0.2, y: y + 0.15, w: w - 0.4, h: h - 0.3, fontSize: fs, fontFace: 'Courier New', color: 'E6EDF7', margin: 0, valign: 'top', isTextBox: true, objectName: 'Code text' });
}
async function icon(name, color) { const svg = RDS.renderToStaticMarkup(React.createElement(fa[name], { color: '#' + color, size: 256 })); const b = await sharp(Buffer.from(svg)).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(); return 'image/png;base64,' + b.toString('base64'); }
function bullets(items, o = {}) { return items.map((t, i) => ({ text: t, options: { bullet: { indent: 16 }, breakLine: i < items.length - 1, paraSpaceAfter: o.gap ?? 8 } })); }
function arrow(s, x1, y, x2, color = C.accent3) { s.addShape(pres.ShapeType.line, { x: x1, y, w: x2 - x1, h: 0, line: { color, width: 2, endArrowType: 'triangle' }, objectName: 'Arrow' }); }
function varrow(s, x, y1, y2, color = C.accent3) { s.addShape(pres.ShapeType.line, { x, y: y1, w: 0, h: y2 - y1, line: { color, width: 2, endArrowType: 'triangle' }, objectName: 'Arrow' }); }

(async () => {
  const ic = {}; for (const [k, n, c] of [['org', 'FaBuilding', H.teal], ['sis', 'FaUserGraduate', H.teal], ['lms', 'FaChalkboardTeacher', H.teal], ['assess', 'FaClipboardCheck', H.teal], ['game', 'FaTrophy', H.teal], ['att', 'FaCalendarCheck', H.teal], ['crm', 'FaBullseye', H.teal], ['wa', 'FaWhatsapp', H.teal], ['chart', 'FaChartLine', H.teal]]) ic[k] = await icon(n, c);

  // 1 ─ Title
  { const s = pres.addSlide({ masterName: 'DARK' });
    s.addShape(pres.ShapeType.ellipse, { x: 9.3, y: 0.9, w: 5, h: 5, fill: { color: C.accent1, transparency: 80 }, line: { color: C.accent1, transparency: 80 }, objectName: 'Motif' });
    s.addShape(pres.ShapeType.ellipse, { x: 10.8, y: 3.7, w: 3.2, h: 3.2, fill: { color: C.accent2, transparency: 75 }, line: { color: C.accent2, transparency: 75 }, objectName: 'Motif 2' });
    text(s, 'DEVELOPER ONBOARDING  ·  VERSION 2', 0.8, 1.7, 8, 0.4, { fontSize: 14, bold: true, color: C.accent2, charSpacing: 4 });
    text(s, 'Robokalam Learner OS', 0.8, 2.2, 10.5, 1.0, { fontSize: 46, bold: true, color: C.background1, fontFace: '+mj-lt' });
    text(s, 'A step-by-step guide for junior software developers', 0.8, 3.45, 9, 0.6, { fontSize: 24, color: C.background2 });
    text(s, 'From a clean laptop to your first merged pull request', 0.8, 4.3, 9, 0.5, { fontSize: 18, color: C.accent1, italic: true });
    text(s, 'Version 2  ·  Covers Phases 1-13  ·  Node + TypeScript  ·  React  ·  MySQL', 0.8, 6.5, 9, 0.4, { fontSize: 14, color: C.accent3 });
    s.addNotes('Welcome. This guide takes about a week at a relaxed pace. Do one part per day and keep the app running while you read.'); }

  // 2 ─ Roadmap
  section('Roadmap');
  { const s = content('Start here', 'How to use this guide', 'Six parts. Each ends with something you can do, not just read.');
    const parts = [['Understand', 'What the product does and the five rules behind it'], ['Set up', 'Run the app and all tests on your laptop'], ['Learn the code', 'Request flow, database, auth, permissions'], ['Build', 'Add a small feature end to end'], ['Check', 'Test, debug, secure, make it fast'], ['Ship', 'Pull request, deploy, backups, on-call basics']];
    parts.forEach((p, i) => { const col = i % 3, row = Math.floor(i / 3); const x = 0.6 + col * 4.1, y = 1.8 + row * 2.35; card(s, x, y, 3.9, 2.1, { shadow: true }); badge(s, i + 1, x + 0.25, y + 0.25, 0.55); text(s, p[0], x + 0.95, y + 0.3, 2.8, 0.5, { fontSize: 22, bold: true, fontFace: '+mj-lt' }); text(s, p[1], x + 0.25, y + 1.05, 3.4, 0.9, { fontSize: 16, color: C.accent3 }); });
    text(s, 'Tip: keep the app running on the side and try every step yourself.', 0.6, 6.55, 11, 0.4, { fontSize: 16, italic: true, color: C.accent1 }); }

  // 3 ─ What is it
  section('Part 1 · Understand');
  { const s = content('Part 1 · Understand', 'What are we building?', 'One operating system for every learner.');
    text(s, [{ text: 'A multi-tenant SaaS for Robokalam and other Indian education organizations.', options: { breakLine: true, bold: true } }, { text: ' ', options: { breakLine: true, fontSize: 8 } }, { text: 'Each organization gets its own isolated data: learners, batches, classrooms, scores, parents, leads and WhatsApp messages.', options: {} }], 0.6, 1.8, 4.1, 3.2, { fontSize: 18 });
    card(s, 0.6, 5.0, 4.1, 1.5, { fill: C.text2, line: C.text2 });
    text(s, 'Live at os.robokalam.in', 0.85, 5.2, 3.7, 0.4, { fontSize: 16, bold: true, color: C.accent2 });
    text(s, '13 phases built: foundation to e-mail and certificates', 0.85, 5.7, 3.7, 0.7, { fontSize: 15, color: C.background1 });
    const mods = [['org', 'Organizations & roles'], ['sis', 'Learners & batches'], ['lms', 'Classroom & assignments'], ['assess', 'Scores & gradebook'], ['game', 'XP, badges, leaderboard'], ['att', 'Attendance & parent portal'], ['crm', 'CRM & follow-ups'], ['wa', 'WhatsApp & announcements'], ['chart', 'Analytics & reports']];
    mods.forEach((m, i) => { const col = i % 3, row = Math.floor(i / 3); const x = 5.1 + col * 2.75, y = 1.8 + row * 1.6; card(s, x, y, 2.55, 1.4, { shadow: true }); s.addImage({ data: ic[m[0]], x: x + 0.2, y: y + 0.2, w: 0.5, h: 0.5, altText: m[1] }); text(s, m[1], x + 0.2, y + 0.8, 2.2, 0.5, { fontSize: 15, bold: true }); }); }

  // 4 ─ Five rules
  { const s = content('Part 1 · Understand', 'Five rules that shape every line of code', 'These come straight from the product brief. A pull request that breaks one of them will not be merged.');
    const r = [['One learner = one master profile', 'Batches are memberships (learner_batch_memberships), never copies of the learner.'], ['Dedupe by learner_id', 'Learner in 3 selected batches = counted, messaged and exported once.'], ['Everything belongs to an organization', 'Isolation is enforced in SQL and by composite foreign keys.'], ['Permissions, audit log, soft delete', 'Who may do it, who did it, and nothing is really erased.'], ['No fake functionality', 'No static dashboards, no buttons that do nothing: every number comes from the database.']];
    r.forEach((x, i) => { const y = 1.75 + i * 1.02; card(s, 0.6, y, 12.1, 0.9); badge(s, i + 1, 0.8, y + 0.2, 0.5, i === 4 ? C.accent2 : C.accent1); text(s, x[0], 1.55, y + 0.12, 4.6, 0.7, { fontSize: 18, bold: true, valign: 'middle' }); text(s, x[1], 6.2, y + 0.12, 6.3, 0.7, { fontSize: 15, color: C.accent3, valign: 'middle' }); }); }

  // 5 ─ Stack
  { const s = content('Part 1 · Understand', 'The tech stack', 'No ORM on purpose: SQL is explicit and reviewable.');
    const cards = [['Backend', ['Node 22 + TypeScript (ESM)', 'Express 5, zod 4 validation', 'mysql2/promise: plain SQL, no ORM', 'JWT + bcryptjs, helmet, rate limits', 'pino structured logs']], ['Frontend', ['React 19 + Vite + react-router', 'Hand-written CSS design system', 'One small API client (api.ts)', 'Responsive: phone, tablet, desktop', 'Role-aware navigation']], ['Data', ['MySQL 8 / MariaDB 10.6+', 'Numbered SQL migrations', 'UUID primary keys, org_id everywhere', 'Generated columns for unique rules', 'Covering indexes for reports']], ['Quality & ops', ['vitest + supertest on a real DB', 'Playwright browser flows', 'Postman / newman collection', 'Encrypted backups + restore drill', 'Hostinger Node app, Git deploy']]];
    cards.forEach((c, i) => { const col = i % 2, row = Math.floor(i / 2); const x = 0.6 + col * 6.15, y = 1.75 + row * 2.6; card(s, x, y, 5.95, 2.4, { shadow: true }); text(s, c[0], x + 0.3, y + 0.2, 5.3, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' }); text(s, bullets(c[1], { gap: 4 }), x + 0.3, y + 0.7, 5.4, 1.6, { fontSize: 15 }); }); }

  // 6 ─ Architecture
  { const s = content('Part 1 · Understand', 'How the pieces fit together', 'One Node process serves both the API and the built web app. Workers run inside it.');
    const box = (x, y, w, h, t, sub, fill, tc) => { card(s, x, y, w, h, { fill, line: fill, shadow: true }); text(s, t, x + 0.15, y + 0.15, w - 0.3, 0.45, { fontSize: 18, bold: true, color: tc, align: 'center', fontFace: '+mj-lt' }); text(s, sub, x + 0.15, y + 0.65, w - 0.3, h - 0.7, { fontSize: 14, color: tc, align: 'center' }); };
    box(0.6, 2.4, 2.6, 1.8, 'Browser', 'React app\n(learner, parent, staff)', C.background2, C.text1);
    box(4.2, 2.0, 4.4, 2.6, 'Express API', 'One Node process\nroutes · RBAC · validation · audit\nalso serves the built web app', C.text2, C.background1);
    box(9.6, 2.4, 3.1, 1.8, 'MySQL', 'all data, uploads,\nmigrations', C.background2, C.text1);
    arrow(s, 3.2, 3.05, 4.2); arrow(s, 4.2, 3.55, 3.2); arrow(s, 8.6, 3.05, 9.6); arrow(s, 9.6, 3.55, 8.6);
    text(s, 'HTTPS', 3.2, 3.62, 1.0, 0.3, { fontSize: 12, color: C.accent3, align: 'center' });
    card(s, 4.2, 5.3, 4.4, 1.3, { fill: C.background2, line: C.accent1 });
    text(s, 'Background workers', 4.4, 5.4, 4.0, 0.4, { fontSize: 16, bold: true, color: C.accent1 });
    text(s, 'Same process: WhatsApp sender, cleanup job', 4.4, 5.85, 4.0, 0.5, { fontSize: 14 });
    varrow(s, 6.4, 4.6, 5.3);
    card(s, 9.6, 5.3, 3.1, 1.3, { fill: C.background2, line: C.accent2 });
    text(s, 'AiSensy (external)', 9.8, 5.4, 2.8, 0.4, { fontSize: 16, bold: true, color: C.accent2 });
    text(s, 'sends WhatsApp, calls our webhook', 9.8, 5.85, 2.8, 0.7, { fontSize: 14 });
    arrow(s, 8.6, 5.95, 9.6); }

  // 7 ─ Repo map
  { const s = content('Part 1 · Understand', 'Where things live', 'Find the folder first, then the file.');
    code(s, 'robokalamos/\n├─ server/\n│  ├─ src/\n│  │  ├─ app.ts            middleware + routers\n│  │  ├─ modules/<feature>/routes.ts\n│  │  ├─ lib/              audit, scope, security\n│  │  ├─ middleware/       auth, csrf, limits\n│  │  └─ db/pool.ts        query, exec, tx\n│  ├─ migrations/NNN_*.sql\n│  ├─ tests/               vitest suites\n│  └─ dev/                 seed + perf scripts\n├─ web/src/  pages/ components/ api.ts\n├─ docs/     architecture + runbooks\n└─ postman/  collection + environment', 0.6, 1.75, 7.4, 4.9, 15);
    text(s, 'Rules of thumb', 8.4, 1.75, 4.3, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['One feature = one folder in server/src/modules.', 'Shared helpers go in lib/, never copy-pasted.', 'A merged migration is never edited: add a new numbered one.', 'Every page in web/src/pages maps to a route in App.tsx.', 'docs/ is the source of truth for design decisions.'], { gap: 12 }), 8.4, 2.3, 4.3, 4.4, { fontSize: 18 }); }

  // 8 ─ Setup A
  section('Part 2 · Set up');
  { const s = content('Part 2 · Set up', 'Step 1-4: get the code and a database', 'Use MariaDB or MySQL. The test database name must end in _test.');
    const steps = [['Install Node 22, Git and MySQL 8 (or MariaDB 10.6+)'], ['Clone and install: one command installs server + web'], ['Create a database and a user'], ['Copy the env file, set DATABASE_URL and JWT_SECRET']];
    steps.forEach((t, i) => { const y = 1.8 + i * 1.05; badge(s, i + 1, 0.6, y, 0.5); text(s, t[0], 1.3, y - 0.02, 4.6, 0.9, { fontSize: 17, valign: 'middle' }); });
    code(s, 'git clone https://github.com/abhinayame/robokalamOS\ncd robokalamOS && npm install\n\nmysql -u root -p -e "\n  CREATE DATABASE rk_dev CHARACTER SET utf8mb4;\n  CREATE USER \'rk\'@\'localhost\' IDENTIFIED BY \'rk_dev_pw\';\n  GRANT ALL ON rk_dev.* TO \'rk\'@\'localhost\';"\n\ncp server/.env.example server/.env\n# DATABASE_URL=mysql://rk:rk_dev_pw@127.0.0.1:3306/rk_dev\n# JWT_SECRET=<48+ random characters>', 6.2, 1.75, 6.5, 4.4, 13);
    text(s, 'Never commit server/.env. It is already in .gitignore.', 6.2, 6.3, 6.5, 0.4, { fontSize: 14, italic: true, color: H.red }); }

  // 9 ─ Setup B
  { const s = content('Part 2 · Set up', 'Step 5-9: migrate, seed, run, verify', 'Migrations are plain SQL files applied in order and recorded in schema_migrations.');
    const steps = ['Apply all SQL migrations', 'Create the platform owner (needs SUPER_ADMIN_EMAIL / PASSWORD in .env)', 'Optional: demo organization with realistic data (dev only)', 'Start API (:4000) and web (:5173) in two terminals', 'Verify the health endpoint, then open the app'];
    steps.forEach((t, i) => { const y = 1.75 + i * 0.95; badge(s, i + 5, 0.6, y, 0.5); text(s, t, 1.3, y - 0.05, 4.9, 0.9, { fontSize: 16, valign: 'middle' }); });
    code(s, 'npm run migrate\nnpm run seed -w server\nnpm run seed:demo -w server\n\nnpm run dev:server     # terminal 1\nnpm run dev:web        # terminal 2\n\ncurl localhost:4000/api/health/ready\n# {"ok":true,"data":{"status":"ready",...}}\n\n# open http://localhost:5173', 6.5, 1.75, 6.2, 4.3, 14);
    card(s, 6.5, 6.2, 6.2, 0.55, { fill: C.background2, line: C.accent2 }); text(s, 'Stuck? Read the first error line; it names the missing variable.', 6.7, 6.3, 5.9, 0.4, { fontSize: 14, valign: 'middle' }); }

  // 10 ─ Accounts
  { const s = content('Part 2 · Set up', 'Log in as every role', 'Switching roles is the fastest way to understand permissions.');
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 }, fontSize: 15 } });
    const row = (a, b, c) => [{ text: a, options: { bold: true, fontSize: 14 } }, { text: b, options: { fontFace: 'Courier New', fontSize: 13 } }, { text: c, options: { fontSize: 14 } }];
    s.addTable([[hdr('Role'), hdr('Email (dev demo)'), hdr('What to look for')],
      row('Platform owner', 'owner@robokalam.test', 'Organizations menu; works inside one org at a time'),
      row('Org admin', 'admin@demo.robokalam.test', 'Everything in the organization, incl. System Status'),
      row('Teacher', 'teacher1@demo.robokalam.test', 'Only assigned batches, classroom tools'),
      row('Learner', 'aarav@demo.robokalam.test', 'Own classes, assignments, XP, badges'),
      row('Parent', 'parent@demo.robokalam.test', "Child's progress, read-only")],
      { x: 0.6, y: 1.8, w: 12.1, colW: [2.4, 4.3, 5.4], border: { type: 'solid', color: 'D5DCE6', pt: 0.75 }, fill: { color: C.background1 }, color: C.text1, fontFace: '+mn-lt', rowH: 0.62, valign: 'middle', margin: [0.05, 0.12, 0.05, 0.12] });
    card(s, 0.6, 5.85, 12.1, 0.85, { fill: C.text2, line: C.text2 });
    text(s, 'Demo password (development only): Demo-Pass-12345.  Never reuse it on a real server.', 0.85, 5.95, 11.6, 0.65, { fontSize: 16, color: C.background1, valign: 'middle' }); }

  // 11 ─ Request lifecycle
  section('Part 3 · Learn the code');
  { const s = content('Part 3 · Learn the code', 'Life of a request', 'Open app.ts and read the middleware in the order they are mounted.');
    const st = [['observe', 'request id, access log'], ['helmet · CORS', 'headers, compression'], ['rate limit', 'per user or IP'], ['authenticate', 'JWT + live session'], ['requirePerm', 'RBAC check'], ['parse (zod)', 'validate input'], ['handler', 'SQL + audit'], ['ok() / error', 'JSON envelope']];
    st.forEach((x, i) => { const col = i % 4, row = Math.floor(i / 4); const bx = 0.6 + col * 3.1, by = 1.8 + row * 1.9; card(s, bx, by, 2.7, 1.5, { shadow: true, fill: i === 6 ? C.accent1 : C.background2, line: i === 6 ? C.accent1 : C.background2 }); badge(s, i + 1, bx + 0.15, by + 0.15, 0.4, i === 6 ? C.accent2 : C.accent1); text(s, x[0], bx + 0.15, by + 0.65, 2.4, 0.4, { fontSize: 17, bold: true, color: i === 6 ? C.background1 : C.text1 }); text(s, x[1], bx + 0.15, by + 1.05, 2.4, 0.4, { fontSize: 14, color: i === 6 ? C.background1 : C.accent3 }); if (col < 3) arrow(s, bx + 2.7, by + 0.75, bx + 3.1); });
    code(s, 'success  { "ok": true,  "data": ..., "meta": { "page": 1, "total": 120 } }\nfailure  { "ok": false, "error": { "code": "VALIDATION", "message": "...", "request_id": "..." } }', 0.6, 5.7, 12.1, 1.0, 13); }

  // 12 ─ DB conventions
  { const s = content('Part 3 · Learn the code', 'Database conventions', 'Parameterized SQL only. Never build SQL with string concatenation of user values.');
    text(s, bullets(['Primary keys: VARCHAR(36) UUIDs from newId().', 'Every table has org_id; foreign keys are composite (id, org_id).', 'DATETIME(3) in UTC. They arrive as ISO strings: do not call .toISOString().', 'Soft delete with deleted_at; history rows are never removed.', 'Placeholders are $1, $2 ... in the order you pass values.', 'Dynamic filters: Params builder, .add(value) and .in(list).', 'Several writes that must succeed together: tx(async (db) => ...).'], { gap: 11 }), 0.6, 1.75, 6.2, 5.0, { fontSize: 17 });
    code(s, "const p = new Params();\nconst where = [`l.org_id = ${p.add(orgId)}`,\n               'l.deleted_at IS NULL'];\nif (status) where.push(\n  `l.status = ${p.add(status)}`);\nif (ids.length) where.push(\n  `l.id IN ${p.in(ids)}`);\n\nconst rows = await query(\n  `SELECT l.id, l.full_name FROM learners l\n    WHERE ${where.join(' AND ')}\n    ORDER BY l.full_name LIMIT 25`,\n  p.values);", 7.1, 1.75, 5.6, 4.2, 14); }

  // 13 ─ Multi tenancy
  { const s = content('Part 3 · Learn the code', 'Organization and scope: who sees what', 'Out-of-scope reads return 404, not 403, so the existence of a record is never leaked.');
    const lv = [['Platform owner', 'Picks one organization (X-Org-Id header)', C.text2, C.background1], ['Org admin', 'Whole organization', C.accent1, C.background1], ['Branch admin', 'Own branch(es) only', C.accent4, C.background1], ['Teacher', 'Only assigned batches', C.accent6, C.background1], ['Learner / parent', 'Only themselves / their children', C.accent2, C.text1]];
    lv.forEach((x, i) => { const y = 1.75 + i * 0.98; const w = 7.6 - i * 0.55; card(s, 0.6, y, w, 0.82, { fill: x[2], line: x[2] }); text(s, x[0], 0.85, y + 0.04, w - 0.5, 0.4, { fontSize: 17, bold: true, color: x[3] }); text(s, x[1], 0.85, y + 0.42, w - 0.5, 0.35, { fontSize: 14, color: x[3] }); });
    text(s, 'Helpers you must use', 8.9, 1.75, 3.8, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['orgIdOf(req): the organization, never from the body.', 'learnerScope(): SQL filter for learners the caller may see.', 'batchScope(): same for batches.', 'openRoom(): gate for classroom routes (404 when out of scope).'], { gap: 10 }), 8.9, 2.3, 3.8, 3.2, { fontSize: 15 });
    card(s, 8.9, 5.5, 3.8, 1.1, { fill: C.background2, line: C.red }); text(s, 'Cross-org data leak = the worst bug we can ship.', 9.05, 5.6, 3.5, 0.9, { fontSize: 15, bold: true, color: C.red, valign: 'middle' }); }

  // 14 ─ Auth
  { const s = content('Part 3 · Learn the code', 'Sign-in and sessions', 'Short-lived access token plus a rotating single-use refresh token.');
    const st = [['Login', 'POST /api/auth/login returns an access JWT (15 min) and sets a refresh cookie (7 days).'], ['Every request', 'JWT is verified AND its session row in auth_sessions must still be live.'], ['Refresh', 'POST /api/auth/refresh swaps the refresh token for a new one. Each token works once.'], ['Cookies', 'HttpOnly, SameSite=Lax, Secure in production. Writes also need the CSRF header.'], ['Protection', 'Lockout after 8 bad passwords; same message whether the account exists or not.']];
    st.forEach((x, i) => { const y = 1.7 + i * 0.88; badge(s, i + 1, 0.6, y + 0.1, 0.5); text(s, x[0], 1.4, y, 2.4, 0.8, { fontSize: 18, bold: true, valign: 'middle' }); text(s, x[1], 3.8, y, 8.9, 0.8, { fontSize: 16, color: C.accent3, valign: 'middle' }); });
    card(s, 0.6, 6.2, 12.1, 0.6, { fill: C.background2, line: C.accent1 }); text(s, 'Tools using a Bearer token (Postman, scripts) skip CSRF; browsers use cookies + CSRF.', 0.85, 6.25, 11.6, 0.55, { fontSize: 15, valign: 'middle' }); }

  // 15 ─ RBAC
  { const s = content('Part 3 · Learn the code', 'Roles and permissions (RBAC)', 'A permission code is the contract between database, API and UI.');
    text(s, bullets(['A permission is a code such as learner:read or tag:manage.', 'Roles group permissions: org_admin, branch_admin, teacher, counsellor, accountant, learner, parent.', 'Tables: permissions, roles, role_permissions, user_roles.', 'API: requirePerm(\'code\') on every route.', 'UI: <Guard perm="code"> and the nav item perm field.', 'A test scans all routes and fails if one has no permission.'], { gap: 12 }), 0.6, 1.75, 6.0, 5.0, { fontSize: 17 });
    text(s, 'Adding a permission = a migration', 7.0, 1.75, 5.7, 0.4, { fontSize: 18, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    code(s, "INSERT INTO permissions (id, code, description)\nVALUES (UUID(), 'system:read',\n  'View the System status page');\n\nINSERT INTO role_permissions\n  (role_id, permission_id)\nSELECT r.id, p.id FROM roles r\n  JOIN permissions p ON p.code = 'system:read'\n WHERE r.code IN ('super_admin','org_admin');", 7.0, 2.3, 5.7, 3.4, 13);
    text(s, 'From server/migrations/009_system.sql', 7.0, 5.85, 5.7, 0.4, { fontSize: 13, italic: true, color: C.accent3 }); }

  // 16 ─ Selection engine
  { const s = content('Part 3 · Learn the code', 'Selection and bulk actions', 'The same engine powers filters, exports, bulk changes and WhatsApp audiences.');
    const st = [['Select', 'Pick batches or filters'], ['Resolve', 'Unique learners by learner_id in SQL'], ['Dry run', 'Preview counts, change nothing'], ['Confirm', 'Explicit confirm, audit logged']];
    st.forEach((x, i) => { const bx = 0.6 + i * 3.1; card(s, bx, 1.8, 2.7, 1.7, { shadow: true }); badge(s, i + 1, bx + 0.2, 2.0, 0.45); text(s, x[0], bx + 0.8, 2.0, 1.8, 0.45, { fontSize: 19, bold: true, valign: 'middle' }); text(s, x[1], bx + 0.2, 2.6, 2.3, 0.8, { fontSize: 15, color: C.accent3 }); if (i < 3) arrow(s, bx + 2.7, 2.65, bx + 3.1); });
    card(s, 0.6, 3.9, 6.0, 2.7, { fill: C.text2, line: C.text2 });
    text(s, 'Example: three batches selected', 0.85, 4.05, 5.5, 0.4, { fontSize: 16, bold: true, color: C.accent2 });
    text(s, [{ text: '3 batches', options: { breakLine: true } }, { text: '3 memberships', options: { breakLine: true } }, { text: '2 unique learners', options: { breakLine: true, bold: true, color: C.accent2 } }, { text: '1 duplicate removed', options: {} }], 0.85, 4.55, 5.5, 1.9, { fontSize: 22, color: C.background1, paraSpaceAfter: 6 });
    text(s, 'Endpoints', 7.0, 3.9, 5.7, 0.4, { fontSize: 18, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['POST /api/selection/resolve', 'POST /api/bulk/learners (dry_run, then confirm)', 'POST /api/bulk/learners/export'], { gap: 8 }), 7.0, 4.4, 5.7, 1.4, { fontSize: 15 });
    text(s, 'Rule: count people with COUNT(DISTINCT learner_id), never memberships.', 7.0, 5.8, 5.7, 0.8, { fontSize: 15, bold: true, color: H.red }); }

  // 17 ─ Tutorial steps
  section('Part 4 · Build a feature');
  { const s = content('Part 4 · Build a feature', 'Add a feature in eight steps', 'Example: a simple "tags" style resource. Follow the same order every time.');
    const st = ['Write a numbered migration (new table with org_id)', 'Add permission rows and grant them to roles', 'Create modules/<feature>/routes.ts', 'Validate input with a zod schema and parse()', 'Write SQL with placeholders; scope by org and role', 'Call audit() for every write', 'Mount the router in app.ts AFTER authenticate', 'Add tests, then the page in web/src/pages'];
    st.forEach((t, i) => { const col = i % 2, row = Math.floor(i / 2); const x = 0.6 + col * 6.15, y = 1.75 + row * 1.2; card(s, x, y, 5.95, 1.05, { shadow: true }); badge(s, i + 1, x + 0.2, y + 0.25, 0.55, i < 4 ? C.accent1 : C.accent4); text(s, t, x + 1.0, y + 0.08, 4.8, 0.9, { fontSize: 16, valign: 'middle' }); }); }

  // 18 ─ Route code
  { const s = content('Part 4 · Build a feature', 'Anatomy of a route', 'Simplified from modules/crm/tags.ts.');
    code(s, "router.post('/', requirePerm('tag:manage'), wrap(async (req, res) => {\n  const b = parse(tagBody, req.body);\n  const id = newId();\n\n  await exec(\n    `INSERT INTO tags (id, org_id, name, created_by)\n     VALUES ($1,$2,$3,$4)`,\n    [id, orgIdOf(req), b.name, req.user!.id]);\n\n  await audit({ orgId: orgIdOf(req), actor: req.user,\n    action: 'tag.created', entityType: 'tag',\n    entityId: id, next: b, req });\n\n  ok(res, { id }, undefined, 201);\n}));", 0.6, 1.75, 7.6, 4.9, 15);
    const n = [['Permission first', 'requirePerm runs before any code'], ['Validate input', 'parse() returns 400 with field errors'], ['Org from request', 'orgIdOf(req), never the body'], ['Audit the write', 'who, what, before and after'], ['Standard envelope', 'ok() and 201 for creates']];
    n.forEach((x, i) => { const y = 1.75 + i * 1.0; badge(s, i + 1, 8.5, y + 0.1, 0.45, C.accent2); text(s, x[0], 9.2, y, 3.5, 0.4, { fontSize: 16, bold: true }); text(s, x[1], 9.2, y + 0.4, 3.5, 0.5, { fontSize: 14, color: C.accent3 }); }); }

  // 19 ─ Frontend
  { const s = content('Part 4 · Build a feature', 'Front-end patterns', 'Always render loading, error and empty states. Never invent data.');
    text(s, bullets(['api.get / api.post (api.ts) handle tokens, CSRF and the org header.', 'useFetch + <Async> give loading, error with retry, and empty states.', 'Shared pieces in components/ui.tsx: PageHead, Stat, Badge, Pager, Modal, useToast.', 'Routes live in App.tsx; guard with <Guard perm="...">.', 'Menu items live in components/Layout.tsx with a perm field.', 'Show friendly(e) for errors; offer a way to retry.', 'Check it on a phone-width screen too.'], { gap: 11 }), 0.6, 1.75, 6.3, 5.0, { fontSize: 17 });
    code(s, "export default function Audit() {\n  const [page, setPage] = useState(1);\n  const q = useFetch(\n    () => api.get(`/api/audit${qs({ page })}`),\n    [page]);\n  return (\n    <>\n      <PageHead title=\"Audit log\" />\n      <Async q={q}>{(r) => (\n        <Table rows={r.data} />\n      )}</Async>\n    </>\n  );\n}", 7.2, 1.75, 5.5, 4.4, 13);
    text(s, 'Pattern from web/src/pages/Audit.tsx', 7.2, 6.3, 5.5, 0.4, { fontSize: 13, italic: true, color: C.accent3 }); }

  // 20 ─ Testing
  section('Part 5 · Check');
  { const s = content('Part 5 · Check', 'Testing: prove it works', 'Tests run against a real MariaDB database that is dropped and recreated every run.');
    const stats = [['158', 'server tests'], ['14', 'test files'], ['137', 'Postman requests']];
    stats.forEach((x, i) => { const y = 1.75 + i * 1.5; card(s, 0.6, y, 3.4, 1.3, { shadow: true }); text(s, x[0], 0.8, y + 0.1, 3.0, 0.8, { fontSize: 44, bold: true, color: C.accent1, fontFace: '+mj-lt' }); text(s, x[1], 0.8, y + 0.85, 3.0, 0.4, { fontSize: 15, color: C.accent3 }); });
    text(s, 'For every endpoint test at least', 4.4, 1.75, 8.3, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['Happy path with the right role', 'Wrong role: 403 (or 404 when it should hide existence)', 'Another organization cannot see or change it', 'Invalid input: 400 with field messages', 'Repeating the call: duplicates and idempotency', 'The audit log entry exists'], { gap: 8 }), 4.4, 2.3, 8.3, 2.9, { fontSize: 16 });
    code(s, 'npm test                  # server suite (database name must end in _test)\nnpm run typecheck         # server + web\nnpx newman run postman/robokalam-learner-os.postman_collection.json \\\n   -e postman/robokalam-learner-os.postman_environment.json', 4.4, 5.25, 8.3, 1.45, 13); }

  // 21 ─ Debugging
  { const s = content('Part 5 · Check', 'Debugging and observability', 'A request id turns "it broke" into one log line.');
    const c = [['Request id', 'Every response has X-Request-Id; errors include request_id. Search the log for it.'], ['Structured logs', 'JSON (pino). Slow requests (>2 s) and slow queries (>1.5 s) are warnings. No bodies or tokens are logged.'], ['Health checks', '/api/health (alive) and /api/health/ready (database + migrations).'], ['System Status page', 'Settings → System Status: latency, slowest routes, queues, 8 integrity checks that must be zero.'], ['Audit log', 'Settings → Audit log shows who changed what, with before and after.'], ['Postman', 'Reproduce with the same call outside the UI.']];
    c.forEach((x, i) => { const col = i % 3, row = Math.floor(i / 3); const bx = 0.6 + col * 4.1, by = 1.75 + row * 2.5; card(s, bx, by, 3.9, 2.3, { shadow: true }); text(s, x[0], bx + 0.25, by + 0.2, 3.4, 0.4, { fontSize: 18, bold: true, color: C.accent1, fontFace: '+mj-lt' }); text(s, x[1], bx + 0.25, by + 0.75, 3.4, 1.5, { fontSize: 14 }); }); }

  // 22 ─ Security checklist
  { const s = content('Part 5 · Check', 'Security checklist for every pull request', 'Tick every box in your PR description.');
    const it = ['requirePerm on every new route', 'Organization taken from the request, not the body', 'SQL parameterized; sort columns from a whitelist', 'zod schema strips unknown fields (no mass assignment)', 'Out-of-scope records return 404', 'Every write calls audit()', 'No secrets or personal data in code, logs or responses', 'Expensive or bulk endpoints are rate limited'];
    it.forEach((t, i) => { const col = i % 2, row = Math.floor(i / 2); const bx = 0.6 + col * 6.15, by = 1.75 + row * 1.2; card(s, bx, by, 5.95, 1.0, { shadow: true }); s.addShape(pres.ShapeType.roundRect, { x: bx + 0.25, y: by + 0.27, w: 0.46, h: 0.46, rectRadius: 0.08, fill: { color: C.accent6 }, line: { color: C.accent6 }, objectName: 'Checkbox' }); text(s, '✓', bx + 0.25, by + 0.27, 0.46, 0.46, { fontSize: 18, bold: true, color: C.background1, align: 'center', valign: 'middle' }); text(s, t, bx + 0.95, by + 0.08, 4.8, 0.85, { fontSize: 16, valign: 'middle' }); }); }

  // 23 ─ Performance
  { const s = content('Part 5 · Check', 'Performance: measure, then fix', 'Numbers from a local test with 100,121 learners and 800,968 attendance rows.');
    const st = [['0.2 s', 'learner list page (100k learners)'], ['0.6 s', 'unique learners over 1,000+ batches'], ['0.14 s', 'attendance report, was 15.9 s']];
    st.forEach((x, i) => { const bx = 0.6 + i * 4.1; card(s, bx, 1.75, 3.9, 1.8, { fill: C.text2, line: C.text2 }); text(s, x[0], bx + 0.25, 1.9, 3.4, 0.9, { fontSize: 44, bold: true, color: C.accent2, fontFace: '+mj-lt' }); text(s, x[1], bx + 0.25, 2.85, 3.4, 0.6, { fontSize: 14, color: C.background1 }); });
    text(s, 'Checklist', 0.6, 3.9, 6, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['Filter and paginate on the server; never send all learners to the browser.', 'Aggregate in SQL, not in JavaScript loops.', 'Index every column you filter or join on; check with EXPLAIN.', 'Use covering indexes for big reports (migration 010 is an example).', 'Seed big data (seed:large, seed:perf) and time it with dev/perf-check.ts.'], { gap: 7 }), 0.6, 4.4, 12.1, 2.4, { fontSize: 16 }); }

  // 24 ─ Git workflow
  section('Part 6 · Ship');
  { const s = content('Part 6 · Ship', 'Git and pull request workflow', 'Small pull requests get reviewed faster and break less.');
    const st = [['Branch', 'git checkout -b feature/short-name from main'], ['Commit', 'Small commits with clear messages'], ['Check', 'npm test and npm run typecheck pass locally'], ['Push', 'git push -u origin your-branch'], ['Open PR', 'Say what changed, why, how you tested'], ['Review', 'Answer comments; push fixes'], ['Merge', 'Hostinger redeploys main automatically'], ['Verify', 'Health check + try the feature']];
    st.forEach((x, i) => { const col = i % 4, row = Math.floor(i / 4); const bx = 0.6 + col * 3.1, by = 1.8 + row * 2.2; card(s, bx, by, 2.7, 1.9, { shadow: true }); badge(s, i + 1, bx + 0.2, by + 0.2, 0.45, i < 4 ? C.accent1 : C.accent4); text(s, x[0], bx + 0.8, by + 0.2, 1.8, 0.45, { fontSize: 18, bold: true, valign: 'middle' }); text(s, x[1], bx + 0.2, by + 0.85, 2.4, 1.0, { fontSize: 14, color: C.accent3 }); });
    card(s, 0.6, 6.15, 12.1, 0.6, { fill: C.background2, line: C.red }); text(s, 'Never push passwords, API keys or .env files. If one leaks, rotate it immediately.', 0.85, 6.2, 11.6, 0.5, { fontSize: 15, bold: true, color: C.red, valign: 'middle' }); }

  // 25 ─ Deploy
  { const s = content('Part 6 · Ship', 'Deploy and operate', 'Details are in docs/DEPLOYMENT.md and docs/RUNBOOK.md.');
    text(s, 'How production works', 0.6, 1.75, 6, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['Hostinger Node app deploys main on every merge.', 'On start the app runs pending migrations.', 'Settings are environment variables, never code.', 'Check /api/health/ready and Settings → System Status after each deploy.', 'Uptime monitor on /api/health/ready.'], { gap: 14 }), 0.6, 2.3, 6.0, 4.3, { fontSize: 18 });
    text(s, 'Backups and restore', 7.0, 1.75, 5.7, 0.4, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    code(s, "# daily, encrypted, keep 14\nBACKUP_PASSPHRASE=... \\\n npm run backup:prod -w server -- \\\n   --out ~/backups --keep 14\n\n# restore drill into an EMPTY database\nnode server/dist/scripts/restore.js FILE\n\n# check a file without restoring\n... restore.js FILE --verify-only", 7.0, 2.3, 5.7, 3.4, 13);
    text(s, 'A backup you have never restored is not a backup. Drill every quarter.', 7.0, 5.85, 5.7, 0.8, { fontSize: 15, bold: true, color: H.red }); }

  // 26 ─ Mistakes
  { const s = content('Part 6 · Ship', 'Mistakes we already made (so you do not)', 'Each one cost real debugging time.');
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 }, fontSize: 15 } });
    const r = (a, b) => [{ text: a, options: { fontSize: 14 } }, { text: b, options: { fontSize: 14, bold: true } }];
    s.addTable([[hdr('Mistake'), hdr('Do this instead')],
      r('Calling .toISOString() on a DATETIME column', 'They are already ISO strings; use them directly'),
      r('GROUP BY query fails (ONLY_FULL_GROUP_BY)', 'Group by every non-aggregated selected column'),
      r('zod 4 literal error text with errorMap', "Use z.literal(true, { message: '...' })"),
      r('New route without requirePerm', 'The permission-scan test fails; add the permission'),
      r('Editing a merged migration', 'Add a new numbered migration instead'),
      r('Loading rows then filtering in JavaScript', 'Filter, sort and paginate in SQL'),
      r('Counting memberships as learners', 'COUNT(DISTINCT learner_id)'),
      r('Taking org_id from the request body', 'orgIdOf(req) only')],
      { x: 0.6, y: 1.75, w: 12.1, colW: [6.0, 6.1], border: { type: 'solid', color: 'D5DCE6', pt: 0.75 }, fill: { color: C.background1 }, color: C.text1, fontFace: '+mn-lt', rowH: 0.55, valign: 'middle', margin: [0.04, 0.12, 0.04, 0.12] }); }

  // 27 ─ Week plan
  { const s = content('Part 6 · Ship', 'Your first week', 'Pair with a teammate on day 3 and 4.');
    const d = [['Day 1', 'Set up, run tests, log in as each role'], ['Day 2', 'Read ARCHITECTURE.md; trace one request in the code'], ['Day 3', 'Pick a small issue; write the migration and route'], ['Day 4', 'Add tests and the page; try it on a phone'], ['Day 5', 'Open the pull request and respond to review']];
    d.forEach((x, i) => { const bx = 0.6 + i * 2.45; card(s, bx, 1.9, 2.25, 3.7, { shadow: true }); text(s, x[0], bx + 0.2, 2.1, 1.9, 0.5, { fontSize: 26, bold: true, color: C.accent1, fontFace: '+mj-lt' }); text(s, x[1], bx + 0.2, 2.85, 1.9, 2.6, { fontSize: 18 }); });
    text(s, 'Goal by Friday: one merged pull request with tests.', 0.6, 6.0, 12.1, 0.5, { fontSize: 20, bold: true, color: C.accent2 }); }

  // 28 ─ Where to find
  { const s = content('Part 6 · Ship', 'Where to find answers', 'Search the docs before asking, then ask early.');
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 }, fontSize: 15 } });
    const r = (a, b) => [{ text: a, options: { fontFace: 'Courier New', fontSize: 13 } }, { text: b, options: { fontSize: 14 } }];
    s.addTable([[hdr('Where'), hdr('What you find')],
      r('docs/ARCHITECTURE.md', 'Design, ERD, API list, permission matrix'),
      r('docs/PHASE-2 ... PHASE-13', 'What each phase built and the decisions behind it'),
      r('docs/DEPLOYMENT.md', 'Environment variables, backups, rotation, monitoring'),
      r('docs/SECURITY.md', 'Security model and limits'),
      r('docs/RUNBOOK.md', 'Symptom, check, fix'),
      r('postman/', 'Runnable API collection (phases 2-13)'),
      r('Settings → System Status', 'Live health of a running deployment')],
      { x: 0.6, y: 1.75, w: 12.1, colW: [4.4, 7.7], border: { type: 'solid', color: 'D5DCE6', pt: 0.75 }, fill: { color: C.background1 }, color: C.text1, fontFace: '+mn-lt', rowH: 0.58, valign: 'middle', margin: [0.04, 0.12, 0.04, 0.12] }); }


  // ───────── Version 2 · Phases 10-13
  section('Version 2 · Phases 10-13');
  { const s = content('Version 2 · What is new', 'Four phases added since version 1', 'Everything here is merged in order: 10, 11, 12, 13. Each phase has its own document in docs/.');
    const ph = [['10', 'Money and automation', 'Fees and installments, payments and receipts, Razorpay links, automatic reminders, CSV import of learners'], ['11', 'Live classes', 'Zoom meetings from the schedule, attendance from who joined, recordings'], ['12', 'Branding and app', 'Logo, name and colors per school, custom domain, installable app with an offline page'], ['13', 'E-mail and certificates', 'Password reset by e-mail, e-mail reminders, calendar feeds, certificates with QR verification']];
    ph.forEach((p, i) => { const col = i % 2, row = Math.floor(i / 2); const x = 0.6 + col * 6.15, y = 1.75 + row * 2.35; card(s, x, y, 5.95, 2.15, { shadow: true }); badge(s, p[0], x + 0.25, y + 0.25, 0.65, i % 2 ? C.accent2 : C.accent1); text(s, p[1], x + 1.1, y + 0.3, 4.6, 0.5, { fontSize: 20, bold: true, fontFace: '+mj-lt' }); text(s, p[2], x + 1.1, y + 0.9, 4.6, 1.1, { fontSize: 14, color: C.accent3 }); });
    text(s, '7 new migrations (011-017)  ·  244 automated tests', 0.6, 6.55, 12.1, 0.4, { fontSize: 16, bold: true, color: C.accent1 }); }

  { const s = content('Phase 10 · Money', 'How a payment reaches the right installment', 'Money is stored as DECIMAL in the database and whole paise in code, so there is never a floating-point rupee.');
    const steps = [['Plan', 'Fee plan with installments (label, amount, due after N days)'], ['Assign', 'Selection engine picks learners; preview, then confirm; one fee per learner'], ['Pay', 'Staff record cash/UPI, or the learner pays a Razorpay link'], ['Allocate', 'Payment fills the oldest due installment first'], ['Refund', 'Reverses the latest-due installments first']];
    steps.forEach((p, i) => { const x = 0.6 + i * 2.45; card(s, x, 1.85, 2.25, 2.55, { shadow: true }); badge(s, i + 1, x + 0.2, 2.0, 0.5, i === 4 ? C.accent2 : C.accent1); text(s, p[0], x + 0.85, 2.05, 1.3, 0.4, { fontSize: 18, bold: true, fontFace: '+mj-lt' }); text(s, p[1], x + 0.2, 2.7, 1.95, 1.6, { fontSize: 13, color: C.accent3 }); if (i < 4) arrow(s, x + 2.25, 3.1, x + 2.45); });
    code(s, "POST /api/webhooks/razorpay     (public, but...)\n  1. HMAC-SHA256 over the RAW body must match\n  2. webhook_events(provider, event_key) is unique -> a repeat is a no-op\n  3. payments.provider_payment_id is unique       -> never recorded twice", 0.6, 4.75, 12.1, 1.45, 14);
    text(s, 'Never trust the browser saying "I paid". Only a signed webhook or a staff member records money.', 0.6, 6.4, 12.1, 0.4, { fontSize: 15, italic: true, color: C.accent1 }); }

  { const s = content('Phase 10 · Automation', 'Reminders send once, imports resume', 'Both are about doing a lot of work safely: once-only and restart-safe.');
    card(s, 0.6, 1.75, 5.95, 4.7, { shadow: true }); text(s, 'Automatic reminders', 0.9, 1.95, 5.4, 0.45, { fontSize: 20, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['Rule = trigger (fee due, fee overdue, class soon, absence) + message + sending hours', 'Unique (rule_id, dedupe_key) row is claimed first, so two servers never send twice', 'Preview shows who would get it; nothing is sent in preview', 'Skips and the reason (no phone, opted out) are logged'], { gap: 10 }), 0.9, 2.6, 5.4, 3.7, { fontSize: 15 });
    card(s, 6.75, 1.75, 5.95, 4.7, { shadow: true }); text(s, 'CSV import', 7.05, 1.95, 5.4, 0.45, { fontSize: 20, bold: true, color: C.accent2, fontFace: '+mj-lt' });
    text(s, bullets(['Upload, preview every row (valid / duplicate / error), then confirm', 'Each row is its own transaction through the same createLearner service as the form', 'A background runner claims rows with a token, so a restart resumes where it stopped', 'Download the problem rows as CSV, fix, and upload again'], { gap: 10 }), 7.05, 2.6, 5.4, 3.7, { fontSize: 15 }); }

  { const s = content('Phase 11 · Live classes', 'Zoom reports joins, we decide attendance', 'The matching order matters: never guess between two people with the same name.');
    const b = (x, y, w, t, sub, fill, tc) => { card(s, x, y, w, 1.35, { fill, line: fill, shadow: true }); text(s, t, x + 0.15, y + 0.12, w - 0.3, 0.4, { fontSize: 17, bold: true, color: tc, align: 'center', fontFace: '+mj-lt' }); text(s, sub, x + 0.15, y + 0.55, w - 0.3, 0.75, { fontSize: 13, color: tc, align: 'center' }); };
    b(0.6, 1.8, 3.4, 'Zoom', 'meeting created from the class; join/leave events', C.background2, C.text1); b(4.95, 1.8, 3.4, 'Webhook', 'HMAC v0 signature + 5 minute window', C.text2, C.background1); b(9.3, 1.8, 3.4, 'live_participants', 'join/leave log, one row per join', C.background2, C.text1);
    arrow(s, 4.0, 2.5, 4.95); arrow(s, 8.35, 2.5, 9.3);
    text(s, 'How a name becomes a learner', 0.6, 3.5, 6, 0.4, { fontSize: 18, bold: true, color: C.accent1, fontFace: '+mj-lt' });
    text(s, bullets(['1. A remembered alias (staff matched it once)', '2. E-mail used to join', '3. Exact full name, only if exactly one learner has it', 'Otherwise: "who is this?" and staff pick'], { gap: 6 }), 0.6, 3.95, 6, 2.6, { fontSize: 15 });
    text(s, 'Attendance rules', 6.9, 3.5, 5.8, 0.4, { fontSize: 18, bold: true, color: C.accent2, fontFace: '+mj-lt' });
    text(s, bullets(['Present: stayed at least 10 minutes or half the class', 'Late: joined more than 10 minutes after the start', 'A mark a teacher made by hand is never overwritten'], { gap: 6 }), 6.9, 3.95, 5.8, 2.6, { fontSize: 15 }); }

  { const s = content('Phase 12 · Branding and app', 'Every school looks like itself', 'Everything public here exposes public fields only.');
    const rows = [['Logo: square PNG, 512-2048 px', 'Checked from its bytes, not its file name'], ['Main color', 'Needs 4.5:1 contrast with white, so white text stays readable'], ['Public branding endpoints', '/api/public/branding, logo, manifest: before sign-in, rate limited'], ['Service worker', 'Caches only static files; never touches /api/'], ['Offline page', 'A friendly page when the server is unreachable'], ['Custom domain', 'learn.myschool.in shows that school\'s branding on sign-in']];
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 }, fontSize: 15 } });
    s.addTable([[hdr('Feature'), hdr('Rule behind it')], ...rows.map((r) => [{ text: r[0], options: { bold: true, fontSize: 14 } }, { text: r[1], options: { fontSize: 14 } }])], { x: 0.6, y: 1.75, w: 12.1, colW: [4.4, 7.7], border: { type: 'solid', color: 'D5DCE6', pt: 0.75 }, fill: { color: C.background1 }, color: C.text1, fontFace: '+mn-lt', rowH: 0.62, valign: 'middle', margin: [0.04, 0.12, 0.04, 0.12] }); }

  { const s = content('Phase 13 · E-mail and certificates', 'Secret links, checked once', 'Reset links, calendar links and certificate codes are all unguessable values where the server checks the value itself.');
    const c4 = [['Password reset', 'Same answer for any address. Only the hash of the token is stored; it works once for 30 minutes; every session is signed out.'], ['Calendar feed', 'Personal .ics link for Google/Apple/Outlook. Shown once, hash stored, can be replaced or turned off.'], ['Certificates', 'Design once, issue to a batch (preview, confirm). Wording frozen at issue. PDF with QR code.'], ['Public verify', '/verify/RKC-XXXX-XXXX shows name, course, date and valid or revoked. Nothing else.']];
    c4.forEach((p, i) => { const col = i % 2, row = Math.floor(i / 2); const x = 0.6 + col * 6.15, y = 1.75 + row * 2.45; card(s, x, y, 5.95, 2.25, { shadow: true }); text(s, p[0], x + 0.3, y + 0.2, 5.3, 0.45, { fontSize: 20, bold: true, color: i % 2 ? C.accent2 : C.accent1, fontFace: '+mj-lt' }); text(s, p[1], x + 0.3, y + 0.8, 5.3, 1.35, { fontSize: 15 }); });
    text(s, 'E-mail is a second channel: reminder rules can send by e-mail with the same once-only log and one-click unsubscribe.', 0.6, 6.6, 12.1, 0.4, { fontSize: 14, italic: true, color: C.accent1 }); }

  { const s = content('Pattern · Providers', 'How every outside service is plugged in', 'Razorpay, Zoom, AiSensy and SMTP all follow this recipe. Copy it when you add the next one.');
    const st = [['Interface', 'send / createMeeting / createLink, returning ok or a typed failure'], ['Real client', 'Reads keys from env only; never logs or returns them'], ['Test seam', 'setXProvider(fake) in tests; production never calls it'], ['Honest off', 'No keys = feature hidden or says "not connected". Never fake success'], ['Visible', 'Preflight warning and a System Status row']];
    st.forEach((p, i) => { const y = 1.75 + i * 0.98; card(s, 0.6, y, 12.1, 0.86); badge(s, i + 1, 0.8, y + 0.18, 0.5, i === 3 ? C.accent2 : C.accent1); text(s, p[0], 1.55, y + 0.1, 2.8, 0.66, { fontSize: 18, bold: true, valign: 'middle' }); text(s, p[1], 4.4, y + 0.1, 8.1, 0.66, { fontSize: 15, valign: 'middle', color: C.accent3 }); });
    text(s, 'Tests use stand-in providers. A real message, payment, meeting or e-mail can only be proven with real keys.', 0.6, 6.7, 12.1, 0.3, { fontSize: 14, italic: true, color: C.accent1 }); }

  { const s = content('Version 2 · Hostinger settings', 'Environment variables the new phases read', 'Set these in Hostinger, never in the code and never in the web app. Empty means the feature stays off.');
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 }, fontSize: 15 } });
    const r = (a, b) => [{ text: a, options: { fontFace: 'Courier New', fontSize: 12 } }, { text: b, options: { fontSize: 14 } }];
    s.addTable([[hdr('Variable'), hdr('Turns on')], r('RAZORPAY_KEY_ID / KEY_SECRET', 'Online payment links'), r('RAZORPAY_WEBHOOK_SECRET', 'Recording payments automatically'), r('ZOOM_ACCOUNT_ID / CLIENT_ID / CLIENT_SECRET', 'Create Zoom meetings'), r('ZOOM_WEBHOOK_SECRET_TOKEN', 'Automatic attendance and recordings'), r('SMTP_HOST / PORT / SECURE / USER / PASSWORD / FROM', 'E-mail and password reset'), r('APP_URL', 'Correct links in e-mails, calendars, certificate QR codes'), r('REMINDERS, EMAIL_WORKER', 'Switch the background senders off on a server')],
      { x: 0.6, y: 1.75, w: 12.1, colW: [6.1, 6.0], border: { type: 'solid', color: 'D5DCE6', pt: 0.75 }, fill: { color: C.background1 }, color: C.text1, fontFace: '+mn-lt', rowH: 0.55, valign: 'middle', margin: [0.04, 0.12, 0.04, 0.12] });
    text(s, 'Never paste a key in chat, a ticket or a commit. Rotate any key that was ever shown.', 0.6, 6.3, 12.1, 0.4, { fontSize: 15, bold: true, color: H.red }); }

  { const s = content('Version 2 · Product coverage', 'Where we stand on live-teaching features', 'Compared with a typical live-class platform such as Wise.live. Honest status: built, partly, or not built.');
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.text2 }, fontSize: 14 } });
    const st = (t) => ({ text: t, options: { bold: true, fontSize: 13, color: t === 'Built' ? C.accent6 : t === 'Partly' ? C.accent2 : C.accent5 } });
    const r = (a, b, c) => [{ text: a, options: { fontSize: 13 } }, st(b), { text: c, options: { fontSize: 13 } }];
    s.addTable([[hdr('Feature'), hdr('Status'), hdr('How')],
      r('Fees, payments, receipts', 'Built', 'Phase 10: plans, ledger, Razorpay links, refunds'),
      r('Automatic reminders', 'Built', 'WhatsApp and e-mail rules, once-only'),
      r('Bulk learner import', 'Built', 'CSV preview, confirm, resume'),
      r('Live classes and attendance', 'Partly', 'Through Zoom; not our own video room'),
      r('Recordings', 'Partly', 'Stored as links to Zoom recordings'),
      r('Branded, installable app', 'Built', 'PWA with logo, colors, domain'),
      r('Certificates', 'Built', 'PDF, QR, public verification'),
      r('Calendar sync', 'Built', 'Personal .ics feed'),
      r('Native store apps', 'Not built', 'PWA instead'),
      r('In-class polls, whiteboard, chat', 'Not built', 'Zoom features are used instead'),
      r('Proctored online exams', 'Not built', 'Quizzes exist, without proctoring')],
      { x: 0.6, y: 1.65, w: 12.1, colW: [4.0, 1.5, 6.6], border: { type: 'solid', color: 'D5DCE6', pt: 0.75 }, fill: { color: C.background1 }, color: C.text1, fontFace: '+mn-lt', rowH: 0.43, valign: 'middle', margin: [0.03, 0.1, 0.03, 0.1] }); }

  // Closing
  { const s = pres.addSlide({ masterName: 'DARK' });
    s.addShape(pres.ShapeType.ellipse, { x: 9.3, y: 0.9, w: 5, h: 5, fill: { color: C.accent1, transparency: 80 }, line: { color: C.accent1, transparency: 80 }, objectName: 'Motif' });
    text(s, 'Ask early. Ship small. Test everything.', 0.8, 2.0, 11.5, 1.0, { fontSize: 38, bold: true, color: C.background1, fontFace: '+mj-lt' });
    text(s, 'Every learner is one profile. Every query is scoped. Every number is real.', 0.8, 3.5, 11, 0.6, { fontSize: 20, color: C.accent1, italic: true });
    text(s, 'Welcome to the team.', 0.8, 4.8, 8, 0.5, { fontSize: 18, color: C.accent2, bold: true }); }

  const out = process.argv[2];
  await pres.writeFile({ fileName: out });
  if (!process.env.SKIP_THEME) await applyTheme(out, THEME);
  console.log('wrote', out);
})();
