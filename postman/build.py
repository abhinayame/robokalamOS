import json
# Generates the Postman collection + environment (kept as a script so the JSON stays reviewable/regenerable).
def req(name, method, path, body=None, tests=None, pre=None, auth=True, org=True, desc=None, token_var='AUTH_TOKEN'):
    headers = [{"key": "Content-Type", "value": "application/json"}]
    if org: headers.append({"key": "X-Org-Id", "value": "{{ORG_ID}}", "disabled": True, "description": "Only needed when signed in as the platform super admin"})
    item = {"name": name, "request": {"method": method, "header": headers, "url": {"raw": "{{BASE_URL}}" + path, "host": ["{{BASE_URL}}"], "path": [p for p in path.split("?")[0].split("/") if p], "query": [{"key": k, "value": v} for k, v in (kv.split("=", 1) for kv in path.split("?")[1].split("&"))] if "?" in path else []}}}
    if desc: item["request"]["description"] = desc
    item["request"]["auth"] = {"type": "bearer", "bearer": [{"key": "token", "value": "{{" + token_var + "}}", "type": "string"}]} if auth else {"type": "noauth"}
    if body is not None: item["request"]["body"] = {"mode": "raw", "raw": json.dumps(body, indent=2), "options": {"raw": {"language": "json"}}}
    if not auth:   # anonymous request: drop cookies the login responses stored in the jar, or the server would treat it as a signed-in browser
        clear = "pm.cookies.jar().clear(pm.variables.replaceIn('{{BASE_URL}}'), () => {});"
        if path.startswith("/api/auth/"): clear += "\npm.cookies.jar().clear(pm.variables.replaceIn('{{BASE_URL}}') + '/api/auth', () => {});"   # the refresh cookie is path-scoped to /api/auth
        pre = clear + ("\n" + pre.strip() if pre else "")
    ev = []
    if pre: ev.append({"listen": "prerequest", "script": {"type": "text/javascript", "exec": pre.strip().split("\n")}})
    if tests: ev.append({"listen": "test", "script": {"type": "text/javascript", "exec": tests.strip().split("\n")}})
    if ev: item["event"] = ev
    return item

def status(code): return f"pm.test('status is {code}', () => pm.response.to.have.status({code}));"
J = "const j = pm.response.json();"
def setv(k, expr): return f"pm.environment.set('{k}', {expr});"

folders = []
folders.append(("0 · Health & auth", [
  req("Health", "GET", "/api/health", auth=False, tests=status(200)),
  req("Request without token is rejected", "GET", "/api/learners", auth=False, tests=status(401) + "\n" + J + "\npm.test('consistent error envelope', () => pm.expect(j).to.have.property('ok', false) && pm.expect(j.error).to.have.property('code'));"),
  req("Login — platform super admin", "POST", "/api/auth/login", {"email": "{{SUPER_ADMIN_EMAIL}}", "password": "{{SUPER_ADMIN_PASSWORD}}"}, auth=False, org=False,
      tests=status(200) + "\n" + J + "\n" + setv("SUPER_TOKEN", "j.data.access_token") + "\n" + setv("AUTH_TOKEN", "j.data.access_token") + "\npm.test('is super admin', () => pm.expect(j.data.user.roles).to.include('super_admin'));"),
]))
folders.append(("1 · Organization", [
  req("Create organization (+ its admin)", "POST", "/api/organizations", {"name": "Postman Org {{RUN_ID}}", "slug": "pm-{{RUN_ID}}", "code_prefix": "PM", "admin": {"full_name": "Postman Admin", "email": "admin-{{RUN_ID}}@postman.test", "password": "Postman-Pass-123"}},
      pre="pm.environment.set('RUN_ID', Date.now().toString(36));",
      tests=status(201) + "\n" + J + "\n" + setv("ORG_ID", "j.data.organization.id") + "\n" + setv("ADMIN_EMAIL", "j.data.admin.email")),
  req("Login — organization admin", "POST", "/api/auth/login", {"email": "{{ADMIN_EMAIL}}", "password": "Postman-Pass-123"}, auth=False, org=False,
      tests=status(200) + "\n" + J + "\n" + setv("AUTH_TOKEN", "j.data.access_token") + "\npm.test('org admin is pinned to the new org', () => pm.expect(j.data.user.organization.id).to.eql(pm.environment.get('ORG_ID')));"),
]))
folders.append(("2 · Catalog & people", [
  req("Create branch", "POST", "/api/branches", {"name": "Chennai", "code": "CHN"}, tests=status(201) + "\n" + J + "\n" + setv("BRANCH_ID", "j.data.id")),
  req("Create program", "POST", "/api/programs", {"name": "STEM", "code": "STEM"}, tests=status(201) + "\n" + J + "\n" + setv("PROGRAM_ID", "j.data.id")),
  req("Create course", "POST", "/api/courses", {"program_id": "{{PROGRAM_ID}}", "name": "Robotics", "code": "ROBO"}, tests=status(201) + "\n" + J + "\n" + setv("COURSE_ID", "j.data.id")),
  req("Create teacher", "POST", "/api/teachers", {"full_name": "Priya Raman", "email": "teacher-{{RUN_ID}}@postman.test", "password": "Postman-Pass-123"}, tests=status(201) + "\n" + J + "\n" + setv("TEACHER_ID", "j.data.id")),
]))
batch_body = lambda n: {"name": n, "program_id": "{{PROGRAM_ID}}", "course_id": "{{COURSE_ID}}", "branch_id": "{{BRANCH_ID}}", "academic_year": "2026-27", "status": "active", "capacity": 30, "teacher_id": "{{TEACHER_ID}}", "schedule": {"days": [6], "start": "10:00", "end": "12:00", "mode": "offline"}}
folders.append(("3 · Batches", [
  req("Create batch A", "POST", "/api/batches", batch_body("Robotics Batch A"), tests=status(201) + "\n" + J + "\n" + setv("BATCH_ID", "j.data.id") + "\npm.test('batch code generated', () => pm.expect(j.data.batch_code).to.match(/^PM-BAT-\\d{4}$/));"),
  req("Create batch B", "POST", "/api/batches", batch_body("Robotics Batch B"), tests=status(201) + "\n" + J + "\n" + setv("BATCH_ID_2", "j.data.id")),
  req("Get batch", "GET", "/api/batches/{{BATCH_ID}}", tests=status(200) + "\n" + J + "\npm.test('lead teacher assigned', () => pm.expect(j.data.teachers[0].role).to.eql('lead'));"),
]))
folders.append(("4 · Learners — one master profile", [
  req("Create learner (parent + batch A)", "POST", "/api/learners", {"full_name": "Rahul Kumar", "mobile": "9{{MOBILE_TAIL}}", "email": "rahul-{{RUN_ID}}@example.com", "school": "DAV", "location": "Chennai", "branch_id": "{{BRANCH_ID}}", "parent": {"full_name": "Sunil Kumar", "mobile": "8{{MOBILE_TAIL}}", "relationship": "father"}, "batch_ids": ["{{BATCH_ID}}"]},
      pre="pm.environment.set('MOBILE_TAIL', String(Math.floor(Math.random()*1e9)).padStart(9,'0'));",
      tests=status(201) + "\n" + J + "\n" + setv("LEARNER_ID", "j.data.id") + "\npm.test('learner id format', () => pm.expect(j.data.learner_code).to.match(/^PM-LRN-\\d{6}$/));\npm.test('in 1 batch', () => pm.expect(j.data.stats.active_batches).to.eql(1));"),
  req("Duplicate mobile is rejected (no second learner)", "POST", "/api/learners", {"full_name": "Someone Else", "mobile": "9{{MOBILE_TAIL}}"}, tests=status(409) + "\n" + J + "\npm.test('points to the existing profile', () => pm.expect(j.error.details.existing.id).to.eql(pm.environment.get('LEARNER_ID')));"),
  req("Update learner", "PATCH", "/api/learners/{{LEARNER_ID}}", {"school": "PSBB"}, tests=status(200) + "\n" + J + "\npm.test('updated', () => pm.expect(j.data.school).to.eql('PSBB'));"),
  req("Enroll SAME learner into second batch", "POST", "/api/learners/{{LEARNER_ID}}/batches", {"batch_id": "{{BATCH_ID_2}}"}, tests=status(201) + "\n" + J + "\npm.test('still ONE learner, now 2 batches', () => pm.expect(j.data.learner.stats.active_batches).to.eql(2));"),
  req("Enroll again is idempotent", "POST", "/api/learners/{{LEARNER_ID}}/batches", {"batch_id": "{{BATCH_ID_2}}"}, tests=status(200) + "\n" + J + "\npm.test('already a member', () => pm.expect(j.data.already_member).to.eql(1));"),
  req("Get learner profile (Learner 360)", "GET", "/api/learners/{{LEARNER_ID}}", tests=status(200) + "\n" + J + "\npm.test('2 active memberships', () => pm.expect(j.data.memberships.filter(m => m.membership_status === 'active')).to.have.length(2));\npm.test('parent linked', () => pm.expect(j.data.parents[0].is_primary).to.eql(true));"),
  req("Activity timeline", "GET", "/api/learners/{{LEARNER_ID}}/timeline", tests=status(200) + "\n" + J + "\npm.test('has join events', () => pm.expect(j.data.map(e => e.type)).to.include('batch.joined'));"),
]))
folders.append(("5 · Listing, filters & selection engine", [
  req("Get all learners (paginated)", "GET", "/api/learners?page=1&page_size=25&sort=name&order=asc", tests=status(200) + "\n" + J + "\npm.test('pagination meta', () => pm.expect(j.meta).to.include.keys('page','page_size','total'));"),
  req("Filter learners (course + batch + status)", "GET", "/api/learners?course_id={{COURSE_ID}}&batch_id={{BATCH_ID}},{{BATCH_ID_2}}&status=active", tests=status(200) + "\n" + J + "\npm.test('learner appears exactly once', () => pm.expect(j.data.filter(l => l.id === pm.environment.get('LEARNER_ID'))).to.have.length(1));"),
  req("Select multiple batches → unique learners", "POST", "/api/selection/resolve", {"batch_ids": ["{{BATCH_ID}}", "{{BATCH_ID_2}}"]},
      tests=status(200) + "\n" + J + "\npm.test('2 batches, 2 memberships, 1 unique learner, 1 duplicate removed', () => pm.expect(j.data).to.include({selected_batches: 2, batch_memberships: 2, unique_learners: 1, duplicates_removed: 1}));"),
  req("Empty selection resolves to nobody", "POST", "/api/selection/resolve", {}, tests=status(200) + "\n" + J + "\npm.test('no recipients', () => pm.expect(j.data.unique_learners).to.eql(0));"),
  req("Bulk action dry run (no changes)", "POST", "/api/bulk/learners", {"action": "change_status", "status": "inactive", "dry_run": True, "selection": {"batch_ids": ["{{BATCH_ID}}", "{{BATCH_ID_2}}"]}}, tests=status(200) + "\n" + J + "\npm.test('preview only', () => pm.expect(j.data.dry_run).to.eql(true) && pm.expect(j.data.unique_learners).to.eql(1));"),
  req("Bulk action without confirmation is refused", "POST", "/api/bulk/learners", {"action": "change_status", "status": "inactive", "selection": {"batch_ids": ["{{BATCH_ID}}"]}}, tests=status(400) + "\n" + J + "\npm.test('confirmation required', () => pm.expect(j.error.code).to.eql('CONFIRMATION_REQUIRED'));"),
  req("Export CSV (deduplicated)", "POST", "/api/bulk/learners/export", {"selection": {"batch_ids": ["{{BATCH_ID}}", "{{BATCH_ID_2}}"]}, "columns": ["learner_code", "full_name"]}, tests=status(200) + "\npm.test('csv with one data row', () => pm.expect(pm.response.text().replace('\\uFEFF','').trim().split(/\\r?\\n/)).to.have.length(2));"),
]))
folders.append(("6 · Membership changes", [
  req("Remove learner from batch B (stays in A)", "DELETE", "/api/learners/{{LEARNER_ID}}/batches/{{BATCH_ID_2}}", {"reason": "Schedule clash"}, tests=status(200) + "\n" + J + "\npm.test('only batch A remains active', () => pm.expect(j.data.learner.stats.active_batches).to.eql(1));"),
  req("Transfer learner A → B", "POST", "/api/learners/{{LEARNER_ID}}/transfer", {"from_batch_id": "{{BATCH_ID}}", "to_batch_id": "{{BATCH_ID_2}}"}, tests=status(200) + "\n" + J + "\npm.test('now in B only', () => pm.expect(j.data.memberships.filter(m => m.membership_status === 'active').map(m => m.batch_id)).to.eql([pm.environment.get('BATCH_ID_2')]));"),
  req("Batch people list", "GET", "/api/batches/{{BATCH_ID_2}}/learners", tests=status(200) + "\n" + J + "\npm.test('learner listed', () => pm.expect(j.data.map(l => l.id)).to.include(pm.environment.get('LEARNER_ID')));"),
]))
folders.append(("7 · Access control", [
  req("Login — teacher", "POST", "/api/auth/login", {"email": "teacher-{{RUN_ID}}@postman.test", "password": "Postman-Pass-123"}, auth=False, org=False, tests=status(200) + "\n" + J + "\n" + setv("TEACHER_TOKEN", "j.data.access_token")),
  req("Teacher sees learners of assigned batches only", "GET", "/api/learners", tests=status(200) + "\n" + J + "\npm.test('scoped list', () => pm.expect(j.meta.total).to.be.at.least(1));", token_var="TEACHER_TOKEN"),
  req("Teacher cannot create learners", "POST", "/api/learners", {"full_name": "Not Allowed"}, tests=status(403), token_var="TEACHER_TOKEN"),
  req("Admin dashboard", "GET", "/api/dashboard", tests=status(200) + "\n" + J + "\npm.test('real numbers', () => pm.expect(j.data.learners.total).to.be.at.least(1));"),
  req("Audit log records the changes", "GET", "/api/audit?page_size=50", tests=status(200) + "\n" + J + "\npm.test('learner + batch events audited', () => { const a = j.data.map(x => x.action); pm.expect(a).to.include('learner.created'); pm.expect(a).to.include('batch.learners_assigned'); });"),
]))

# ---------------------------------------------------------------------------------------------
# Phases 2-8: classroom + scoring, gamification, attendance, CRM, WhatsApp, analytics, system, security.
# Assumes folders 0-7 ran: BATCH_ID / BATCH_ID_2 exist, the teacher leads both batches, LEARNER_ID is in batch B only.
# ---------------------------------------------------------------------------------------------
def get(name, path, tests, **kw): return req(name, "GET", path, tests=tests, **kw)
def has(label, expr): return f"pm.test('{label}', () => {{ {expr} }});"
PW = "Postman-Pass-123"

