-- ============================================================================
-- Robokalam Learner OS — Migration 001: Phase 1 Foundation
-- Tenancy, auth, RBAC, catalog, master learner DB, parents, batches,
-- learner/teacher batch memberships, activity timeline, audit log.
--
-- Core invariant: ONE learner = ONE row in `learners`. Batch participation is
-- expressed ONLY through `learner_batch_memberships` (unique learner_id+batch_id).
-- Every business table carries organization_id (org_id) and composite foreign
-- keys (id, org_id) prevent cross-tenant references at the database level.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Optional: trigram index for fast substring search (skipped if not permitted).
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm not available; substring search will use sequential scans';
END $$;

-- Generic updated_at trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  code_prefix   text NOT NULL DEFAULT 'RK' CHECK (code_prefix ~ '^[A-Z0-9]{2,6}$'),
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE TRIGGER trg_organizations_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-organization gap-tolerant counters for human readable ids (RK-LRN-000124).
CREATE TABLE org_counters (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  counter_key  text NOT NULL,
  value        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, counter_key)
);

CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  name        text NOT NULL,
  code        text NOT NULL,
  city        text,
  address     text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (org_id, code),
  UNIQUE (id, org_id)
);
CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Identity & RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid REFERENCES organizations(id),          -- NULL only for platform super admins
  email               text NOT NULL,
  mobile              text,
  password_hash       text NOT NULL,
  full_name           text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','invited')),
  must_change_password boolean NOT NULL DEFAULT false,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX uq_users_email ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_org ON users (org_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_mobile ON users (mobile) WHERE mobile IS NOT NULL;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  description  text
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- A user can hold several roles; branch_id optionally narrows the scope of a role.
CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id),
  org_id      uuid REFERENCES organizations(id),
  branch_id   uuid REFERENCES branches(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_user_roles ON user_roles (user_id, role_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL UNIQUE,
  user_agent          text,
  ip                  text,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);

-- ---------------------------------------------------------------------------
-- Catalog: programs → courses
-- ---------------------------------------------------------------------------
CREATE TABLE programs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  name         text NOT NULL,
  code         text NOT NULL,
  description  text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (org_id, code),
  UNIQUE (id, org_id)
);
CREATE TRIGGER trg_programs_updated BEFORE UPDATE ON programs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE courses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  program_id   uuid NOT NULL,
  name         text NOT NULL,
  code         text NOT NULL,
  description  text,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  UNIQUE (org_id, code),
  UNIQUE (id, org_id),
  FOREIGN KEY (program_id, org_id) REFERENCES programs (id, org_id)
);
CREATE INDEX idx_courses_program ON courses (program_id);
CREATE TRIGGER trg_courses_updated BEFORE UPDATE ON courses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- People: parents and the MASTER learner table
-- ---------------------------------------------------------------------------
CREATE TABLE parents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  user_id     uuid REFERENCES users(id),
  full_name   text NOT NULL,
  mobile      text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (id, org_id)
);
-- Siblings share one parent record: a parent mobile is unique per organization.
CREATE UNIQUE INDEX uq_parents_org_mobile ON parents (org_id, mobile) WHERE mobile IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_parents_org_email ON parents (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE INDEX idx_parents_user ON parents (user_id) WHERE user_id IS NOT NULL;
CREATE TRIGGER trg_parents_updated BEFORE UPDATE ON parents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE learners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  branch_id      uuid,
  user_id        uuid REFERENCES users(id),
  learner_code   text NOT NULL,                       -- e.g. RK-LRN-000124 (immutable)
  full_name      text NOT NULL,
  mobile         text,                                -- normalised: +91XXXXXXXXXX
  email          text,
  date_of_birth  date,
  gender         text CHECK (gender IN ('female','male','other','undisclosed')),
  school         text,
  location       text,
  photo_url      text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  enrolled_on    date NOT NULL DEFAULT CURRENT_DATE,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (org_id, learner_code),
  UNIQUE (id, org_id),
  FOREIGN KEY (branch_id, org_id) REFERENCES branches (id, org_id)
);
CREATE UNIQUE INDEX uq_learners_org_mobile ON learners (org_id, mobile) WHERE mobile IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_learners_org_email ON learners (org_id, lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_learners_org_status ON learners (org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_learners_org_name ON learners (org_id, lower(full_name), id) WHERE deleted_at IS NULL;
CREATE INDEX idx_learners_org_created ON learners (org_id, created_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX idx_learners_org_enrolled ON learners (org_id, enrolled_on) WHERE deleted_at IS NULL;
CREATE INDEX idx_learners_branch ON learners (branch_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_learners_user ON learners (user_id) WHERE user_id IS NOT NULL;
-- Substring search (ILIKE '%x%') over name, code, mobile, email and parent details.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX idx_learners_name_trgm ON learners USING gin (full_name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX idx_learners_code_trgm ON learners USING gin (learner_code gin_trgm_ops)';
    EXECUTE 'CREATE INDEX idx_learners_mobile_trgm ON learners USING gin (mobile gin_trgm_ops)';
    EXECUTE 'CREATE INDEX idx_learners_email_trgm ON learners USING gin (email gin_trgm_ops)';
    EXECUTE 'CREATE INDEX idx_parents_name_trgm ON parents USING gin (full_name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX idx_parents_mobile_trgm ON parents USING gin (mobile gin_trgm_ops)';
  END IF;
END $$;
CREATE TRIGGER trg_learners_updated BEFORE UPDATE ON learners FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE learner_parents (
  learner_id    uuid NOT NULL,
  parent_id     uuid NOT NULL,
  org_id        uuid NOT NULL REFERENCES organizations(id),
  relationship  text NOT NULL DEFAULT 'guardian',
  is_primary    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (learner_id, parent_id),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  FOREIGN KEY (parent_id, org_id) REFERENCES parents (id, org_id)
);
CREATE INDEX idx_learner_parents_parent ON learner_parents (parent_id);
CREATE UNIQUE INDEX uq_learner_primary_parent ON learner_parents (learner_id) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- Batches and memberships
-- ---------------------------------------------------------------------------
CREATE TABLE batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  branch_id      uuid,
  program_id     uuid NOT NULL,
  course_id      uuid NOT NULL,
  batch_code     text NOT NULL,                         -- e.g. RK-BAT-0042
  name           text NOT NULL,
  academic_year  text NOT NULL,                         -- e.g. 2026-27
  start_date     date,
  end_date       date,
  schedule       jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {days:[1,3], start:"17:00", end:"18:30", mode:"online"}
  capacity       integer CHECK (capacity IS NULL OR capacity > 0),
  status         text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','active','completed','archived')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (org_id, batch_code),
  UNIQUE (id, org_id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  FOREIGN KEY (branch_id, org_id) REFERENCES branches (id, org_id),
  FOREIGN KEY (program_id, org_id) REFERENCES programs (id, org_id),
  FOREIGN KEY (course_id, org_id) REFERENCES courses (id, org_id)
);
CREATE INDEX idx_batches_org_status ON batches (org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_batches_course ON batches (course_id);
CREATE INDEX idx_batches_program ON batches (program_id);
CREATE INDEX idx_batches_branch ON batches (branch_id);
CREATE INDEX idx_batches_year ON batches (org_id, academic_year);
CREATE TRIGGER trg_batches_updated BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- THE learner ↔ batch relationship. One row per (learner, batch), ever.
-- Re-joining a batch re-activates the same row; history lives in learner_activity.
CREATE TABLE learner_batch_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id),
  learner_id   uuid NOT NULL,
  batch_id     uuid NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','left','transferred')),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,
  left_reason  text,
  enrolled_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_learner_batch UNIQUE (learner_id, batch_id),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE INDEX idx_lbm_batch_status ON learner_batch_memberships (batch_id, status);
CREATE INDEX idx_lbm_learner_status ON learner_batch_memberships (learner_id, status);
CREATE INDEX idx_lbm_org ON learner_batch_memberships (org_id);
CREATE TRIGGER trg_lbm_updated BEFORE UPDATE ON learner_batch_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE teacher_batch_memberships (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id),
  batch_id         uuid NOT NULL,
  teacher_user_id  uuid NOT NULL,
  role             text NOT NULL DEFAULT 'lead' CHECK (role IN ('lead','co')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  removed_at       timestamptz,
  assigned_by      uuid REFERENCES users(id),
  CONSTRAINT uq_teacher_batch UNIQUE (batch_id, teacher_user_id),
  FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  FOREIGN KEY (teacher_user_id, org_id) REFERENCES users (id, org_id)
);
CREATE INDEX idx_tbm_teacher_status ON teacher_batch_memberships (teacher_user_id, status);
CREATE INDEX idx_tbm_batch_status ON teacher_batch_memberships (batch_id, status);
-- At most one active lead teacher per batch.
CREATE UNIQUE INDEX uq_tbm_one_lead ON teacher_batch_memberships (batch_id) WHERE role = 'lead' AND status = 'active';

-- ---------------------------------------------------------------------------
-- Learner activity timeline & audit log
-- ---------------------------------------------------------------------------
CREATE TABLE learner_activity (
  id             bigserial PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organizations(id),
  learner_id     uuid NOT NULL,
  batch_id       uuid,
  type           text NOT NULL,           -- learner.created, batch.joined, batch.left, batch.transferred, ...
  title          text NOT NULL,
  description    text,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id  uuid REFERENCES users(id),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_activity_learner_time ON learner_activity (learner_id, occurred_at DESC, id DESC);
CREATE INDEX idx_activity_org_time ON learner_activity (org_id, occurred_at DESC);

CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  org_id         uuid REFERENCES organizations(id),
  actor_user_id  uuid REFERENCES users(id),
  actor_email    text,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text,
  previous_data  jsonb,
  new_data       jsonb,
  ip             text,
  user_agent     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_time ON audit_logs (org_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs (actor_user_id);

-- ---------------------------------------------------------------------------
-- Seed: system roles and permissions (static reference data)
-- ---------------------------------------------------------------------------
INSERT INTO roles (key, name, description) VALUES
  ('super_admin',  'Super Admin',         'Platform owner; manages organizations'),
  ('org_admin',    'Organization Admin',  'Full control inside one organization'),
  ('branch_admin', 'Branch Admin',        'Manages learners and batches of assigned branch(es)'),
  ('teacher',      'Teacher',             'Works with assigned batches and their learners'),
  ('counsellor',   'Counsellor',          'Leads, CRM and follow-ups'),
  ('accountant',   'Accountant',          'Payments, invoices and fees'),
  ('learner',      'Learner',             'Own data only'),
  ('parent',       'Parent',              'Linked children only');

INSERT INTO permissions (key, description) VALUES
  ('org:manage',         'Update organization settings'),
  ('branch:manage',      'Create and edit branches'),
  ('catalog:read',       'View programs, courses and branches'),
  ('catalog:manage',     'Create and edit programs and courses'),
  ('user:manage',        'Create and manage staff users and roles'),
  ('teacher:read',       'View teachers'),
  ('learner:read',       'View learners in scope'),
  ('learner:create',     'Create learners'),
  ('learner:update',     'Edit learner profile'),
  ('learner:delete',     'Archive and restore learners'),
  ('learner:export',     'Export learner data'),
  ('learner:bulk',       'Run bulk actions on learners'),
  ('learner:login',      'Create learner/parent portal logins'),
  ('parent:read',        'View parents'),
  ('parent:manage',      'Create and edit parents'),
  ('batch:read',         'View batches in scope'),
  ('batch:create',       'Create batches'),
  ('batch:update',       'Edit batches'),
  ('batch:enroll',       'Add and remove learners from batches'),
  ('batch:assign_teacher','Assign teachers to batches'),
  ('selection:resolve',  'Use the batch selection engine'),
  ('dashboard:view',     'View role dashboard'),
  ('audit:read',         'View audit logs'),
  ('portal:learner',     'Learner self-service portal'),
  ('portal:parent',      'Parent self-service portal');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
  (r.key IN ('super_admin','org_admin'))
  OR (r.key = 'branch_admin' AND p.key IN ('catalog:read','catalog:manage','user:manage','teacher:read','learner:read','learner:create','learner:update','learner:delete','learner:export','learner:bulk','learner:login','parent:read','parent:manage','batch:read','batch:create','batch:update','batch:enroll','batch:assign_teacher','selection:resolve','dashboard:view','audit:read'))
  OR (r.key = 'teacher' AND p.key IN ('catalog:read','teacher:read','learner:read','parent:read','batch:read','selection:resolve','dashboard:view'))
  OR (r.key = 'counsellor' AND p.key IN ('catalog:read','teacher:read','learner:read','learner:create','learner:update','learner:export','parent:read','parent:manage','batch:read','batch:enroll','selection:resolve','dashboard:view'))
  OR (r.key = 'accountant' AND p.key IN ('catalog:read','learner:read','parent:read','batch:read','dashboard:view'))
  OR (r.key = 'learner' AND p.key IN ('portal:learner','dashboard:view'))
  OR (r.key = 'parent' AND p.key IN ('portal:parent','dashboard:view'));
