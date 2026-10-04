import json
# Generates the Postman collection + environment (kept as a script so the JSON stays reviewable/regenerable).
def req(name, method, path, body=None, tests=None, pre=None, auth=True, org=True, desc=None, token_var='AUTH_TOKEN'):
    headers = [{"key": "Content-Type", "value": "application/json"}]
    if org: headers.append({"key": "X-Org-Id", "value": "{{ORG_ID}}", "disabled": True, "description": "Only needed when signed in as the platform super admin"})
    item = {"name": name, "request": {"method": method, "header": headers, "url": {"raw": "{{BASE_URL}}" + path, "host": ["{{BASE_URL}}"], "path": [p for p in path.split("?")[0].split("/") if p], "query": [{"key": k, "value": v} for k, v in (kv.split("=", 1) for kv in path.split("?")[1].split("&"))] if "?" in path else []}}}
    if desc: item["request"]["description"] = desc
    item["request"]["auth"] = {"type": "bearer", "bearer": [{"key": "token", "value": "{{" + token_var + "}}", "type": "string"}]} if auth else {"type": "noauth"}
    if body is not None: item["request"]["body"] = {"mode": "raw", "raw": json.dumps(body, indent=2), "options": {"raw": {"language": "json"}}}
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

coll = {"info": {"name": "Robokalam Learner OS — Phase 1", "description": "Runs end-to-end: creates its own organization every run, so it can be re-run any time. Import the environment, then set BASE_URL, SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD. Scripts store AUTH_TOKEN, ORG_ID, LEARNER_ID, BATCH_ID, TEACHER_ID … in the environment as they go. Later phases (assignments, scores, badges, XP, CRM, WhatsApp) will be added to this collection as they ship.", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": [{"name": n, "item": items} for n, items in folders],
        "variable": []}
env = {"name": "Robokalam Learner OS — local", "values": [
  {"key": "BASE_URL", "value": "http://localhost:4000", "enabled": True},
  {"key": "SUPER_ADMIN_EMAIL", "value": "owner@robokalam.test", "enabled": True},
  {"key": "SUPER_ADMIN_PASSWORD", "value": "", "type": "secret", "enabled": True},
  *[{"key": k, "value": "", "type": "secret" if k.endswith("TOKEN") else "default", "enabled": True} for k in ["AUTH_TOKEN", "SUPER_TOKEN", "TEACHER_TOKEN", "ORG_ID", "ADMIN_EMAIL", "BRANCH_ID", "PROGRAM_ID", "COURSE_ID", "TEACHER_ID", "BATCH_ID", "BATCH_ID_2", "LEARNER_ID", "ASSIGNMENT_ID", "CAMPAIGN_ID", "RUN_ID", "MOBILE_TAIL"]]],
  "_postman_variable_scope": "environment"}
json.dump(coll, open("robokalam-learner-os.postman_collection.json", "w"), indent=2)
json.dump(env, open("robokalam-learner-os.postman_environment.json", "w"), indent=2)
print("collection items:", sum(len(i) for _, i in folders))