folders.append(("8 · Assignments, scores & gradebook", [
  req("Create second learner (batches A + B, with parent)", "POST", "/api/learners", {"full_name": "Meera Nair", "mobile": "7{{MOBILE_TAIL}}", "email": "meera-{{RUN_ID}}@example.com", "school": "DAV", "branch_id": "{{BRANCH_ID}}", "parent": {"full_name": "Anil Nair", "mobile": "6{{MOBILE_TAIL}}", "relationship": "father"}, "batch_ids": ["{{BATCH_ID}}", "{{BATCH_ID_2}}"]},
      desc="A second learner in BOTH batches. Used for bulk XP, the de-duplicated WhatsApp audience and the cross-learner access checks.",
      tests=status(201) + "\n" + J + "\n" + setv("LEARNER_ID_2", "j.data.id") + "\n" + has('in 2 batches', "pm.expect(j.data.stats.active_batches).to.eql(2)")),
  req("Teacher creates assignment in batch B", "POST", "/api/classrooms/{{BATCH_ID_2}}/assignments", {"title": "Build a line-follower", "description": "Build and test a line-following robot.", "instructions": "Submit a short write-up or a link.", "due_at": "{{DUE_AT}}", "max_marks": 50, "allow_resubmit": False},
      pre="pm.environment.set('DUE_AT', new Date(Date.now() + 7 * 86400000).toISOString());",
      desc="The teacher is the lead teacher of both batches, so the classroom manage check passes.",
      tests=status(201) + "\n" + J + "\n" + setv("ASSIGNMENT_ID", "j.data.id") + "\n" + has('id returned', "pm.expect(j.data.id).to.be.a('string')"), token_var="TEACHER_TOKEN"),
  get("Assignment detail (teacher view)", "/api/assignments/{{ASSIGNMENT_ID}}",
      status(200) + "\n" + J + "\n" + has('manage view with stats', "pm.expect(j.data.can_manage).to.eql(true); pm.expect(j.data.max_marks).to.eql(50); pm.expect(j.data.stats.members).to.eql(2); pm.expect(j.data.stats.handed_in).to.eql(0)"), token_var="TEACHER_TOKEN"),
  req("Create portal login for the learner", "POST", "/api/learners/{{LEARNER_ID}}/login", {"password": PW},
      desc="Learner/parent portal accounts are created by staff (POST /api/learners/:id/login, or /api/parents/:id/login). There is no self sign-up.",
      tests=status(201) + "\n" + J + "\n" + setv("LEARNER_EMAIL", "j.data.email") + "\n" + has('login email is the learner email', "pm.expect(j.data.email).to.include('rahul-')") + "\n" + has('given password is not echoed back', "pm.expect(j.data).to.not.have.property('temporary_password')")),
  req("Login — learner", "POST", "/api/auth/login", {"email": "{{LEARNER_EMAIL}}", "password": PW}, auth=False, org=False,
      tests=status(200) + "\n" + J + "\n" + setv("LEARNER_TOKEN", "j.data.access_token") + "\n" + has('learner role, pinned to the org', "pm.expect(j.data.user.roles).to.include('learner'); pm.expect(j.data.user.organization.id).to.eql(pm.environment.get('ORG_ID'))")),
  get("Learner sees the assignment as submittable", "/api/assignments/{{ASSIGNMENT_ID}}",
      status(200) + "\n" + J + "\n" + has('can submit, nothing handed in yet', "pm.expect(j.data.can_manage).to.eql(false); pm.expect(j.data.can_submit).to.eql(true); pm.expect(j.data.submission).to.eql(null); pm.expect(j.data).to.not.have.property('stats')"), token_var="LEARNER_TOKEN"),
  req("Learner submits work", "PUT", "/api/assignments/{{ASSIGNMENT_ID}}/submission", {"body": "My robot follows the line at 0.4 m/s.", "link_url": "https://example.com/robot-demo", "submit": True},
      tests=status(200) + "\n" + J + "\n" + setv("SUBMISSION_ID", "j.data.id") + "\n" + has('submitted on time', "pm.expect(j.data.status).to.eql('submitted'); pm.expect(j.data.late).to.eql(false)"), token_var="LEARNER_TOKEN"),
  req("Learner cannot submit twice", "PUT", "/api/assignments/{{ASSIGNMENT_ID}}/submission", {"body": "Second try", "submit": True},
      tests=status(409) + "\n" + J + "\n" + has('already submitted', "pm.expect(j.error.code).to.eql('ALREADY_SUBMITTED')"), token_var="LEARNER_TOKEN"),
  get("Teacher sees the submission to review", "/api/assignments/{{ASSIGNMENT_ID}}/submissions",
      status(200) + "\n" + J + "\n" + has('two members, one handed in', "pm.expect(j.data).to.have.length(2); const mine = j.data.find(r => r.learner_id === pm.environment.get('LEARNER_ID')); pm.expect(mine.status).to.eql('submitted'); pm.expect(mine.submission_id).to.eql(pm.environment.get('SUBMISSION_ID')); pm.expect(mine.score).to.eql(null); pm.expect(j.data.find(r => r.learner_id === pm.environment.get('LEARNER_ID_2')).status).to.eql('not_submitted')"), token_var="TEACHER_TOKEN"),
  req("Teacher evaluates: score 40 / 50", "POST", "/api/submissions/{{SUBMISSION_ID}}/review", {"action": "evaluate", "score": 40, "feedback": "Good work, tune the PID loop."},
      tests=status(200) + "\n" + J + "\n" + has('evaluated', "pm.expect(j.data.status).to.eql('evaluated')"), token_var="TEACHER_TOKEN"),
  req("Score above the maximum is rejected", "POST", "/api/submissions/{{SUBMISSION_ID}}/review", {"action": "evaluate", "score": 51, "feedback": "Too generous"},
      tests=status(400) + "\n" + J + "\n" + has('range error names the maximum', "pm.expect(j.ok).to.eql(false); pm.expect(j.error.message).to.include('between 0 and 50'); pm.expect(j.error.details[0].field).to.eql('score')"), token_var="TEACHER_TOKEN"),
  req("Negative score is rejected", "POST", "/api/submissions/{{SUBMISSION_ID}}/review", {"action": "evaluate", "score": -1},
      tests=status(400) + "\n" + J + "\n" + has('validation error', "pm.expect(j.ok).to.eql(false)"), token_var="TEACHER_TOKEN"),
  get("Score is still 40 after the rejected attempts", "/api/scores?learner_id={{LEARNER_ID}}&batch_id={{BATCH_ID_2}}",
      status(200) + "\n" + J + "\n" + has('one assignment score, unchanged', "pm.expect(j.data).to.have.length(1); pm.expect(j.data[0]).to.include({score: 40, max_score: 50, source_type: 'assignment', pct: 80}); pm.expect(j.data[0].source_id).to.eql(pm.environment.get('ASSIGNMENT_ID'))") + "\n" + setv("SCORE_ID", "j.data[0].id")),
  req("Teacher modifies the score: 45 / 50", "POST", "/api/submissions/{{SUBMISSION_ID}}/review", {"action": "evaluate", "score": 45, "feedback": "Re-checked: full marks for the demo."},
      tests=status(200) + "\n" + J + "\n" + has('still evaluated', "pm.expect(j.data.status).to.eql('evaluated')"), token_var="TEACHER_TOKEN"),
  get("Score history keeps the audit trail", "/api/scores/{{SCORE_ID}}/history",
      status(200) + "\n" + J + "\n" + has('created then updated 40 → 45, newest first', "pm.expect(j.data.map(h => h.action)).to.eql(['updated', 'created']); pm.expect(j.data[0]).to.include({previous_score: 40, new_score: 45, previous_max: 50, new_max: 50}); pm.expect(j.data[1]).to.include({new_score: 40}); pm.expect(j.data[0].changed_by).to.eql('Priya Raman')")),
  get("Learner sees the evaluated result", "/api/assignments/{{ASSIGNMENT_ID}}",
      status(200) + "\n" + J + "\n" + has('completed with score 45 and feedback', "pm.expect(j.data.state).to.eql('completed'); pm.expect(j.data.submission.status).to.eql('evaluated'); pm.expect(j.data.submission.score).to.eql(45); pm.expect(j.data.submission.feedback).to.include('full marks'); pm.expect(j.data.can_submit).to.eql(false)"), token_var="LEARNER_TOKEN"),
  get("Gradebook (batch B)", "/api/classrooms/{{BATCH_ID_2}}/gradebook",
      status(200) + "\n" + J + "\n" + has('assignment column + 2 learner rows', "pm.expect(j.data.columns).to.have.length(1); pm.expect(j.data.columns[0]).to.include({type: 'assignment', name: 'Build a line-follower', max: 50}); pm.expect(j.data.rows).to.have.length(2)") + "\n" +
      has('scored learner has 45/50 = 90%', "const key = 'assignment:' + pm.environment.get('ASSIGNMENT_ID'); const row = j.data.rows.find(r => r.learner_id === pm.environment.get('LEARNER_ID')); pm.expect(row.cells[key]).to.include({score: 45, max: 50, pct: 90}); pm.expect(row.summary).to.include({scored: 1, average_pct: 90, performance: 'excellent'})") + "\n" +
      has('unscored learner has an empty row', "const row = j.data.rows.find(r => r.learner_id === pm.environment.get('LEARNER_ID_2')); pm.expect(Object.keys(row.cells)).to.have.length(0); pm.expect(row.summary.scored).to.eql(0)") + "\n" +
      has('batch summary', "pm.expect(j.data.batch_summary).to.include({learners: 2, items: 1, average_pct: 90})")),
]))

folders.append(("9 · Badges, XP & leaderboard", [
  req("Create badge", "POST", "/api/gamification/badges", {"name": "Robot Builder", "description": "Built a working robot", "category": "Robotics", "xp_reward": 20, "criteria": "Finish the line-follower project"},
      tests=status(201) + "\n" + J + "\n" + setv("BADGE_ID", "j.data.id")),
  req("Duplicate badge name is rejected", "POST", "/api/gamification/badges", {"name": "Robot Builder"}, tests=status(409) + "\n" + J + "\n" + has('duplicate code', "pm.expect(j.error.code).to.eql('DUPLICATE_BADGE')")),
  get("Badge catalogue", "/api/gamification/badges", status(200) + "\n" + J + "\n" + has('badge listed, nobody has it yet', "const b = j.data.find(x => x.id === pm.environment.get('BADGE_ID')); pm.expect(b).to.include({name: 'Robot Builder', xp_reward: 20, awarded: 0, status: 'active'})")),
  req("Teacher awards the badge", "POST", "/api/gamification/badges/{{BADGE_ID}}/award", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"], "reason": "Line-follower works"},
      tests=status(201) + "\n" + J + "\n" + has('awarded once, XP reward granted', "pm.expect(j.data).to.include({awarded: 1, already_has: 0, xp_granted: 20}); pm.expect(j.data.badge.id).to.eql(pm.environment.get('BADGE_ID'))"), token_var="TEACHER_TOKEN"),
  req("Awarding again is idempotent", "POST", "/api/gamification/badges/{{BADGE_ID}}/award", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"]},
      tests=status(201) + "\n" + J + "\n" + has('already has it, no extra XP', "pm.expect(j.data).to.include({awarded: 0, already_has: 1, xp_granted: 0})"), token_var="TEACHER_TOKEN"),
  req("Give XP to one learner (single)", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"], "points": 30, "reason": "Class participation", "request_id": "{{XP_REQUEST_ID}}"},
      pre="pm.environment.set('XP_REQUEST_ID', pm.variables.replaceIn('{{$guid}}'));",
      tests=status(201) + "\n" + J + "\n" + has('awarded to 1 learner', "pm.expect(j.data).to.include({awarded: 1, duplicate: 0, learners: 1})"), token_var="TEACHER_TOKEN"),
  req("Retrying the same request_id changes nothing", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"], "points": 30, "reason": "Class participation", "request_id": "{{XP_REQUEST_ID}}"},
      tests=status(201) + "\n" + J + "\n" + has('counted as duplicate', "pm.expect(j.data).to.include({awarded: 0, duplicate: 1})"), token_var="TEACHER_TOKEN"),
  req("Give XP to several learners at once (bulk)", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}", "{{LEARNER_ID_2}}"], "points": 10, "reason": "Team challenge"},
      tests=status(201) + "\n" + J + "\n" + has('awarded to both', "pm.expect(j.data).to.include({awarded: 2, duplicate: 0, learners: 2})"), token_var="TEACHER_TOKEN"),
  req("Teacher cannot deduct XP", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"], "points": -5, "reason": "Correction"},
      tests=status(400) + "\n" + J + "\n" + has('positive numbers only', "pm.expect(j.error.details[0].field).to.eql('points')"), token_var="TEACHER_TOKEN"),
  req("Teacher award capped at 500 XP", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"], "points": 501, "reason": "Too much"},
      tests=status(400) + "\n" + J + "\n" + has('maximum 500', "pm.expect(j.error.message).to.include('500')"), token_var="TEACHER_TOKEN"),
  req("Cannot award a learner outside the batch", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID}}", "learner_ids": ["{{LEARNER_ID}}"], "points": 5, "reason": "Not in batch A anymore"},
      tests=status(400) + "\n" + J + "\n" + has('not an active member', "pm.expect(j.error.message).to.include('not active members')"), token_var="TEACHER_TOKEN"),
  get("Learner XP total, level and badge count", "/api/gamification/overview?learner_id={{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('20 (badge) + 30 + 10 = 60 XP, 1 badge', "pm.expect(j.data).to.include({xp: 60, badges: 1}); pm.expect(j.data.xp_last_7_days).to.eql(60); pm.expect(j.data.learner.id).to.eql(pm.environment.get('LEARNER_ID'))")),
  get("XP ledger", "/api/gamification/xp?learner_id={{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('three ledger rows, balance 60', "pm.expect(j.meta.balance).to.eql(60); pm.expect(j.data.map(x => x.points).sort((a, b) => a - b)).to.eql([10, 20, 30]); pm.expect(j.data.map(x => x.reason)).to.include('Badge: Robot Builder')")),
  get("Other learner has only the bulk XP", "/api/gamification/overview?learner_id={{LEARNER_ID_2}}", status(200) + "\n" + J + "\n" + has('10 XP, no badge', "pm.expect(j.data).to.include({xp: 10, badges: 0})")),
  get("Leaderboard is off by default", "/api/gamification/leaderboard?scope=batch&id={{BATCH_ID_2}}",
      status(403) + "\n" + J + "\n" + has('switched off', "pm.expect(j.error.code).to.eql('LEADERBOARD_DISABLED')")),
  req("Admin switches the leaderboard on", "PUT", "/api/gamification/settings", {"leaderboard_enabled": True}, tests=status(200) + "\n" + J + "\n" + has('enabled', "pm.expect(j.data.leaderboard_enabled).to.eql(true)")),
  get("Batch leaderboard", "/api/gamification/leaderboard?scope=batch&id={{BATCH_ID_2}}",
      status(200) + "\n" + J + "\n" + has('ranked by XP', "pm.expect(j.data).to.have.length(2); pm.expect(j.data[0]).to.include({rank: 1, learner_id: pm.environment.get('LEARNER_ID'), xp: 60, badges: 1}); pm.expect(j.data[1]).to.include({rank: 2, learner_id: pm.environment.get('LEARNER_ID_2'), xp: 10})")),
  get("Learner's own leaderboard marks them", "/api/gamification/leaderboard?scope=batch&id={{BATCH_ID_2}}",
      status(200) + "\n" + J + "\n" + has('is_me flag set on the learner only', "pm.expect(j.data.filter(r => r.is_me).map(r => r.learner_id)).to.eql([pm.environment.get('LEARNER_ID')])"), token_var="LEARNER_TOKEN"),
  get("Achievement wall", "/api/gamification/achievements?learner_id={{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('badge with awarder and reason', "pm.expect(j.data).to.have.length(1); pm.expect(j.data[0]).to.include({name: 'Robot Builder', reason: 'Line-follower works', xp_awarded: 20, awarded_by: 'Priya Raman'})")),
]))

