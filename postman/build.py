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
        pre = "pm.cookies.jar().clear(pm.variables.replaceIn('{{BASE_URL}}'), () => {});" + ("\n" + pre.strip() if pre else "")
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

coll = {"info": {"name": "Robokalam Learner OS", "description": "End-to-end collection for all phases: organization, catalog, batches, learners (one master profile), selection and bulk tools, membership changes, access control (folders 0-7); assignments, submissions, scoring with history and gradebook, badges, XP and leaderboard, Learner 360, attendance, CRM, WhatsApp campaigns and the AiSensy delivery webhook, analytics and reports, system status and readiness, and negative/security checks (folders 8-15). It creates its own organization on every run, so it can be re-run any time. Import the environment, then set BASE_URL, SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD (and AISENSY_WEBHOOK_SECRET, the same value as on the server, for the webhook steps). Scripts store tokens, ids and other state in the environment as they go. Run the folders in order. The WhatsApp folder asserts only what is deterministic without a live AiSensy provider; see its description.", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": [{"name": n, "item": items} for n, items in folders],
        "variable": []}
env = {"name": "Robokalam Learner OS — local", "values": [
  {"key": "BASE_URL", "value": "http://localhost:4000", "enabled": True},
  {"key": "SUPER_ADMIN_EMAIL", "value": "owner@robokalam.test", "enabled": True},
  {"key": "SUPER_ADMIN_PASSWORD", "value": "", "type": "secret", "enabled": True},
  *[{"key": k, "value": "", "type": "secret" if k.endswith("TOKEN") else "default", "enabled": True} for k in ["AUTH_TOKEN", "SUPER_TOKEN", "TEACHER_TOKEN", "ORG_ID", "ADMIN_EMAIL", "BRANCH_ID", "PROGRAM_ID", "COURSE_ID", "TEACHER_ID", "BATCH_ID", "BATCH_ID_2", "LEARNER_ID", "ASSIGNMENT_ID", "CAMPAIGN_ID", "RUN_ID", "MOBILE_TAIL", "LEARNER_ID_2", "LEARNER_EMAIL", "LEARNER_TOKEN", "DUE_AT", "SUBMISSION_ID", "SCORE_ID", "BADGE_ID", "XP_REQUEST_ID", "SESSION_ID", "SESSION_START", "SESSION_END", "GEN_FROM", "GEN_TO", "GENERATED_COUNT", "FOLLOW_UP_ID", "FOLLOW_UP_ID_2", "FOLLOW_UP_AT", "FOLLOW_UP_AT_2", "FOLLOW_UP_AT_3", "TEMPLATE_ID", "WA_CONFIGURED"]],
  {"key": "AISENSY_WEBHOOK_SECRET", "value": "", "type": "secret", "enabled": True}],
  "_postman_variable_scope": "environment"}
json.dump(coll, open("robokalam-learner-os.postman_collection.json", "w"), indent=2)
json.dump(env, open("robokalam-learner-os.postman_environment.json", "w"), indent=2)
print("collection items:", sum(len(i) for _, i in folders))