folders.append(("10 · Learner 360 after scores, XP & badges", [
  get("Get learner profile again (Learner 360)", "/api/learners/{{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('still one master profile in batch B', "pm.expect(j.data.id).to.eql(pm.environment.get('LEARNER_ID')); pm.expect(j.data.stats.active_batches).to.eql(1); pm.expect(j.data.has_login).to.eql(true)") + "\n" + has('login shown without secrets', "pm.expect(j.data.login.email).to.eql(pm.environment.get('LEARNER_EMAIL')); pm.expect(JSON.stringify(j.data)).to.not.include('password')")),
  get("Learner 360: scores", "/api/scores?learner_id={{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('score 45/50 and summary', "pm.expect(j.data[0]).to.include({score: 45, max_score: 50, pct: 90, band: 'excellent'}); pm.expect(j.meta.summary).to.include({scored: 1, total: 45, max_total: 50, average_pct: 90})")),
  get("Learner 360: XP and badges", "/api/gamification/overview?learner_id={{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('60 XP and 1 badge', "pm.expect(j.data).to.include({xp: 60, badges: 1})")),
  get("Learner 360: timeline shows the milestones", "/api/learners/{{LEARNER_ID}}/timeline?page_size=100",
      status(200) + "\n" + J + "\n" + has('submission, evaluation, score change and badge are recorded', "const t = j.data.map(e => e.type); ['assignment.posted', 'assignment.submitted', 'assignment.evaluated', 'score.recorded', 'score.updated', 'badge.awarded', 'batch.joined'].forEach(x => pm.expect(t, x).to.include(x))")),
  get("Learner can read their own profile", "/api/learners/{{LEARNER_ID}}", status(200) + "\n" + J + "\n" + has('own profile', "pm.expect(j.data.id).to.eql(pm.environment.get('LEARNER_ID'))"), token_var="LEARNER_TOKEN"),
]))

folders.append(("11 · Attendance", [
  req("Create a class session", "POST", "/api/classrooms/{{BATCH_ID_2}}/sessions", {"title": "Intro class", "starts_at": "{{SESSION_START}}", "ends_at": "{{SESSION_END}}", "meeting_url": "https://meet.google.com/pm-demo-room"},
      pre="const d = new Date(Date.now() - 86400000); d.setUTCHours(5, 30, 0, 0); pm.environment.set('SESSION_START', d.toISOString()); d.setUTCHours(7, 30, 0, 0); pm.environment.set('SESSION_END', d.toISOString());",
      tests=status(201) + "\n" + J + "\n" + setv("SESSION_ID", "j.data.id")),
  req("Same start time is a conflict", "POST", "/api/classrooms/{{BATCH_ID_2}}/sessions", {"title": "Clash", "starts_at": "{{SESSION_START}}"}, tests=status(409) + "\n" + J + "\n" + has('duplicate session', "pm.expect(j.error.code).to.eql('DUPLICATE_SESSION')")),
  req("Generate sessions from the batch schedule (next 14 days)", "POST", "/api/classrooms/{{BATCH_ID_2}}/sessions/generate", {"from": "{{GEN_FROM}}", "to": "{{GEN_TO}}"},
      pre="const f = new Date(); const t = new Date(Date.now() + 13 * 86400000); pm.environment.set('GEN_FROM', f.toISOString().slice(0, 10)); pm.environment.set('GEN_TO', t.toISOString().slice(0, 10));",
      tests=status(201) + "\n" + J + "\n" + has('2 Saturdays in 14 days', "pm.expect(j.data.created).to.eql(2); pm.expect(j.data.skipped).to.eql(0)") + "\n" + setv("GENERATED_COUNT", "j.data.created")),
  req("Generating again is safe (nothing duplicated)", "POST", "/api/classrooms/{{BATCH_ID_2}}/sessions/generate", {"from": "{{GEN_FROM}}", "to": "{{GEN_TO}}"},
      tests=status(200) + "\n" + J + "\n" + has('all skipped', "pm.expect(j.data).to.eql({created: 0, skipped: 2})")),
  get("List sessions", "/api/classrooms/{{BATCH_ID_2}}/sessions",
      status(200) + "\n" + J + "\n" + has('1 manual + 2 generated', "pm.expect(j.data).to.have.length(3); pm.expect(j.meta.can_manage).to.eql(true); const s = j.data.find(x => x.id === pm.environment.get('SESSION_ID')); pm.expect(s).to.include({title: 'Intro class', status: 'scheduled', marked: 0})")),
  get("Attendance sheet (roster)", "/api/classrooms/{{BATCH_ID_2}}/sessions/{{SESSION_ID}}/attendance",
      status(200) + "\n" + J + "\n" + has('both active learners, unmarked', "pm.expect(j.data.rows.map(r => r.learner_id).sort()).to.eql([pm.environment.get('LEARNER_ID'), pm.environment.get('LEARNER_ID_2')].sort()); pm.expect(j.data.rows.every(r => r.status === null)).to.eql(true)")),
  req("Mark attendance (present / absent)", "PUT", "/api/classrooms/{{BATCH_ID_2}}/sessions/{{SESSION_ID}}/attendance", {"entries": [{"learner_id": "{{LEARNER_ID}}", "status": "present"}, {"learner_id": "{{LEARNER_ID_2}}", "status": "absent", "note": "Sick"}]},
      tests=status(200) + "\n" + J + "\n" + has('2 marked, absence notified', "pm.expect(j.data).to.include({marked: 2, changed: 0, unchanged: 0, notified_absent: 1})")),
  req("Correct a mark (absent → late)", "PUT", "/api/classrooms/{{BATCH_ID_2}}/sessions/{{SESSION_ID}}/attendance", {"entries": [{"learner_id": "{{LEARNER_ID_2}}", "status": "late"}]},
      tests=status(200) + "\n" + J + "\n" + has('one changed', "pm.expect(j.data).to.include({marked: 0, changed: 1})")),
  req("Cannot mark someone who is not in the batch", "PUT", "/api/classrooms/{{BATCH_ID_2}}/sessions/{{SESSION_ID}}/attendance", {"entries": [{"learner_id": "00000000-0000-4000-8000-000000000000", "status": "present"}]},
      tests=status(400) + "\n" + J + "\n" + has('rejected', "pm.expect(j.error.message).to.include('not active members')")),
  get("Session is completed after marking", "/api/classrooms/{{BATCH_ID_2}}/sessions?status=completed",
      status(200) + "\n" + J + "\n" + has('the marked session', "pm.expect(j.data.map(s => s.id)).to.eql([pm.environment.get('SESSION_ID')]); pm.expect(j.data[0].marked).to.eql(2)")),
  get("Batch attendance report", "/api/classrooms/{{BATCH_ID_2}}/attendance/report",
      status(200) + "\n" + J + "\n" + has('present and late both count as attended', "const a = j.data.learners.find(l => l.learner_id === pm.environment.get('LEARNER_ID')); const b = j.data.learners.find(l => l.learner_id === pm.environment.get('LEARNER_ID_2')); pm.expect(a).to.include({present: 1, absent: 0, pct: 100}); pm.expect(b).to.include({late: 1, absent: 0, pct: 100}); pm.expect(j.data.batch_pct).to.eql(100); pm.expect(j.data.low_count).to.eql(0)")),
  get("Learner attendance summary", "/api/attendance/summary?learner_id={{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('one batch, 1 present, 100%', "pm.expect(j.data.batches).to.have.length(1); pm.expect(j.data.batches[0]).to.include({batch_id: pm.environment.get('BATCH_ID_2'), present: 1, pct: 100}); pm.expect(j.data.overall).to.include({present: 1, absent: 0, pct: 100})")),
  get("Learner sees their own attendance", "/api/attendance/summary",
      status(200) + "\n" + J + "\n" + has('own summary', "pm.expect(j.data.learner_id).to.eql(pm.environment.get('LEARNER_ID')); pm.expect(j.data.overall.present).to.eql(1)"), token_var="LEARNER_TOKEN"),
]))

folders.append(("12 · CRM", [
  req("Create lead for the learner", "POST", "/api/crm/leads", {"learner_id": "{{LEARNER_ID}}", "lead_source": "Website", "lead_status": "new", "temperature": "warm", "interested_course_id": "{{COURSE_ID}}", "notes": "Parent asked about the advanced track."},
      tests=status(201) + "\n" + J + "\n" + has('lead created for the learner', "pm.expect(j.data.learner_id).to.eql(pm.environment.get('LEARNER_ID'))")),
  req("Same learner cannot become a second lead", "POST", "/api/crm/leads", {"learner_id": "{{LEARNER_ID}}"}, tests=status(400) + "\n" + J + "\n" + has('already in CRM', "pm.expect(j.error.message).to.include('already in the CRM')")),
  req("Log an activity with a next follow-up", "POST", "/api/crm/learners/{{LEARNER_ID}}/activities", {"type": "called_parent", "description": "Spoke to the father; interested in the advanced track.", "next_follow_up_at": "{{FOLLOW_UP_AT}}"},
      pre="pm.environment.set('FOLLOW_UP_AT', new Date(Date.now() + 3 * 86400000).toISOString());",
      tests=status(201) + "\n" + J + "\n" + setv("FOLLOW_UP_ID", "j.data.follow_up_id") + "\n" + has('activity and follow-up created', "pm.expect(j.data.id).to.be.a('string'); pm.expect(j.data.follow_up_id).to.be.a('string')")),
  req("Past follow-up time is rejected", "POST", "/api/crm/learners/{{LEARNER_ID}}/follow-ups", {"due_at": "2020-01-01T10:00:00.000Z", "note": "Too late"}, tests=status(400) + "\n" + J + "\n" + has('must be in the future', "pm.expect(j.error.details[0].field).to.eql('due_at')")),
  req("Schedule a separate follow-up", "POST", "/api/crm/learners/{{LEARNER_ID}}/follow-ups", {"due_at": "{{FOLLOW_UP_AT_2}}", "note": "Send the fee structure"},
      pre="pm.environment.set('FOLLOW_UP_AT_2', new Date(Date.now() + 5 * 86400000).toISOString());",
      tests=status(201) + "\n" + J + "\n" + setv("FOLLOW_UP_ID_2", "j.data.id")),
  get("Learner CRM view", "/api/crm/learners/{{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('lead, activities and 2 open follow-ups', "pm.expect(j.data.lead).to.include({lead_status: 'new', lead_source: 'Website', temperature: 'warm'}); pm.expect(j.data.activities.map(a => a.type)).to.include('called_parent'); pm.expect(j.data.follow_ups.filter(f => f.status === 'open')).to.have.length(2)") + "\n" + has('lead shows the earliest follow-up', "pm.expect(j.data.lead.next_follow_up_at).to.not.eql(null)")),
  get("Upcoming follow-ups (all staff)", "/api/crm/follow-ups?who=all&bucket=upcoming",
      status(200) + "\n" + J + "\n" + has('both follow-ups listed, not overdue', "const ids = j.data.map(f => f.id); pm.expect(ids).to.include(pm.environment.get('FOLLOW_UP_ID')); pm.expect(ids).to.include(pm.environment.get('FOLLOW_UP_ID_2')); pm.expect(j.data.every(f => f.overdue === false)).to.eql(true)")),
  req("Complete a follow-up and schedule the next", "POST", "/api/crm/follow-ups/{{FOLLOW_UP_ID}}/complete", {"outcome": "Sent the brochure.", "next_follow_up_at": "{{FOLLOW_UP_AT_3}}"},
      pre="pm.environment.set('FOLLOW_UP_AT_3', new Date(Date.now() + 8 * 86400000).toISOString());",
      tests=status(200) + "\n" + J + "\n" + has('done, next one created', "pm.expect(j.data.id).to.eql(pm.environment.get('FOLLOW_UP_ID')); pm.expect(j.data.next_follow_up_id).to.be.a('string')")),
  req("Completing it twice is refused", "POST", "/api/crm/follow-ups/{{FOLLOW_UP_ID}}/complete", {}, tests=status(400) + "\n" + J + "\n" + has('already closed', "pm.expect(j.error.message).to.include('already closed')")),
  req("Move the lead to interested", "PATCH", "/api/crm/leads/{{LEARNER_ID}}", {"lead_status": "interested", "temperature": "hot"}, tests=status(200) + "\n" + J + "\n" + has('updated', "pm.expect(j.data.learner_id).to.eql(pm.environment.get('LEARNER_ID'))")),
  req("A lost lead needs a reason", "PATCH", "/api/crm/leads/{{LEARNER_ID}}", {"lead_status": "lost"}, tests=status(400) + "\n" + J + "\n" + has('reason required', "pm.expect(j.error.details[0].field).to.eql('lost_reason')")),
  get("CRM summary", "/api/crm/summary", status(200) + "\n" + J + "\n" + has('one interested lead, open follow-ups', "pm.expect(j.data.total).to.eql(1); pm.expect(j.data.status.interested).to.eql(1); pm.expect(j.data.follow_ups.mine_open).to.be.at.least(2)")),
  get("Pipeline list", "/api/crm/leads?status=interested",
      status(200) + "\n" + J + "\n" + has('learner in the pipeline', "pm.expect(j.data.map(l => l.learner_id)).to.include(pm.environment.get('LEARNER_ID'))")),
  get("Status change is logged in the CRM view", "/api/crm/learners/{{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('status change logged', "pm.expect(j.data.activities.map(a => a.type)).to.include('status_changed')")),
]))

WA_NOTE = ("Needs a live provider: with AISENSY_API_KEY set on the server AND the comms worker running (COMMS_WORKER=true) the confirmed campaign moves to processing and then completed/partially_failed, and "
           "recipients reach 'sent'. This collection runs without a provider, so it asserts only what is deterministic offline: audience preview, draft/validation behaviour, "
           "409 NOT_CONFIGURED on confirm, and webhook authentication/idempotency. When the server IS configured, the confirm/status steps adapt (WA_CONFIGURED=true) and assert 'processing' instead. "
           "There is no admin 'process now' endpoint: sending is done only by the background worker. The webhook step needs AISENSY_WEBHOOK_SECRET set on the server and the same value in this environment.")
folders.append(("13 · WhatsApp campaign", [
  get("WhatsApp status (no secrets exposed)", "/api/whatsapp/status",
      status(200) + "\n" + J + "\n" + setv("WA_CONFIGURED", "String(j.data.configured)") + "\n" + has('booleans only, tokens listed', "pm.expect(j.data.configured).to.be.a('boolean'); pm.expect(j.data.webhook_configured).to.be.a('boolean'); pm.expect(j.data.tokens).to.include('parent_name')") + "\n" +
      has('no secret values in the response', "const s = pm.environment.get('AISENSY_WEBHOOK_SECRET'); if (s) pm.expect(pm.response.text()).to.not.include(s)"),
      desc=WA_NOTE),
  req("Create message template", "POST", "/api/whatsapp/templates", {"name": "Class reminder", "aisensy_campaign_name": "class_reminder_v1", "use_case": "class_reminder", "body_preview": "Hi {{1}}, a class for {{2}} is coming up.", "variable_names": ["Parent", "Learner"]},
      tests=status(201) + "\n" + J + "\n" + setv("TEMPLATE_ID", "j.data.id")),
  req("Duplicate template name is rejected", "POST", "/api/whatsapp/templates", {"name": "Class reminder", "aisensy_campaign_name": "other", "use_case": "welcome"}, tests=status(409) + "\n" + J + "\n" + has('duplicate', "pm.expect(j.error.code).to.eql('DUPLICATE')")),
  req("Campaign with the wrong number of values is rejected", "POST", "/api/whatsapp/campaigns", {"name": "Bad", "template_id": "{{TEMPLATE_ID}}", "audience": "parents", "selector": {"batch_ids": ["{{BATCH_ID}}"]}, "variables": ["only one"]},
      tests=status(400) + "\n" + J + "\n" + has('needs 2 values', "pm.expect(j.error.message).to.include('needs 2 values')")),
  req("Create campaign draft for batches A + B", "POST", "/api/whatsapp/campaigns", {"name": "Class reminder run {{RUN_ID}}", "template_id": "{{TEMPLATE_ID}}", "audience": "parents", "selector": {"batch_ids": ["{{BATCH_ID}}", "{{BATCH_ID_2}}"]}, "variables": ["{parent_name}", "{learner_name}"]},
      tests=status(201) + "\n" + J + "\n" + setv("CAMPAIGN_ID", "j.data.id")),
  req("Dry-run the audience (preview, nothing is sent)", "POST", "/api/whatsapp/campaigns/{{CAMPAIGN_ID}}/preview", {},
      desc="Shows exactly who would be messaged. Meera is in both batches and counts once.",
      tests=status(200) + "\n" + J + "\n" + has('2 batches, 3 memberships, 2 unique learners, 1 duplicate removed', "pm.expect(j.data).to.include({selected_batches: 2, batch_memberships: 3, unique_learners: 2, duplicates_removed: 1})") + "\n" +
      has('both parents reachable, nobody skipped', "pm.expect(j.data).to.include({with_phone: 2, no_phone: 0, opted_out: 0, shared_phone_merged: 0, recipients: 2}); pm.expect(j.data.status).to.eql('draft')") + "\n" +
      has('sample is personalised and the phone is masked', "pm.expect(j.data.sample).to.have.length(2); pm.expect(j.data.sample.map(s => s.params[0]).sort()).to.eql(['Anil Nair', 'Sunil Kumar']); pm.expect(j.data.sample[0].phone).to.include('•')") + "\n" +
      has('readiness follows the provider config', "pm.expect(j.data.configured).to.eql(pm.environment.get('WA_CONFIGURED') === 'true'); pm.expect(j.data.ready).to.eql(j.data.configured)")),
  get("Draft is still a draft with no recipients", "/api/whatsapp/campaigns/{{CAMPAIGN_ID}}/recipients", status(200) + "\n" + J + "\n" + has('preview wrote no snapshot', "pm.expect(j.meta.total).to.eql(0)")),
  req("Confirm without the audience count is refused", "POST", "/api/whatsapp/campaigns/{{CAMPAIGN_ID}}/confirm", {"confirm": True}, tests=status(400) + "\n" + J + "\n" + has('validation error', "pm.expect(j.ok).to.eql(false)")),
  req("Confirm the campaign (2 recipients)", "POST", "/api/whatsapp/campaigns/{{CAMPAIGN_ID}}/confirm", {"confirm": True, "expected_recipients": 2},
      desc="Without a provider the server answers 409 NOT_CONFIGURED and the campaign stays a draft. With a provider it freezes the audience and starts processing.",
      tests=J + "\nif (pm.environment.get('WA_CONFIGURED') === 'true') {\n  pm.test('status is 200', () => pm.response.to.have.status(200));\n  pm.test('processing with 2 recipients', () => pm.expect(j.data).to.include({status: 'processing', recipients: 2, unique_learners: 2, duplicates_removed: 1}));\n} else {\n  pm.test('status is 409', () => pm.response.to.have.status(409));\n  pm.test('refuses clearly when WhatsApp is not connected', () => { pm.expect(j.error.code).to.eql('NOT_CONFIGURED'); pm.expect(j.error.message).to.include('not connected'); });\n}"),
  get("Campaign status", "/api/whatsapp/campaigns/{{CAMPAIGN_ID}}",
      status(200) + "\n" + J + "\nconst live = pm.environment.get('WA_CONFIGURED') === 'true';\n" +
      has('status and counts match the provider state', "if (live) { pm.expect(['processing', 'completed', 'partially_failed', 'failed']).to.include(j.data.status); pm.expect(j.data.counts.total).to.eql(2); } else { pm.expect(j.data.status).to.eql('draft'); pm.expect(j.data.counts.total).to.eql(0); }") + "\n" +
      has('campaign details', "pm.expect(j.data.name).to.include('Class reminder run'); pm.expect(j.data.audience).to.eql('parents'); pm.expect(j.data.selector.batch_ids).to.have.length(2)")),
  get("Campaign list", "/api/whatsapp/campaigns", status(200) + "\n" + J + "\n" + has('campaign listed with template', "const c = j.data.find(x => x.id === pm.environment.get('CAMPAIGN_ID')); pm.expect(c.template_name).to.eql('Class reminder')")),
  req("AiSensy webhook: delivery status accepted", "POST", "/api/webhooks/aisensy/{{AISENSY_WEBHOOK_SECRET}}", {"event_id": "pm-{{RUN_ID}}-evt-1", "topic": "message.status.update", "data": {"message": {"id": "wamid.PM{{RUN_ID}}", "status": "delivered"}}}, auth=False, org=False,
      desc="Public endpoint guarded by the secret in the URL. The message id does not belong to any recipient of this run (no provider has sent anything), so the event is stored and reported as unmatched; with a live provider you would post a real provider message id and see applied=1.",
      tests=status(200) + "\n" + J + "\n" + has('one event received, stored, unmatched', "pm.expect(j.ok).to.eql(true); pm.expect(j.data).to.include({received: 1, applied: 0, unmatched: 1, duplicate: 0})")),
  req("Same webhook event again is a duplicate", "POST", "/api/webhooks/aisensy/{{AISENSY_WEBHOOK_SECRET}}", {"event_id": "pm-{{RUN_ID}}-evt-1", "topic": "message.status.update", "data": {"message": {"id": "wamid.PM{{RUN_ID}}", "status": "delivered"}}}, auth=False, org=False,
      tests=status(200) + "\n" + J + "\n" + has('idempotent', "pm.expect(j.data).to.include({received: 1, duplicate: 1, applied: 0})")),
  req("Webhook payload without a status is ignored", "POST", "/api/webhooks/aisensy/{{AISENSY_WEBHOOK_SECRET}}", {"event_id": "pm-{{RUN_ID}}-evt-2", "hello": "world"}, auth=False, org=False,
      tests=status(200) + "\n" + J + "\n" + has('stored as ignored, never guessed', "pm.expect(j.data).to.include({received: 1, ignored: 1, applied: 0})")),
  get("Messages sent to the learner's family", "/api/whatsapp/learners/{{LEARNER_ID}}/messages", status(200) + "\n" + J + "\n" + has('list (empty until a provider sends)', "pm.expect(j.data).to.be.an('array'); if (pm.environment.get('WA_CONFIGURED') !== 'true') pm.expect(j.data).to.have.length(0)")),
]))
folders[-1][1][0]["request"]["description"] = WA_NOTE

folders.append(("14 · Analytics, reports & system status", [
  get("Reports available to the admin", "/api/reports",
      status(200) + "\n" + J + "\n" + has('all report types offered', "const ids = j.data.map(r => r.id); ['learner', 'batch', 'teacher', 'attendance', 'score', 'achievement', 'xp', 'crm', 'communication'].forEach(x => pm.expect(ids, x).to.include(x)); pm.expect(j.data[0].columns).to.be.an('array')")),
  get("Run the score report for batch B", "/api/reports/score?batch_id={{BATCH_ID_2}}",
      status(200) + "\n" + J + "\n" + has('the evaluated assignment is a row', "pm.expect(j.data.id).to.eql('score'); pm.expect(j.data.truncated).to.eql(false); pm.expect(j.data.rows).to.have.length(1); pm.expect(j.data.rows[0]).to.include({name: 'Rahul Kumar', type: 'assignment', activity: 'Build a line-follower', score: 45, max: 50, pct: 90, scored_by: 'Priya Raman'})")),
  get("Batch analytics (batch B)", "/api/analytics/batch/{{BATCH_ID_2}}",
      status(200) + "\n" + J + "\n" + has('metrics reflect this run', "const m = j.data.metrics; pm.expect(m.learners_active).to.eql(2); pm.expect(m.scores).to.include({scored: 1, avg_pct: 90}); pm.expect(m.attendance.present).to.eql(1); pm.expect(m.attendance.late).to.eql(1); pm.expect(m.assignments.total).to.eql(1); pm.expect(m.assignments.handed_in).to.eql(1); pm.expect(m.xp.net).to.eql(70); pm.expect(m.badges).to.eql(1); pm.expect(j.data.teachers[0].role).to.eql('lead')")),
  get("Compare batches A and B", "/api/analytics/compare?batch_ids={{BATCH_ID}},{{BATCH_ID_2}}",
      status(200) + "\n" + J + "\n" + has('two batches, each with metrics', "pm.expect(j.data).to.have.length(2); const a = j.data.find(b => b.id === pm.environment.get('BATCH_ID')); const b = j.data.find(b => b.id === pm.environment.get('BATCH_ID_2')); pm.expect(a.metrics.learners_active).to.eql(1); pm.expect(b.metrics.learners_active).to.eql(2); pm.expect(a.metrics.scores.scored).to.eql(0); pm.expect(b.metrics.scores.avg_pct).to.eql(90)")),
  get("Comparing a single batch is refused", "/api/analytics/compare?batch_ids={{BATCH_ID}}", status(400) + "\n" + J + "\n" + has('needs 2 to 10', "pm.expect(j.error.message).to.include('between 2 and 10')")),
  get("System status (org admin)", "/api/system/status",
      status(200) + "\n" + J + "\n" + has('app, database and migrations healthy', "pm.expect(j.data.database.reachable).to.eql(true); pm.expect(j.data.migrations.pending).to.eql([]); pm.expect(j.data.migrations.applied).to.eql(j.data.migrations.available); pm.expect(j.data.app.version).to.be.a('string')") + "\n" +
      has('integrity checks all pass for this org', "pm.expect(j.data.integrity_ok).to.eql(true); pm.expect(j.data.integrity.length).to.be.at.least(8); j.data.integrity.forEach(c => pm.expect(c.count, c.id).to.eql(0))") + "\n" +
      has('whatsapp section has flags, not secrets', "pm.expect(j.data.whatsapp.configured).to.be.a('boolean'); pm.expect(JSON.stringify(j.data)).to.not.include('AISENSY_API_KEY=')")),
  get("Readiness probe (public)", "/api/health/ready", status(200) + "\n" + J + "\n" + has('ready, database + migrations', "pm.expect(j.data.status).to.eql('ready'); pm.expect(j.data.checks).to.eql({database: true, migrations: true})"), auth=False, org=False),
]))

folders.append(("15 · Negative & security checks", [
  get("Teacher cannot open system status", "/api/system/status", status(403) + "\n" + J + "\n" + has('forbidden envelope', "pm.expect(j.ok).to.eql(false); pm.expect(j.error.code).to.be.a('string')"), token_var="TEACHER_TOKEN"),
  get("Learner cannot open system status", "/api/system/status", status(403), token_var="LEARNER_TOKEN"),
  get("Teacher cannot use WhatsApp", "/api/whatsapp/campaigns", status(403), token_var="TEACHER_TOKEN"),
  get("Learner cannot read the CRM", "/api/crm/leads", status(403), token_var="LEARNER_TOKEN"),
  get("Learner cannot see another learner's profile (404)", "/api/learners/{{LEARNER_ID_2}}",
      status(404) + "\n" + J + "\n" + has('existence is not revealed', "pm.expect(j.error.code).to.eql('NOT_FOUND'); pm.expect(pm.response.text()).to.not.include('Meera')"), token_var="LEARNER_TOKEN"),
  get("Learner cannot see another learner's scores", "/api/scores?learner_id={{LEARNER_ID_2}}", status(404), token_var="LEARNER_TOKEN"),
  get("Learner cannot see another learner's XP", "/api/gamification/overview?learner_id={{LEARNER_ID_2}}", status(404), token_var="LEARNER_TOKEN"),
  req("Learner cannot evaluate their own work", "POST", "/api/submissions/{{SUBMISSION_ID}}/review", {"action": "evaluate", "score": 50}, tests=status(404) + "\n" + J + "\n" + has('not found for non-managers', "pm.expect(j.error.code).to.eql('NOT_FOUND')"), token_var="LEARNER_TOKEN"),
  req("Learner cannot award XP", "POST", "/api/gamification/xp", {"batch_id": "{{BATCH_ID_2}}", "learner_ids": ["{{LEARNER_ID}}"], "points": 100, "reason": "Self award"}, tests=status(403), token_var="LEARNER_TOKEN"),
  get("Score is unchanged after all attempts", "/api/scores?learner_id={{LEARNER_ID}}", status(200) + "\n" + J + "\n" + has('still 45/50', "pm.expect(j.data[0]).to.include({score: 45, max_score: 50})")),
  get("Gradebook requires a token", "/api/classrooms/{{BATCH_ID_2}}/gradebook", status(401), auth=False),
  req("Webhook with the wrong secret is rejected", "POST", "/api/webhooks/aisensy/not-the-secret-0000000000", {"event_id": "pm-{{RUN_ID}}-bad", "data": {"message": {"id": "wamid.X", "status": "delivered"}}}, auth=False, org=False,
      tests=status(404) + "\n" + J + "\n" + has('looks like any unknown route', "pm.expect(j.ok).to.eql(false); pm.expect(j.error.code).to.eql('NOT_FOUND')")),
  req("Webhook with an empty-ish secret is rejected", "POST", "/api/webhooks/aisensy/x", {"status": "delivered"}, auth=False, org=False, tests=status(404)),
]))


# ---------------------------------------------------------------------------------------------
# Phases 10-13: fees & payments, automatic reminders, CSV import, live classes, branding,
# certificates, calendar feeds, password-reset plumbing.
# Assumes folders 0-15 ran: LEARNER_ID (Rahul, batch B, has a portal login), LEARNER_ID_2 (Meera, batches A + B),
# the teacher leads both batches, SESSION_ID is a completed class of batch B, TEMPLATE_ID is an active WhatsApp template.
# Provider-dependent steps (Razorpay, WhatsApp, Zoom, SMTP) read the server's own "configured?" flag and assert the honest
# 'not configured' answer when it is off, or the success shape when it is on. No secret value is ever stored here.
# ---------------------------------------------------------------------------------------------
def csv_req(name, path, csv_lines, tests=None, pre=None, desc=None):
    it = req(name, "POST", path, tests=tests, pre=pre, desc=desc)
    it["request"]["header"] = [{"key": "Content-Type", "value": "text/csv"}] + [h for h in it["request"]["header"] if h["key"] != "Content-Type"]
    it["request"]["body"] = {"mode": "raw", "raw": "\n".join(csv_lines), "options": {"raw": {"language": "text"}}}
    return it
def num(path): return f"Number({path})"
PDF = "pm.test('is a PDF', () => { pm.expect(pm.response.headers.get('Content-Type')).to.include('application/pdf'); pm.expect(pm.response.text().slice(0, 4)).to.eql('%PDF'); });"

folders.append(("16 · Fees & payments", [
  get("Payment configuration (flags only, no secrets)", "/api/fees/status",
      status(200) + "\n" + J + "\n" + setv("PAY_CONFIGURED", "String(j.data.online_payments)") + "\n" +
      has('booleans and the manual methods; no keys', "pm.expect(j.data.online_payments).to.be.a('boolean'); pm.expect(j.data.webhook_configured).to.be.a('boolean'); pm.expect(j.data.methods).to.include.members(['cash', 'upi']); pm.expect(JSON.stringify(j.data)).to.not.match(/secret|key_id/i)")),
  req("Create fee plan (2 installments, Rs 7,000)", "POST", "/api/fees/plans", {"name": "Term fee {{RUN_ID}}", "description": "Admission now, balance after 30 days", "items": [{"label": "Admission", "amount": 4000, "due_days": 0}, {"label": "Second installment", "amount": 3000, "due_days": 30}]},
      tests=status(201) + "\n" + J + "\n" + setv("PLAN_ID", "j.data.id") + "\n" + has('id returned', "pm.expect(j.data.id).to.be.a('string')")),
  req("Duplicate plan name is rejected", "POST", "/api/fees/plans", {"name": "Term fee {{RUN_ID}}", "items": [{"label": "Only", "amount": 100}]}, tests=status(409) + "\n" + J + "\n" + has('duplicate', "pm.expect(j.error.code).to.eql('DUPLICATE')")),
  req("Plan without installments is rejected", "POST", "/api/fees/plans", {"name": "Empty plan {{RUN_ID}}", "items": []}, tests=status(400) + "\n" + J + "\n" + has('items flagged', "pm.expect(j.ok).to.eql(false); pm.expect(JSON.stringify(j.error.details)).to.include('installment')")),
  req("Negative amount is rejected", "POST", "/api/fees/plans", {"name": "Bad plan {{RUN_ID}}", "items": [{"label": "Oops", "amount": -5}]}, tests=status(400)),
  get("List plans", "/api/fees/plans",
      status(200) + "\n" + J + "\n" + has('plan with 2 items, total 7000, not given to anyone yet', "const p = j.data.find(x => x.id === pm.environment.get('PLAN_ID')); pm.expect(Number(p.total_amount)).to.eql(7000); pm.expect(p.items).to.have.length(2); pm.expect(p.learners).to.eql(0); pm.expect(p.status).to.eql('active')")),
  req("Assign without confirmation is refused", "POST", "/api/fees/assign", {"plan_id": "{{PLAN_ID}}", "selector": {"batch_ids": ["{{BATCH_ID_2}}"]}, "start_date": "{{START_DATE}}"},
      pre="pm.environment.set('START_DATE', new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10));",
      tests=status(400) + "\n" + J + "\n" + has('confirmation required', "pm.expect(j.error.code).to.eql('CONFIRMATION_REQUIRED')")),
  req("Assign plan to batch B: dry run (nothing written)", "POST", "/api/fees/assign", {"plan_id": "{{PLAN_ID}}", "selector": {"batch_ids": ["{{BATCH_ID_2}}"]}, "start_date": "{{START_DATE}}", "dry_run": True},
      desc="Start date is 10 days ago, so the first installment (due on the start date) is already overdue and the second is due in 20 days.",
      tests=status(200) + "\n" + J + "\n" + has('2 unique learners would be billed Rs 14,000', "pm.expect(j.data.dry_run).to.eql(true); pm.expect(j.data).to.include({requested: 2, eligible: 2, to_create: 2, installments_each: 2}); pm.expect(Number(j.data.net_each)).to.eql(7000); pm.expect(Number(j.data.total_billed)).to.eql(14000)") + "\n" +
      has('dry run created no fee', "pm.expect(j.data.created || 0).to.eql(0)")),
  req("Assign plan to batch B: confirm", "POST", "/api/fees/assign", {"plan_id": "{{PLAN_ID}}", "selector": {"batch_ids": ["{{BATCH_ID_2}}"]}, "start_date": "{{START_DATE}}", "confirm": True},
      tests=status(201) + "\n" + J + "\n" + has('both learners billed', "pm.expect(j.data.created).to.eql(2); pm.expect(j.data.dry_run).to.eql(false)")),
  req("Assigning again is a no-op (nobody billed twice)", "POST", "/api/fees/assign", {"plan_id": "{{PLAN_ID}}", "selector": {"batch_ids": ["{{BATCH_ID_2}}"]}, "start_date": "{{START_DATE}}", "confirm": True},
      tests=status(201) + "\n" + J + "\n" + has('already assigned', "pm.expect(j.data).to.include({already_assigned: 2, to_create: 0}); pm.expect(j.data.created).to.eql(0)")),
  get("Overdue dues", "/api/fees/dues?status=overdue",
      status(200) + "\n" + J + "\n" + has('first installment of both learners is overdue', "pm.expect(j.meta.total).to.eql(2); pm.expect(j.meta.learners).to.eql(2); pm.expect(Number(j.meta.balance)).to.eql(8000); const r = j.data.find(x => x.learner_id === pm.environment.get('LEARNER_ID')); pm.expect(r.label).to.eql('Admission'); pm.expect(Number(r.balance)).to.eql(4000); pm.expect(r.days_overdue).to.be.at.least(10)") + "\n" +
      setv("INSTALLMENT_ID", "j.data.find(x => x.learner_id === pm.environment.get('LEARNER_ID')).id")),
  get("Upcoming dues", "/api/fees/dues?status=upcoming",
      status(200) + "\n" + J + "\n" + has('second installments are upcoming', "pm.expect(j.meta.total).to.eql(2); pm.expect(Number(j.meta.balance)).to.eql(6000); pm.expect(j.data.every(r => r.label === 'Second installment' && r.days_overdue < 0)).to.eql(true)")),
  get("Dues search by name", "/api/fees/dues?status=all&search=Rahul",
      status(200) + "\n" + J + "\n" + has('only Rahul', "pm.expect(j.data.length).to.be.at.least(1); pm.expect(j.data.every(r => r.full_name === 'Rahul Kumar')).to.eql(true)")),
  req("Record a cash payment of Rs 1,500", "POST", "/api/fees/payments", {"learner_id": "{{LEARNER_ID}}", "amount": 1500, "method": "cash", "reference": "PM-{{RUN_ID}}", "note": "Part payment", "request_id": "{{PAY_REQUEST_ID}}"},
      pre="pm.environment.set('PAY_REQUEST_ID', pm.variables.replaceIn('{{$guid}}'));",
      tests=status(201) + "\n" + J + "\n" + setv("PAYMENT_ID", "j.data.payment.id") + "\n" +
      has('receipt number and one allocation to the oldest installment', "pm.expect(j.data.duplicate).to.eql(false); pm.expect(j.data.payment.receipt_no).to.match(/^PM-RCT-\\d{6}$/); pm.expect(Number(j.data.payment.amount)).to.eql(1500); pm.expect(j.data.allocations).to.have.length(1); pm.expect(j.data.allocations[0].label).to.eql('Admission'); pm.expect(Number(j.data.allocations[0].amount)).to.eql(1500)")),
  req("Retrying the same request_id returns the same payment", "POST", "/api/fees/payments", {"learner_id": "{{LEARNER_ID}}", "amount": 1500, "method": "cash", "request_id": "{{PAY_REQUEST_ID}}"},
      tests=status(200) + "\n" + J + "\n" + has('duplicate, not a second payment', "pm.expect(j.data.duplicate).to.eql(true); pm.expect(j.data.payment.id).to.eql(pm.environment.get('PAYMENT_ID'))")),
  req("Online method cannot be recorded by hand", "POST", "/api/fees/payments", {"learner_id": "{{LEARNER_ID}}", "amount": 100, "method": "online"}, tests=status(400) + "\n" + J + "\n" + has('field named', "pm.expect(j.error.details[0].field).to.eql('method')")),
  req("Paying more than owed is refused", "POST", "/api/fees/payments", {"learner_id": "{{LEARNER_ID}}", "amount": 100000, "method": "cash"}, tests=status(400) + "\n" + J + "\n" + has('amount field flagged', "pm.expect(j.error.details[0].field).to.eql('amount'); pm.expect(j.error.message).to.include('more than the learner owes')")),
  req("Payment dated in the future is refused", "POST", "/api/fees/payments", {"learner_id": "{{LEARNER_ID}}", "amount": 100, "method": "cash", "paid_at": "{{FUTURE_AT}}"},
      pre="pm.environment.set('FUTURE_AT', new Date(Date.now() + 3 * 86400000).toISOString());",
      tests=status(400) + "\n" + J + "\n" + has('paid_at flagged', "pm.expect(j.error.details[0].field).to.eql('paid_at')")),
  get("Learner ledger after the payment", "/api/fees/learners/{{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('billed 7000, paid 1500, outstanding 5500, overdue 2500', "const t = j.data.totals; pm.expect(Number(t.billed)).to.eql(7000); pm.expect(Number(t.paid)).to.eql(1500); pm.expect(Number(t.outstanding)).to.eql(5500); pm.expect(Number(t.overdue)).to.eql(2500); pm.expect(Number(t.credit)).to.eql(0)") + "\n" +
      has('installment statuses', "const i = j.data.fees[0].installments; pm.expect(i.map(x => x.status)).to.eql(['partial', 'pending'])")),
  get("Payment detail", "/api/fees/payments/{{PAYMENT_ID}}", status(200) + "\n" + J + "\n" + has('payment with learner and reference', "pm.expect(j.data.payment.learner_name).to.eql('Rahul Kumar'); pm.expect(j.data.payment.reference).to.include('PM-'); pm.expect(j.data.refunds).to.have.length(0)")),
  get("Payment list search by reference", "/api/fees/payments?search=PM-{{RUN_ID}}",
      status(200) + "\n" + J + "\n" + has('one payment, net 1500', "pm.expect(j.meta.total).to.eql(1); pm.expect(Number(j.meta.net_collected)).to.eql(1500); pm.expect(j.data[0].id).to.eql(pm.environment.get('PAYMENT_ID'))")),
  req("Download receipt (PDF)", "GET", "/api/fees/payments/{{PAYMENT_ID}}/receipt.pdf", tests=status(200) + "\n" + PDF),
  req("Refund more than was paid is refused", "POST", "/api/fees/payments/{{PAYMENT_ID}}/refund", {"amount": 5000, "reason": "Too much"}, tests=status(400) + "\n" + J + "\n" + has('limit stated', "pm.expect(j.error.details[0].field).to.eql('amount'); pm.expect(j.error.message).to.include('at most')")),
  req("Refund Rs 500 of the payment", "POST", "/api/fees/payments/{{PAYMENT_ID}}/refund", {"amount": 500, "reason": "Entered twice"},
      tests=status(201) + "\n" + J + "\n" + has('refund recorded, manual payment has no provider note', "pm.expect(j.data.refund_id).to.be.a('string'); pm.expect(Number(j.data.refunded_amount)).to.eql(500); pm.expect(j.data.provider_note).to.eql(null)")),
  get("Ledger after the refund", "/api/fees/learners/{{LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('paid is now 1000, outstanding 6000', "const t = j.data.totals; pm.expect(Number(t.paid)).to.eql(1000); pm.expect(Number(t.outstanding)).to.eql(6000); pm.expect(j.data.payments[0].status).to.eql('partially_refunded')")),
  req("Change an installment due date (reason required)", "PATCH", "/api/fees/installments/{{INSTALLMENT_ID}}", {"amount": 500, "reason": "Waiver attempt below what is paid"}, tests=status(400) + "\n" + J + "\n" + has('cannot go below what is paid', "pm.expect(j.error.details[0].field).to.eql('amount')")),
  req("Create a payment link (provider dependent)", "POST", "/api/fees/pay-links", {"learner_id": "{{LEARNER_ID}}"},
      desc="Needs Razorpay keys on the server. Without them the server answers 409 NOT_CONFIGURED and nothing is created. With keys it would call Razorpay (use test-mode keys) and return a hosted short_url. The webhook that records the payment needs a signature computed from the server secret, so it is not automated here.",
      tests=J + "\nif (pm.environment.get('PAY_CONFIGURED') === 'true') {\n  pm.test('status is 200 or 201', () => pm.expect([200, 201]).to.include(pm.response.code));\n  pm.test('hosted link returned', () => pm.expect(j.data.short_url).to.be.a('string'));\n} else {\n  pm.test('status is 409', () => pm.response.to.have.status(409));\n  pm.test('honest not-connected answer', () => { pm.expect(j.error.code).to.eql('NOT_CONFIGURED'); pm.expect(j.error.message).to.include('not connected'); });\n}"),
  get("Fee summary", "/api/fees/summary",
      status(200) + "\n" + J + "\n" + has('billed 14000, collected 1000, outstanding 13000', "const d = j.data; pm.expect(Number(d.billed)).to.eql(14000); pm.expect(Number(d.collected)).to.eql(1000); pm.expect(Number(d.outstanding)).to.eql(13000)") + "\n" +
      has('overdue: Rahul 3000 + Meera 4000 across 2 learners', "const d = j.data; pm.expect(Number(d.overdue)).to.eql(7000); pm.expect(d.overdue_installments).to.eql(2); pm.expect(d.overdue_learners).to.eql(2)") + "\n" +
      has('collection rate', "pm.expect(j.data.collection_rate_pct).to.eql(7.1)")),
  get("Learner: my fees", "/api/fees/me",
      status(200) + "\n" + J + "\n" + has('one ledger, own learner only', "pm.expect(j.data).to.have.length(1); pm.expect(j.data[0].learner.id).to.eql(pm.environment.get('LEARNER_ID')); pm.expect(Number(j.data[0].totals.outstanding)).to.eql(6000)"), token_var="LEARNER_TOKEN"),
  req("Learner: own receipt", "GET", "/api/fees/payments/{{PAYMENT_ID}}/receipt.pdf", tests=status(200) + "\n" + PDF, token_var="LEARNER_TOKEN"),
  get("Learner cannot see another learner's ledger (404)", "/api/fees/learners/{{LEARNER_ID_2}}", status(404), token_var="LEARNER_TOKEN"),
  get("Learner cannot list dues", "/api/fees/dues", status(403), token_var="LEARNER_TOKEN"),
  req("Learner cannot record a payment", "POST", "/api/fees/payments", {"learner_id": "{{LEARNER_ID}}", "amount": 10, "method": "cash"}, tests=status(403), token_var="LEARNER_TOKEN"),
  req("Learner cannot refund", "POST", "/api/fees/payments/{{PAYMENT_ID}}/refund", {"amount": 10, "reason": "Nope"}, tests=status(403), token_var="LEARNER_TOKEN"),
  get("Teacher has no fee access", "/api/fees/dues", status(403), token_var="TEACHER_TOKEN"),
  get("Fees require a token", "/api/fees/summary", status(401), auth=False),
]))

folders.append(("17 · Automatic reminders", [
  get("Reminder meta (kinds, tokens, provider flags)", "/api/reminders/meta",
      status(200) + "\n" + J + "\n" + setv("REM_WA_CONFIGURED", "String(j.data.whatsapp_configured)") + "\n" + setv("REM_EMAIL_CONFIGURED", "String(j.data.email_configured)") + "\n" +
      has('four kinds with their placeholders', "pm.expect(j.data.kinds.map(k => k.kind)).to.eql(['fee_due', 'fee_overdue', 'class_upcoming', 'absence']); pm.expect(j.data.kinds[0].tokens).to.include('pay_link'); pm.expect(j.data.kinds[2].tokens).to.include('class_time')") + "\n" +
      has('flags are booleans', "pm.expect(j.data.whatsapp_configured).to.be.a('boolean'); pm.expect(j.data.email_configured).to.be.a('boolean'); pm.expect(j.data.online_payments).to.be.a('boolean')")),
  get("No rules yet in this organization", "/api/reminders/rules", status(200) + "\n" + J + "\n" + has('empty', "pm.expect(j.data).to.eql([])")),
  req("Create WhatsApp rule: overdue fee (switched off)", "POST", "/api/reminders/rules", {"name": "Overdue chase {{RUN_ID}}", "kind": "fee_overdue", "channel": "whatsapp", "template_id": "{{TEMPLATE_ID}}", "audience": "parents", "variables": ["{parent_name}", "{learner_first_name}"], "offset_value": 2, "send_from_hour": 9, "send_to_hour": 20, "enabled": False},
      tests=status(201) + "\n" + J + "\n" + setv("RULE_ID", "j.data.id")),
  req("Duplicate rule name is rejected", "POST", "/api/reminders/rules", {"name": "Overdue chase {{RUN_ID}}", "kind": "fee_overdue", "template_id": "{{TEMPLATE_ID}}", "variables": ["{parent_name}", "{learner_first_name}"], "offset_value": 1}, tests=status(409) + "\n" + J + "\n" + has('duplicate', "pm.expect(j.error.code).to.eql('DUPLICATE')")),
  req("Placeholder from another kind is rejected", "POST", "/api/reminders/rules", {"name": "Bad token {{RUN_ID}}", "kind": "fee_overdue", "template_id": "{{TEMPLATE_ID}}", "variables": ["{class_title}", "{parent_name}"], "offset_value": 1}, tests=status(400) + "\n" + J + "\n" + has('names the placeholder', "pm.expect(j.error.message).to.include('{class_title}')")),
  req("Wrong number of template values is rejected", "POST", "/api/reminders/rules", {"name": "Few values {{RUN_ID}}", "kind": "fee_due", "template_id": "{{TEMPLATE_ID}}", "variables": ["{parent_name}"], "offset_value": 3}, tests=status(400) + "\n" + J + "\n" + has('needs 2 values', "pm.expect(j.error.message).to.include('needs 2 value')")),
  req("Repeating needs a gap in days", "POST", "/api/reminders/rules", {"name": "Repeat {{RUN_ID}}", "kind": "fee_overdue", "template_id": "{{TEMPLATE_ID}}", "variables": ["{parent_name}", "{learner_first_name}"], "offset_value": 1, "max_sends": 3}, tests=status(400) + "\n" + J + "\n" + has('repeat_days flagged', "pm.expect(j.error.details[0].field).to.eql('repeat_days')")),
  req("Sending window must end after it starts", "POST", "/api/reminders/rules", {"name": "Window {{RUN_ID}}", "kind": "fee_due", "template_id": "{{TEMPLATE_ID}}", "variables": ["{parent_name}", "{learner_first_name}"], "offset_value": 1, "send_from_hour": 18, "send_to_hour": 10}, tests=status(400)),
  req("Edit the rule (3 days after the due date)", "PATCH", "/api/reminders/rules/{{RULE_ID}}", {"offset_value": 3}, tests=status(200) + "\n" + J + "\n" + has('same id', "pm.expect(j.data.id).to.eql(pm.environment.get('RULE_ID'))")),
  req("Create e-mail rule: absence follow-up (switched off)", "POST", "/api/reminders/rules", {"name": "Absence mail {{RUN_ID}}", "kind": "absence", "channel": "email", "audience": "parents", "email_subject": "{learner_first_name} missed {class_title}", "email_body": "Hello {parent_name}, {learner_name} was absent from {class_title} on {class_date}.", "offset_value": 2, "enabled": False},
      tests=status(201) + "\n" + J + "\n" + setv("EMAIL_RULE_ID", "j.data.id")),
  req("E-mail rule needs a subject and message", "POST", "/api/reminders/rules", {"name": "No body {{RUN_ID}}", "kind": "absence", "channel": "email", "offset_value": 1}, tests=status(400) + "\n" + J + "\n" + has('email_body flagged', "pm.expect(j.error.details[0].field).to.eql('email_body')")),
  get("List rules", "/api/reminders/rules",
      status(200) + "\n" + J + "\n" + has('both rules, off, nothing sent yet', "pm.expect(j.data).to.have.length(2); const r = j.data.find(x => x.id === pm.environment.get('RULE_ID')); pm.expect(r).to.include({channel: 'whatsapp', kind: 'fee_overdue', offset_value: 3, enabled: false, sent_total: 0}); pm.expect(r.template_name).to.eql('Class reminder'); const e = j.data.find(x => x.id === pm.environment.get('EMAIL_RULE_ID')); pm.expect(e.channel).to.eql('email'); pm.expect(e.email_subject).to.include('{learner_first_name}')")),
  req("Preview what the rule would send (writes nothing)", "POST", "/api/reminders/rules/{{RULE_ID}}/preview", {},
      desc="Dry run: the two overdue first installments (Rahul, Meera) are candidates. Works with or without a WhatsApp provider.",
      tests=status(200) + "\n" + J + "\n" + has('two overdue installments, two reachable parents', "pm.expect(j.data).to.include({candidates: 2, fresh: 2, queued: 2}); pm.expect(j.data.skipped).to.eql({no_phone: 0, opted_out: 0}); pm.expect(j.data.window_open).to.be.a('boolean')") + "\n" +
      has('sample is personalised with masked phones', "pm.expect(j.data.sample).to.have.length(2); pm.expect(j.data.sample.map(s => s.params[0]).sort()).to.eql(['Anil Nair', 'Sunil Kumar']); pm.expect(j.data.sample[0].phone).to.include('•')")),
  get("Preview left no trace in the log", "/api/reminders/log", status(200) + "\n" + J + "\n" + has('empty log', "pm.expect(j.meta.total).to.eql(0)")),
  req("Run the rule now (provider dependent)", "POST", "/api/reminders/rules/{{RULE_ID}}/run", {},
      desc="With a WhatsApp provider configured the reminders are queued as an automatic campaign (and never repeated). Without one the server says so and queues nothing.",
      tests=status(200) + "\n" + J + "\nif (pm.environment.get('REM_WA_CONFIGURED') === 'true') {\n  pm.test('queued as an automatic campaign', () => pm.expect(j.data).to.include({candidates: 2, queued: 2}));\n} else {\n  pm.test('honest not-configured answer, nothing queued', () => { pm.expect(j.data.skipped_reason).to.eql('WhatsApp is not configured'); pm.expect(j.data.queued).to.eql(0); pm.expect(j.data.campaigns).to.eql(0); });\n}"),
  req("Run the e-mail rule now (provider dependent)", "POST", "/api/reminders/rules/{{EMAIL_RULE_ID}}/run", {},
      tests=status(200) + "\n" + J + "\nif (pm.environment.get('REM_EMAIL_CONFIGURED') !== 'true') {\n  pm.test('honest not-configured answer', () => { pm.expect(j.data.skipped_reason).to.eql('E-mail is not configured'); pm.expect(j.data.queued).to.eql(0); });\n} else {\n  pm.test('ran', () => pm.expect(j.data.queued).to.be.a('number'));\n}"),
  get("Reminder log", "/api/reminders/log?rule_id={{RULE_ID}}",
      status(200) + "\n" + J + "\nconst live = pm.environment.get('REM_WA_CONFIGURED') === 'true';\n" + has('log matches the provider state', "pm.expect(j.meta.total).to.eql(live ? 2 : 0); if (live) pm.expect(j.data.every(g => g.outcome === 'queued')).to.eql(true)")),
  req("Rule from another organization id is a 404", "POST", "/api/reminders/rules/00000000-0000-4000-8000-000000000000/preview", {}, tests=status(404)),
  req("Teacher cannot read reminder rules", "GET", "/api/reminders/rules", tests=status(403), token_var="TEACHER_TOKEN"),
  req("Delete the rules", "DELETE", "/api/reminders/rules/{{RULE_ID}}", tests=status(200) + "\n" + J + "\n" + has('deleted', "pm.expect(j.data.deleted).to.eql(true)")),
  req("Delete the e-mail rule", "DELETE", "/api/reminders/rules/{{EMAIL_RULE_ID}}", tests=status(200)),
  req("Deleting twice is a 404", "DELETE", "/api/reminders/rules/{{RULE_ID}}", tests=status(404)),
]))

IMP_CSV = ["full_name,mobile,email,school,batches,parent_name,parent_mobile,relationship",
           "Import One,9{{IMP_TAIL}},import1-{{RUN_ID}}@example.com,DAV,Robotics Batch A,Import Parent,6{{IMP_TAIL}},mother",
           "Import Two,8{{IMP_TAIL}},,PSBB,,,,",
           "Rahul Again,9{{MOBILE_TAIL}},,,,,,",
           ",12345,,,,,,",
           "Import One Again,9{{IMP_TAIL}},,,,,,"]
IMP_PRE = "pm.environment.set('IMP_TAIL', String(Math.floor(Math.random()*1e9)).padStart(9,'0'));"
folders.append(("18 · CSV import", [
  req("Download the CSV template", "GET", "/api/import/learners/template.csv",
      tests=status(200) + "\n" + has('csv with the documented columns and two sample rows', "pm.expect(pm.response.headers.get('Content-Type')).to.include('text/csv'); const lines = pm.response.text().replace('\\uFEFF', '').trim().split(/\\r?\\n/); pm.expect(lines[0]).to.eql('full_name,mobile,email,gender,date_of_birth,school,location,enrolled_on,branch,batches,parent_name,parent_mobile,parent_email,relationship'); pm.expect(lines).to.have.length(3)")),
  req("Preview without a file is refused", "POST", "/api/import/learners/preview", {"nothing": "here"}, tests=status(400) + "\n" + J + "\n" + has('asks for the CSV body', "pm.expect(j.error.message).to.include('CSV')")),
  csv_req("Preview a CSV (nothing is written)", "/api/import/learners/preview?file_name=pm-{{RUN_ID}}.csv", IMP_CSV, pre=IMP_PRE,
      desc="Two new learners, one duplicate of an existing learner (Rahul's mobile), one row with errors and one in-file duplicate. The preview checks every row and writes nothing to the learners table.",
      tests=status(201) + "\n" + J + "\n" + setv("IMPORT_ID", "j.data.id") + "\n" +
      has('5 rows: 2 valid, 2 duplicate, 1 error', "pm.expect(j.data.total_rows).to.eql(5); pm.expect(j.data.counts).to.include({valid: 2, duplicate: 2, error: 1}); pm.expect(j.data.existing_duplicates).to.eql(1)") + "\n" +
      has('problems explain themselves', "const msgs = j.data.problems.map(p => p.message).join(' | '); pm.expect(msgs).to.include('Already in the system: Rahul Kumar'); pm.expect(msgs).to.include('Same mobile as row 2 in this file'); pm.expect(j.data.problems.map(p => p.row_no)).to.have.members([4, 5, 6])") + "\n" +
      has('sample shows the valid rows', "pm.expect(j.data.sample.map(s => s.full_name)).to.eql(['Import One', 'Import Two'])")),
  get("Import job is only previewed", "/api/import/{{IMPORT_ID}}", status(200) + "\n" + J + "\n" + has('previewed, 0%', "pm.expect(j.data.status).to.eql('previewed'); pm.expect(j.data.progress_pct).to.eql(0); pm.expect(j.data.counts.valid).to.eql(2)")),
  req("Confirm without the confirmation flag is refused", "POST", "/api/import/{{IMPORT_ID}}/confirm", {"expected_valid": 2}, tests=status(400) + "\n" + J + "\n" + has('validation error', "pm.expect(j.ok).to.eql(false)")),
  req("Confirm with a different count is refused", "POST", "/api/import/{{IMPORT_ID}}/confirm", {"confirm": True, "expected_valid": 7}, tests=status(409) + "\n" + J + "\n" + has('preview changed', "pm.expect(j.error.code).to.eql('PREVIEW_CHANGED')")),
  req("Confirm the import (skip duplicates)", "POST", "/api/import/{{IMPORT_ID}}/confirm", {"confirm": True, "expected_valid": 2, "on_duplicate": "skip"},
      pre="pm.environment.set('IMPORT_POLLS', '0');",
      tests=status(202) + "\n" + J + "\n" + has('running in the background', "pm.expect(j.data.status).to.eql('running')")),
  req("Confirming twice is refused", "POST", "/api/import/{{IMPORT_ID}}/confirm", {"confirm": True, "expected_valid": 2}, tests=status(409) + "\n" + J + "\n" + has('already started', "pm.expect(j.error.code).to.eql('ALREADY_STARTED')")),
  req("Wait for the import to finish", "GET", "/api/import/{{IMPORT_ID}}",
      pre="const t = Date.now(); while (Date.now() - t < 300) {}",
      desc="Rows are imported by a background job. This request re-runs itself (up to 40 times) until the job is no longer running.",
      tests=status(200) + "\n" + J + "\nconst polls = Number(pm.environment.get('IMPORT_POLLS') || 0) + 1; pm.environment.set('IMPORT_POLLS', String(polls));\nif (j.data.status === 'running' && polls < 40) { postman.setNextRequest(pm.info.requestName); } else {\n" +
      "  pm.test('completed', () => pm.expect(j.data.status).to.eql('completed'));\n  pm.test('2 created, 2 skipped, 1 error, 100%', () => { pm.expect(j.data.counts).to.include({created: 2, skipped: 2, error: 1, valid: 0, failed: 0}); pm.expect(j.data.progress_pct).to.eql(100); pm.expect(j.data.on_duplicate).to.eql('skip'); });\n}"),
  get("Created rows link to the new learners", "/api/import/{{IMPORT_ID}}/rows?status=created",
      status(200) + "\n" + J + "\n" + has('two created rows with learner ids', "pm.expect(j.meta.total).to.eql(2); pm.expect(j.data.every(r => typeof r.learner_id === 'string')).to.eql(true); pm.expect(j.data.map(r => r.row_no)).to.eql([2, 3])") + "\n" + setv("IMPORTED_LEARNER_ID", "j.data[0].learner_id")),
  get("Skipped rows say why", "/api/import/{{IMPORT_ID}}/rows?status=skipped", status(200) + "\n" + J + "\n" + has('the two duplicates', "pm.expect(j.meta.total).to.eql(2); pm.expect(j.data.map(r => r.row_no)).to.eql([4, 6])")),
  get("Rows with errors", "/api/import/{{IMPORT_ID}}/rows?status=error", status(200) + "\n" + J + "\n" + has('the bad row', "pm.expect(j.meta.total).to.eql(1); pm.expect(j.data[0].row_no).to.eql(5); pm.expect(j.data[0].message).to.be.a('string')")),
  req("Problems CSV (rows to fix and re-upload)", "GET", "/api/import/{{IMPORT_ID}}/problems.csv",
      tests=status(200) + "\n" + has('csv with row + problem columns for the 3 problem rows', "pm.expect(pm.response.headers.get('Content-Type')).to.include('text/csv'); const lines = pm.response.text().replace('\\uFEFF', '').trim().split(/\\r?\\n/); pm.expect(lines[0]).to.include('row,problem'); pm.expect(lines).to.have.length(4)")),
  get("Imported learner exists and is in batch A", "/api/learners/{{IMPORTED_LEARNER_ID}}",
      status(200) + "\n" + J + "\n" + has('one master profile with batch and parent', "pm.expect(j.data.full_name).to.eql('Import One'); pm.expect(j.data.stats.active_batches).to.eql(1); pm.expect(j.data.memberships[0].batch_id).to.eql(pm.environment.get('BATCH_ID')); pm.expect(j.data.parents[0].full_name).to.eql('Import Parent')")),
  get("Recent imports", "/api/import", status(200) + "\n" + J + "\n" + has('job listed', "const x = j.data.find(i => i.id === pm.environment.get('IMPORT_ID')); pm.expect(x.status).to.eql('completed'); pm.expect(x.file_name).to.include('pm-')")),
  csv_req("Re-uploading the same file finds everyone as a duplicate", "/api/import/learners/preview", IMP_CSV, pre="pm.environment.set('IMP_TAIL', pm.environment.get('IMP_TAIL'));",
      tests=status(201) + "\n" + J + "\n" + setv("IMPORT_ID_2", "j.data.id") + "\n" + has('no new learners', "pm.expect(j.data.counts.valid).to.eql(0); pm.expect(j.data.counts.duplicate).to.be.at.least(3)")),
  req("Nothing to import: confirm is refused", "POST", "/api/import/{{IMPORT_ID_2}}/confirm", {"confirm": True, "expected_valid": 0}, tests=status(400) + "\n" + J + "\n" + has('nothing to import', "pm.expect(j.error.message).to.include('nothing to import')")),
  req("Cancel a preview discards it", "POST", "/api/import/{{IMPORT_ID_2}}/cancel", {}, tests=status(200) + "\n" + J + "\n" + has('discarded', "pm.expect(j.data).to.include({cancelled: true, discarded: true})")),
  get("Discarded import is gone", "/api/import/{{IMPORT_ID_2}}", status(404)),
  req("Teacher cannot import", "POST", "/api/import/learners/preview", {}, tests=status(403), token_var="TEACHER_TOKEN"),
  get("Import requires a token", "/api/import", status(401), auth=False),
]))

folders.append(("19 · Live classes (Zoom)", [
  get("Live status (flags only)", "/api/live/status",
      status(200) + "\n" + J + "\n" + setv("LIVE_CONFIGURED", "String(j.data.configured)") + "\n" +
      has('booleans; no credentials', "pm.expect(j.data.configured).to.be.a('boolean'); pm.expect(j.data.webhook_configured).to.be.a('boolean'); pm.expect(JSON.stringify(j.data)).to.not.match(/secret|token|client/i)"),
      desc="NOT automated: the Zoom webhook (POST /api/webhooks/zoom). It is trusted only with an x-zm-signature (v0= + HMAC-SHA256 of 'v0:<timestamp>:<raw body>' with the Zoom secret token) and a timestamp within 5 minutes, which needs the server's secret. Test it with the Zoom app's own 'Validate' button or a real class. Meeting creation, host links and recordings need Zoom Server-to-Server OAuth credentials on the server, so without them this folder asserts the honest 'not connected' answers."),
  req("Create a Zoom meeting (provider dependent)", "POST", "/api/live/sessions/{{SESSION_ID}}/meeting", {},
      desc="SESSION_ID is the class from the attendance folder, which is already completed. Without Zoom credentials the server answers 409 NOT_CONFIGURED before it looks at the class. With credentials it refuses with 409 NOT_SCHEDULED (the class is over), so this request never creates a real meeting.",
      tests=J + "\npm.test('status is 409', () => pm.response.to.have.status(409));\npm.test('refused with an honest reason', () => pm.expect(j.error.code).to.eql(pm.environment.get('LIVE_CONFIGURED') === 'true' ? 'NOT_SCHEDULED' : 'NOT_CONFIGURED'));\npm.test('message is plain English', () => pm.expect(j.error.message).to.be.a('string').and.not.empty);"),
  req("Start link needs a Zoom meeting", "POST", "/api/live/sessions/{{SESSION_ID}}/start-link", {}, tests=status(404) + "\n" + J + "\n" + has('no meeting on this class', "pm.expect(j.error.code).to.eql('NOT_FOUND')")),
  req("Removing a meeting that does not exist", "DELETE", "/api/live/sessions/{{SESSION_ID}}/meeting", tests=status(404)),
  get("Participants (nobody joined on Zoom)", "/api/live/sessions/{{SESSION_ID}}/participants",
      status(200) + "\n" + J + "\n" + has('nobody joined, both learners not joined, manual marks shown', "pm.expect(j.data.participants).to.eql([]); pm.expect(j.data.unmatched).to.eql([]); pm.expect(j.data.roster).to.have.length(2); pm.expect(j.data.not_joined).to.have.length(2); pm.expect(j.data.marks).to.have.length(2); pm.expect(j.data.session.id).to.eql(pm.environment.get('SESSION_ID')); pm.expect(j.data.session.finalized_at).to.eql(null)")),
  req("Match an unknown Zoom name to a learner", "POST", "/api/live/sessions/{{SESSION_ID}}/match", {"name": "Guest iPad", "learner_id": "{{LEARNER_ID}}"}, tests=status(404) + "\n" + J + "\n" + has('no such participant, nothing saved', "pm.expect(j.error.code).to.eql('NOT_FOUND')")),
  req("Match a learner who is not in the batch is refused", "POST", "/api/live/sessions/{{SESSION_ID}}/match", {"name": "Guest iPad", "learner_id": "00000000-0000-4000-8000-000000000000"}, tests=status(400) + "\n" + J + "\n" + has('field named', "pm.expect(j.error.details[0].field).to.eql('learner_id')")),
  req("Recalculate attendance without join data", "POST", "/api/live/sessions/{{SESSION_ID}}/finalize", {}, tests=status(409) + "\n" + J + "\n" + has('nothing to mark from', "pm.expect(j.error.code).to.eql('NO_JOIN_DATA')")),
  get("Attendance marks were not touched", "/api/classrooms/{{BATCH_ID_2}}/sessions/{{SESSION_ID}}/attendance", status(200) + "\n" + J + "\n" + has('manual marks intact', "pm.expect(j.data.rows.map(r => r.status).sort()).to.eql(['late', 'present'])")),
  get("Recordings (none yet)", "/api/live/sessions/{{SESSION_ID}}/recordings", status(200) + "\n" + J + "\n" + has('empty list', "pm.expect(j.data).to.eql([])")),
  get("Learner can open the recordings list", "/api/live/sessions/{{SESSION_ID}}/recordings", status(200) + "\n" + J + "\n" + has('empty list', "pm.expect(j.data).to.be.an('array')"), token_var="LEARNER_TOKEN"),
  get("Learner cannot see who joined", "/api/live/sessions/{{SESSION_ID}}/participants", status(403), token_var="LEARNER_TOKEN"),
  req("Learner cannot create a meeting", "POST", "/api/live/sessions/{{SESSION_ID}}/meeting", {}, tests=status(403), token_var="LEARNER_TOKEN"),
  get("Unknown class is a 404", "/api/live/sessions/00000000-0000-4000-8000-000000000000/recordings", status(404)),
  get("Live status requires a token", "/api/live/status", status(401), auth=False),
]))

folders.append(("20 · Branding", [
  get("Public branding of the new organization (no sign-in)", "/api/public/branding?org=pm-{{RUN_ID}}",
      status(200) + "\n" + J + "\n" + has('platform default colors, organization name, public fields only', "pm.expect(j.data.default).to.eql(false); pm.expect(j.data.slug).to.eql('pm-' + pm.environment.get('RUN_ID')); pm.expect(j.data.name).to.include('Postman Org'); pm.expect(j.data.logo_url).to.eql(null); pm.expect(j.data).to.not.have.any.keys('id', 'org_id', 'settings')"), auth=False, org=False),
  get("Unknown organization gets the platform default", "/api/public/branding?org=no-such-school-{{RUN_ID}}",
      status(200) + "\n" + J + "\n" + has('default branding, nothing reveals which slugs exist', "pm.expect(j.data.default).to.eql(true); pm.expect(j.data.slug).to.eql(null)"), auth=False, org=False),
  get("Branding settings (admin)", "/api/branding/settings",
      status(200) + "\n" + J + "\n" + has('nothing customised yet, defaults offered', "pm.expect(j.data.app_name).to.eql(null); pm.expect(j.data.color).to.eql(null); pm.expect(j.data.logo_url).to.eql(null); pm.expect(j.data.defaults.color).to.match(/^#[0-9a-fA-F]{6}$/)")),
  req("Main color that is too light is refused", "PUT", "/api/branding/settings", {"color": "#FFEE00"}, tests=status(400) + "\n" + J + "\n" + has('measured contrast reported', "pm.expect(j.error.details[0].field).to.eql('color'); pm.expect(j.error.details[0].message).to.include('4.5')")),
  req("Not a color is refused", "PUT", "/api/branding/settings", {"color": "blue"}, tests=status(400)),
  req("Invalid support e-mail is refused", "PUT", "/api/branding/settings", {"support_email": "not-an-email"}, tests=status(400)),
  req("Save branding", "PUT", "/api/branding/settings", {"app_name": "PM School {{RUN_ID}}", "tagline": "Robots for everyone", "color": "#0B5FA5", "accent": "#F59E0B", "support_email": "Help-{{RUN_ID}}@Postman.test", "support_phone": "+91 98765 43210"},
      tests=status(200) + "\n" + J + "\n" + has('saved, e-mail lower-cased', "pm.expect(j.data).to.include({tagline: 'Robots for everyone', color: '#0b5fa5', accent: '#f59e0b', support_phone: '+91 98765 43210'}); pm.expect(j.data.app_name).to.eql('PM School ' + pm.environment.get('RUN_ID')); pm.expect(j.data.support_email).to.eql('help-' + pm.environment.get('RUN_ID') + '@postman.test')")),
  get("Public branding now shows the school's identity", "/api/public/branding?org=pm-{{RUN_ID}}",
      status(200) + "\n" + J + "\n" + has('app name, colors and support contacts', "pm.expect(j.data.app_name).to.eql('PM School ' + pm.environment.get('RUN_ID')); pm.expect(j.data).to.include({tagline: 'Robots for everyone', color: '#0b5fa5', accent: '#f59e0b', support_phone: '+91 98765 43210'}); pm.expect(j.data.manifest_url).to.include('manifest.webmanifest')"), auth=False, org=False),
  get("Per-organization web app manifest", "/api/public/orgs/pm-{{RUN_ID}}/manifest.webmanifest",
      status(200) + "\n" + J.replace("pm.response.json()", "JSON.parse(pm.response.text())") + "\n" + has('manifest built from the branding', "pm.expect(pm.response.headers.get('Content-Type')).to.include('manifest+json'); pm.expect(j.name).to.eql('PM School ' + pm.environment.get('RUN_ID')); pm.expect(j.theme_color).to.eql('#0b5fa5'); pm.expect(j.display).to.eql('standalone'); pm.expect(j.start_url).to.include('org=pm-'); pm.expect(j.icons.length).to.be.at.least(2)"), auth=False, org=False),
  get("No logo uploaded yet (404)", "/api/public/orgs/pm-{{RUN_ID}}/logo", status(404), auth=False, org=False,
      desc="Logo upload (POST /api/branding/logo, a square PNG 512-2048 px sent as the raw body) is left out of this collection because Postman cannot embed a binary file portably."),
  req("Removing a logo that was never set is a 404", "DELETE", "/api/branding/logo", tests=status(404)),
  req("Teacher cannot change branding", "PUT", "/api/branding/settings", {"app_name": "Hacked"}, tests=status(403), token_var="TEACHER_TOKEN"),
  req("Clear the optional fields again", "PUT", "/api/branding/settings", {"tagline": "", "support_phone": ""},
      tests=status(200) + "\n" + J + "\n" + has('blank means cleared', "pm.expect(j.data.tagline).to.eql(null); pm.expect(j.data.support_phone).to.eql(null); pm.expect(j.data.color).to.eql('#0b5fa5')")),
  get("Audit log recorded the branding change", "/api/audit?page_size=100", status(200) + "\n" + J + "\n" + has('branding update audited', "pm.expect(j.data.map(x => x.action)).to.include('organization.branding_updated')")),
]))

DESIGN = {"name": "Completion {{RUN_ID}}", "title_text": "Certificate of Completion", "body_text": "{name} completed {course_name} in {batch_name} on {date}.", "signatory_name": "Priya Raman", "signatory_title": "Lead Instructor", "show_logo": True}
ISSUE = lambda **kw: {"design_id": "{{CERT_DESIGN_ID}}", "selector": {"batch_ids": ["{{BATCH_ID_2}}"]}, "batch_id": "{{BATCH_ID_2}}", **kw}
folders.append(("21 · Certificates", [
  req("Create certificate design", "POST", "/api/certificates/designs", DESIGN, tests=status(201) + "\n" + J + "\n" + setv("CERT_DESIGN_ID", "j.data.id")),
  req("Duplicate design name is rejected", "POST", "/api/certificates/designs", DESIGN, tests=status(409)),
  req("Unknown placeholder is rejected", "POST", "/api/certificates/designs", {**DESIGN, "name": "Bad {{RUN_ID}}", "body_text": "{name} did {nonsense}"}, tests=status(400) + "\n" + J + "\n" + has('lists the working placeholders', "pm.expect(JSON.stringify(j.error)).to.include('{course_name}')")),
  get("List designs", "/api/certificates/designs", status(200) + "\n" + J + "\n" + has('design active, nothing issued', "const d = j.data.find(x => x.id === pm.environment.get('CERT_DESIGN_ID')); pm.expect(d.status).to.eql('active'); pm.expect(Number(d.issued)).to.eql(0); pm.expect(d.signatory_name).to.eql('Priya Raman')")),
  req("Edit the design (PUT)", "PUT", "/api/certificates/designs/{{CERT_DESIGN_ID}}", {**DESIGN, "signatory_title": "Head of Robotics", "status": "active"}, tests=status(200) + "\n" + J + "\n" + has('same id', "pm.expect(j.data.id).to.eql(pm.environment.get('CERT_DESIGN_ID'))")),
  req("Issue without confirmation is refused", "POST", "/api/certificates/issue", ISSUE(), tests=status(400) + "\n" + J + "\n" + has('confirmation required', "pm.expect(j.error.code).to.eql('CONFIRMATION_REQUIRED')")),
  req("Issue to batch B: dry run", "POST", "/api/certificates/issue", ISSUE(dry_run=True),
      tests=status(200) + "\n" + J + "\n" + has('2 learners would get one each; nothing written', "pm.expect(j.data).to.include({dry_run: true, selected: 2, to_issue: 2, already_have: 0}); pm.expect(j.data.sample.sort()).to.eql(['Meera Nair', 'Rahul Kumar'])")),
  get("Dry run issued nothing", "/api/certificates?design_id={{CERT_DESIGN_ID}}", status(200) + "\n" + J + "\n" + has('none', "pm.expect(j.meta.total).to.eql(0)")),
  req("Issue to batch B: confirm", "POST", "/api/certificates/issue", ISSUE(confirm=True), tests=status(201) + "\n" + J + "\n" + has('2 issued', "pm.expect(j.data).to.include({dry_run: false, selected: 2, issued: 2, already_have: 0})")),
  req("Issuing again gives nobody a second certificate", "POST", "/api/certificates/issue", ISSUE(confirm=True), tests=status(201) + "\n" + J + "\n" + has('all already have one', "pm.expect(j.data).to.include({issued: 0, already_have: 2})")),
  get("List certificates", "/api/certificates?design_id={{CERT_DESIGN_ID}}",
      status(200) + "\n" + J + "\n" + has('two certificates with readable codes', "pm.expect(j.meta.total).to.eql(2); pm.expect(j.data.every(c => /^RKC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c.code))).to.eql(true); pm.expect(j.data.every(c => c.revoked_at === null)).to.eql(true)") + "\n" +
      has('wording is filled in at issue time', "const c = j.data.find(x => x.learner_id === pm.environment.get('LEARNER_ID')); pm.expect(c).to.include({recipient_name: 'Rahul Kumar', course_name: 'Robotics', batch_name: 'Robotics Batch B', title: 'Certificate of Completion'})") + "\n" +
      setv("CERT_ID", "j.data.find(x => x.learner_id === pm.environment.get('LEARNER_ID')).id") + "\n" + setv("CERT_CODE", "j.data.find(x => x.learner_id === pm.environment.get('LEARNER_ID')).code")),
  get("Search certificates by name", "/api/certificates?q=Meera", status(200) + "\n" + J + "\n" + has('Meera only', "pm.expect(j.data.length).to.be.at.least(1); pm.expect(j.data.every(c => c.recipient_name === 'Meera Nair')).to.eql(true)")),
  req("Download the certificate PDF", "GET", "/api/certificates/{{CERT_ID}}/pdf", tests=status(200) + "\n" + PDF),
  get("Public verification (no sign-in)", "/api/public/verify/{{CERT_CODE}}",
      status(200) + "\n" + J + "\n" + has('valid, with only the public fields', "pm.expect(j.data).to.include({valid: true, status: 'valid', recipient_name: 'Rahul Kumar', course_name: 'Robotics', batch_name: 'Robotics Batch B', title: 'Certificate of Completion'}); pm.expect(j.data.organization).to.include('Postman Org'); pm.expect(Object.keys(j.data).sort()).to.eql(['batch_name', 'course_name', 'issued_on', 'organization', 'recipient_name', 'status', 'title', 'valid'])"), auth=False, org=False),
  get("Verification is case-insensitive", "/api/public/verify/{{CERT_CODE_LOWER}}", status(200) + "\n" + J + "\n" + has('valid', "pm.expect(j.data.valid).to.eql(true)"), auth=False, org=False,
      pre="pm.environment.set('CERT_CODE_LOWER', pm.environment.get('CERT_CODE').toLowerCase());"),
  get("Malformed or unknown code is a 404", "/api/public/verify/RKC-ZZZZ-ZZZZ", status(404) + "\n" + J + "\n" + has('plain not found', "pm.expect(j.error.code).to.eql('NOT_FOUND')"), auth=False, org=False),
  get("Learner: my certificates", "/api/certificates/me", status(200) + "\n" + J + "\n" + has('own certificate only', "pm.expect(j.data).to.have.length(1); pm.expect(j.data[0].code).to.eql(pm.environment.get('CERT_CODE'))"), token_var="LEARNER_TOKEN"),
  req("Learner downloads own PDF", "GET", "/api/certificates/{{CERT_ID}}/pdf", tests=status(200) + "\n" + PDF, token_var="LEARNER_TOKEN"),
  req("Learner cannot issue certificates", "POST", "/api/certificates/issue", ISSUE(confirm=True), tests=status(403), token_var="LEARNER_TOKEN"),
  req("Learner cannot revoke", "POST", "/api/certificates/{{CERT_ID}}/revoke", {"reason": "Not allowed"}, tests=status(403), token_var="LEARNER_TOKEN"),
  req("Teacher can read but not issue", "POST", "/api/certificates/issue", ISSUE(confirm=True), tests=status(403), token_var="TEACHER_TOKEN"),
  req("Revoke needs a reason", "POST", "/api/certificates/{{CERT_ID}}/revoke", {"reason": "x"}, tests=status(400)),
  req("Revoke Rahul's certificate", "POST", "/api/certificates/{{CERT_ID}}/revoke", {"reason": "Issued by mistake"}, tests=status(200) + "\n" + J + "\n" + has('revoked', "pm.expect(j.data.revoked).to.eql(true)")),
  req("Revoking twice is a conflict", "POST", "/api/certificates/{{CERT_ID}}/revoke", {"reason": "Again"}, tests=status(409)),
  get("Public verification now says revoked", "/api/public/verify/{{CERT_CODE}}", status(200) + "\n" + J + "\n" + has('revoked, not valid', "pm.expect(j.data).to.include({valid: false, status: 'revoked'})"), auth=False, org=False),
  req("Revoked certificate can be issued again", "POST", "/api/certificates/issue", ISSUE(confirm=True), tests=status(201) + "\n" + J + "\n" + has('one new certificate (Meera keeps hers)', "pm.expect(j.data).to.include({selected: 2, issued: 1, already_have: 1})")),
  get("Certificate list shows both the revoked and the new one", "/api/certificates?learner_id={{LEARNER_ID}}", status(200) + "\n" + J + "\n" + has('2 rows, one revoked with its reason', "pm.expect(j.meta.total).to.eql(2); const r = j.data.filter(c => c.revoked_at !== null); pm.expect(r).to.have.length(1); pm.expect(r[0].revoke_reason).to.eql('Issued by mistake'); pm.expect(r[0].code).to.eql(pm.environment.get('CERT_CODE'))")),
  get("Certificates require a token", "/api/certificates", status(401), auth=False),
]))

CAL_STEPS = "pm.environment.set('CAL_FILE', j.data.url.split('/api/public/calendar/')[1]);"
folders.append(("22 · Calendar feed", [
  req("Teacher: calendar link status (none yet)", "GET", "/api/calendar/me", tests=status(200) + "\n" + J + "\n" + has('no active link', "pm.expect(j.data).to.eql({active: false, created_at: null, last_used_at: null})"), token_var="TEACHER_TOKEN"),
  req("Teacher: create my calendar link", "POST", "/api/calendar/me/regenerate", {},
      desc="The link is shown once; only its hash is stored. The secret file name is kept in the environment (CAL_FILE) only for the next steps and removed at the end.",
      tests=status(200) + "\n" + J + "\n" + has('secret .ics URL returned once', "pm.expect(j.data.url).to.match(/\\/api\\/public\\/calendar\\/[A-Za-z0-9_-]{20,}\\.ics$/)") + "\n" + CAL_STEPS, token_var="TEACHER_TOKEN"),
  req("Teacher: link status is now active", "GET", "/api/calendar/me", tests=status(200) + "\n" + J + "\n" + has('active, never used, no secret in the answer', "pm.expect(j.data.active).to.eql(true); pm.expect(j.data.last_used_at).to.eql(null); pm.expect(JSON.stringify(j.data)).to.not.include(pm.environment.get('CAL_FILE').replace('.ics', ''))"), token_var="TEACHER_TOKEN"),
  req("Subscribe: the feed needs no sign-in, the secret link is the credential", "GET", "/api/public/calendar/{{CAL_FILE}}", auth=False, org=False,
      tests=status(200) + "\n" + has('calendar with the teacher classes', "const t = pm.response.text(); pm.expect(pm.response.headers.get('Content-Type')).to.include('text/calendar'); pm.expect(t).to.include('BEGIN:VCALENDAR'); pm.expect(t).to.include('END:VCALENDAR'); pm.expect((t.match(/BEGIN:VEVENT/g) || []).length).to.be.at.least(3); pm.expect(t).to.include('Robotics Batch B'); pm.expect(t).to.include('@classes.robokalam')") + "\n" +
      has('noindex header', "pm.expect(pm.response.headers.get('X-Robots-Tag')).to.include('noindex')")),
  req("Teacher: the link records that it was used", "GET", "/api/calendar/me", tests=status(200) + "\n" + J + "\n" + has('last_used_at set', "pm.expect(j.data.last_used_at).to.not.eql(null)"), token_var="TEACHER_TOKEN"),
  req("A guessed link is a 404", "GET", "/api/public/calendar/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics", auth=False, org=False, tests=status(404)),
  req("Teacher: add one class to my calendar (.ics)", "GET", "/api/calendar/session/{{SESSION_ID}}.ics",
      tests=status(200) + "\n" + has('single event file', "const t = pm.response.text(); pm.expect(pm.response.headers.get('Content-Type')).to.include('text/calendar'); pm.expect((t.match(/BEGIN:VEVENT/g) || []).length).to.eql(1); pm.expect(t).to.include(pm.environment.get('SESSION_ID') + '@classes.robokalam')"), token_var="TEACHER_TOKEN"),
  req("Unknown class cannot be exported (404)", "GET", "/api/calendar/session/00000000-0000-4000-8000-000000000000.ics", tests=status(404), token_var="TEACHER_TOKEN"),
  req("Replacing the link switches the old one off", "POST", "/api/calendar/me/regenerate", {},
      pre="pm.environment.set('CAL_FILE_OLD', pm.environment.get('CAL_FILE'));",
      tests=status(200) + "\n" + J + "\n" + CAL_STEPS + "\n" + has('a different secret', "pm.expect(pm.environment.get('CAL_FILE')).to.not.eql(pm.environment.get('CAL_FILE_OLD'))"), token_var="TEACHER_TOKEN"),
  req("Old link no longer works", "GET", "/api/public/calendar/{{CAL_FILE_OLD}}", auth=False, org=False, tests=status(404)),
  req("Teacher: turn the feed off", "DELETE", "/api/calendar/me", tests=status(200) + "\n" + J + "\n" + has('revoked', "pm.expect(j.data.revoked).to.eql(true)"), token_var="TEACHER_TOKEN"),
  req("Revoked link stops at once", "GET", "/api/public/calendar/{{CAL_FILE}}", auth=False, org=False,
      tests=status(404) + "\npm.environment.unset('CAL_FILE'); pm.environment.unset('CAL_FILE_OLD');"),
  req("Teacher: status is inactive again", "GET", "/api/calendar/me", tests=status(200) + "\n" + J + "\n" + has('inactive', "pm.expect(j.data.active).to.eql(false)"), token_var="TEACHER_TOKEN"),
  req("Learner: own feed (parents and learners see their batches)", "POST", "/api/calendar/me/regenerate", {}, tests=status(200) + "\n" + J + "\n" + has('link issued', "pm.expect(j.data.url).to.include('/api/public/calendar/')"), token_var="LEARNER_TOKEN"),
  req("Learner: turn it off", "DELETE", "/api/calendar/me", tests=status(200), token_var="LEARNER_TOKEN"),
  req("Calendar needs a token", "GET", "/api/calendar/me", auth=False, tests=status(401)),
]))

folders.append(("23 · Auth additions & e-mail", [
  get("Capabilities (public)", "/api/auth/capabilities",
      status(200) + "\n" + J + "\n" + setv("EMAIL_CONFIGURED", "String(j.data.password_reset)") + "\n" + has('password reset offered only when e-mail is connected', "pm.expect(j.data.password_reset).to.be.a('boolean')"), auth=False, org=False),
  req("Forgot password: unknown address gets the standard answer", "POST", "/api/auth/forgot-password", {"email": "nobody-{{RUN_ID}}@postman.test"}, auth=False, org=False,
      desc="The answer is identical whether or not the address has an account (and whether or not e-mail is configured), so it cannot be used to discover accounts. Resetting needs the token that is e-mailed, so reset-password is NOT automated with a real token here.",
      tests=status(200) + "\n" + J + "\n" + has('always {sent: true}', "pm.expect(j.data).to.eql({sent: true})")),
  req("Forgot password: malformed address is a validation error", "POST", "/api/auth/forgot-password", {"email": "not-an-email"}, auth=False, org=False, tests=status(400) + "\n" + J + "\n" + has('validation envelope', "pm.expect(j.ok).to.eql(false)")),
  get("Reset link check: a made-up token is not valid", "/api/auth/reset-password/check?token=abcdefghijklmnopqrstuvwxyz0123456789", status(200) + "\n" + J + "\n" + has('invalid', "pm.expect(j.data.valid).to.eql(false)"), auth=False, org=False),
  req("Reset with a made-up token is refused", "POST", "/api/auth/reset-password", {"token": "abcdefghijklmnopqrstuvwxyz0123456789", "new_password": "Postman-Pass-456"}, auth=False, org=False, tests=status(400) + "\n" + J + "\n" + has('invalid or expired link', "pm.expect(j.error.code).to.eql('RESET_INVALID')")),
  req("Reset with a weak password is refused before the token is looked at", "POST", "/api/auth/reset-password", {"token": "abcdefghijklmnopqrstuvwxyz0123456789", "new_password": "short"}, auth=False, org=False, tests=status(400) + "\n" + J + "\n" + has('password policy message, not RESET_INVALID', "pm.expect(j.error.code).to.not.eql('RESET_INVALID')")),
  req("Reset with a too-short token is a validation error", "POST", "/api/auth/reset-password", {"token": "short", "new_password": "Postman-Pass-456"}, auth=False, org=False, tests=status(400)),
  get("E-mail status (staff)", "/api/email/status",
      status(200) + "\n" + J + "\n" + has('configured flag matches the public capability; counts only', "pm.expect(j.data.configured).to.eql(pm.environment.get('EMAIL_CONFIGURED') === 'true'); pm.expect(j.data.last_7_days).to.be.an('object'); pm.expect(JSON.stringify(j.data)).to.not.match(/password|smtp/i)")),
  get("E-mail outbox (no bodies)", "/api/email/outbox?page_size=10",
      status(200) + "\n" + J + "\n" + has('list without message bodies', "pm.expect(j.data).to.be.an('array'); j.data.forEach(m => pm.expect(m).to.not.have.any.keys('body', 'html', 'text'))")),
  get("Teacher cannot read the outbox", "/api/email/outbox", status(403), token_var="TEACHER_TOKEN"),
  get("Outbox requires a token", "/api/email/outbox", status(401), auth=False),
  get("Unsubscribe link with a forged token is rejected", "/api/public/unsubscribe/not-a-real-token", status(400) + "\npm.test('plain HTML page', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('text/html'));", auth=False, org=False),
]))

FOLDER_DESC = {
  "19 · Live classes (Zoom)": "Zoom Server-to-Server integration. Needs ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET on the server for meeting creation; without them this folder asserts the honest NOT_CONFIGURED answers. The Zoom webhook (POST /api/webhooks/zoom) is deliberately NOT in this collection: it is trusted only with an x-zm-signature header (v0= + HMAC-SHA256 of 'v0:<timestamp>:<raw body>' using the Zoom secret token) and a timestamp within 5 minutes, which requires the server's secret. Never put that secret in the collection.",
  "16 · Fees & payments": "Fee plans, assignment through the selection engine (dry run then confirm), dues, summary, manual payments with idempotent request_id, receipts, refunds and the learner's own ledger. Online payment links need Razorpay keys on the server; without them the request asserts 409 NOT_CONFIGURED. The Razorpay webhook (POST /api/webhooks/razorpay) needs an HMAC signature from the server secret and is not automated.",
  "17 · Automatic reminders": "Rules CRUD, dry-run preview, run-now and the reminder log. Sending needs a WhatsApp provider (or SMTP for e-mail rules); without one the run endpoints answer with an honest skipped_reason and queue nothing. Rules are created switched off so the scheduler never acts on them.",
  "18 · CSV import": "Template, preview, confirm (background job, polled), rows and problems CSV. Mobiles are randomised per run so it can be repeated.",
  "20 · Branding": "Public branding, admin settings and per-organization manifest. Logo upload is omitted (binary PNG body).",
  "22 · Calendar feed": "Personal .ics feed link. The secret file name is kept in the CAL_FILE environment variable only while the folder runs and is unset at the end.",
  "23 · Auth additions & e-mail": "Capabilities, forgot-password (identical answer for every address), reset-password negative checks and e-mail status/outbox. A real password reset needs the e-mailed token, so it is not automated.",
}

coll = {"info": {"name": "Robokalam Learner OS", "description": "End-to-end collection for all phases: organization, catalog, batches, learners (one master profile), selection and bulk tools, membership changes, access control (folders 0-7); assignments, submissions, scoring with history and gradebook, badges, XP and leaderboard, Learner 360, attendance, CRM, WhatsApp campaigns and the AiSensy delivery webhook, analytics and reports, system status and readiness, and negative/security checks (folders 8-15); then Phases 10-13: fees and payments, automatic reminders, CSV import, live classes (Zoom), branding, certificates, calendar feeds, password-reset plumbing and e-mail status (folders 16-23). It creates its own organization on every run, so it can be re-run any time. Import the environment, then set BASE_URL, SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (and AISENSY_WEBHOOK_SECRET, the same value as on the server, for the webhook steps). Scripts store tokens, ids and other state in the environment as they go. Run the folders in order. The whole collection is about 300 requests: the dev server's default global limit (RATE_LIMIT_MAX=300 per minute per IP) would reject the last ones with 429, so start the server with a higher RATE_LIMIT_MAX or run newman with --delay-request 250. The WhatsApp folder asserts only what is deterministic without a live AiSensy provider; see its description.", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": [{"name": n, "item": items, **({"description": FOLDER_DESC[n]} if n in FOLDER_DESC else {})} for n, items in folders],
        "variable": []}
env = {"name": "Robokalam Learner OS — local", "values": [
  {"key": "BASE_URL", "value": "http://localhost:4000", "enabled": True},
  {"key": "SUPER_ADMIN_EMAIL", "value": "owner@robokalam.test", "enabled": True},
  {"key": "SUPER_ADMIN_PASSWORD", "value": "", "type": "secret", "enabled": True},
  *[{"key": k, "value": "", "type": "secret" if (k.endswith("TOKEN") or k.startswith("CAL_FILE")) else "default", "enabled": True} for k in ["AUTH_TOKEN", "SUPER_TOKEN", "TEACHER_TOKEN", "ORG_ID", "ADMIN_EMAIL", "BRANCH_ID", "PROGRAM_ID", "COURSE_ID", "TEACHER_ID", "BATCH_ID", "BATCH_ID_2", "LEARNER_ID", "ASSIGNMENT_ID", "CAMPAIGN_ID", "PLAN_ID", "PAYMENT_ID", "PAY_REQUEST_ID", "START_DATE", "FUTURE_AT", "INSTALLMENT_ID", "PAY_CONFIGURED", "RULE_ID", "EMAIL_RULE_ID", "REM_WA_CONFIGURED", "REM_EMAIL_CONFIGURED", "IMPORT_ID", "IMPORT_ID_2", "IMP_TAIL", "IMPORT_POLLS", "IMPORTED_LEARNER_ID", "LIVE_CONFIGURED", "CERT_DESIGN_ID", "CERT_ID", "CERT_CODE", "CERT_CODE_LOWER", "CAL_FILE", "CAL_FILE_OLD", "EMAIL_CONFIGURED", "RUN_ID", "MOBILE_TAIL", "LEARNER_ID_2", "LEARNER_EMAIL", "LEARNER_TOKEN", "DUE_AT", "SUBMISSION_ID", "SCORE_ID", "BADGE_ID", "XP_REQUEST_ID", "SESSION_ID", "SESSION_START", "SESSION_END", "GEN_FROM", "GEN_TO", "GENERATED_COUNT", "FOLLOW_UP_ID", "FOLLOW_UP_ID_2", "FOLLOW_UP_AT", "FOLLOW_UP_AT_2", "FOLLOW_UP_AT_3", "TEMPLATE_ID", "WA_CONFIGURED"]],
  {"key": "AISENSY_WEBHOOK_SECRET", "value": "", "type": "secret", "enabled": True}],
  "_postman_variable_scope": "environment"}
json.dump(coll, open("robokalam-learner-os.postman_collection.json", "w"), indent=2)
json.dump(env, open("robokalam-learner-os.postman_environment.json", "w"), indent=2)
print("collection items:", sum(len(i) for _, i in folders))
