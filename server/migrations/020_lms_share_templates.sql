-- Phase 16: a self-paced LMS (courses for learners and for staff onboarding), certificate templates with automatic issue
-- when a batch completes, and nothing else that needs a table (share cards and the timetable read existing data).

ALTER TABLE certificate_designs
  ADD COLUMN template VARCHAR(10) NOT NULL DEFAULT 'classic',
  ADD COLUMN accent   VARCHAR(7)  NULL,
  ADD CONSTRAINT chk_cert_design_template CHECK (template IN ('classic','modern','playful','minimal','midnight')),
  ADD CONSTRAINT chk_cert_design_accent CHECK (accent IS NULL OR accent REGEXP '^#[0-9a-fA-F]{6}$');
-- what a certificate looked like when it was issued is frozen with it
ALTER TABLE certificates
  ADD COLUMN template VARCHAR(10) NOT NULL DEFAULT 'classic',
  ADD COLUMN accent   VARCHAR(7)  NULL;

ALTER TABLE batches
  ADD COLUMN completion_certificate_design_id VARCHAR(36) NULL,
  ADD COLUMN completion_certificates_issued_at DATETIME(3) NULL,
  ADD CONSTRAINT fk_batch_cert_design FOREIGN KEY (completion_certificate_design_id, org_id) REFERENCES certificate_designs (id, org_id);

CREATE TABLE lms_courses (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id         VARCHAR(36) NOT NULL,
  title          VARCHAR(160) NOT NULL,
  summary        VARCHAR(500) NULL,
  audience       VARCHAR(8) NOT NULL DEFAULT 'learners',      -- learners | staff | both
  status         VARCHAR(10) NOT NULL DEFAULT 'draft',        -- draft | published | archived
  color          VARCHAR(7) NOT NULL DEFAULT '#12263f',
  certificate_design_id VARCHAR(36) NULL,                     -- issued automatically to a learner who completes the course
  created_by     VARCHAR(36) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at     DATETIME(3) NULL,
  UNIQUE KEY uq_lms_course_id_org (id, org_id),
  KEY idx_lms_course_org (org_id, status),
  CONSTRAINT fk_lms_course_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_lms_course_design FOREIGN KEY (certificate_design_id, org_id) REFERENCES certificate_designs (id, org_id),
  CONSTRAINT chk_lms_course_audience CHECK (audience IN ('learners','staff','both')),
  CONSTRAINT chk_lms_course_status CHECK (status IN ('draft','published','archived')),
  CONSTRAINT chk_lms_course_color CHECK (color REGEXP '^#[0-9a-fA-F]{6}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_lessons (
  id           VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id       VARCHAR(36) NOT NULL,
  course_id    VARCHAR(36) NOT NULL,
  position     INT NOT NULL,
  title        VARCHAR(160) NOT NULL,
  kind         VARCHAR(8) NOT NULL,                           -- text | video | link | quiz
  body         TEXT NULL,
  url          VARCHAR(500) NULL,
  minutes      SMALLINT NULL,
  questions    JSON NULL,                                     -- quiz: [{q, options[], answer}]; the answer never leaves the server for a learner
  pass_percent TINYINT NOT NULL DEFAULT 70,
  required     BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at   DATETIME(3) NULL,
  KEY idx_lms_lesson_course (course_id, position),
  CONSTRAINT fk_lms_lesson_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id),
  CONSTRAINT chk_lms_lesson_kind CHECK (kind IN ('text','video','link','quiz'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_enrollments (
  id           VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id       VARCHAR(36) NOT NULL,
  course_id    VARCHAR(36) NOT NULL,
  user_id      VARCHAR(36) NULL,                              -- a staff member (onboarding) ...
  learner_id   VARCHAR(36) NULL,                              -- ... or a learner
  assigned_by  VARCHAR(36) NULL,
  due_at       DATETIME(3) NULL,
  started_at   DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  last_activity_at DATETIME(3) NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'active',         -- active | completed | removed
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  person_key   VARCHAR(36) GENERATED ALWAYS AS (IF(status = 'removed', NULL, COALESCE(user_id, learner_id))) STORED,
  UNIQUE KEY uq_lms_enrollment (course_id, person_key),
  UNIQUE KEY uq_lms_enrollment_id_org (id, org_id),
  KEY idx_lms_enr_user (user_id, status),
  KEY idx_lms_enr_learner (learner_id, status),
  CONSTRAINT fk_lms_enr_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id),
  CONSTRAINT fk_lms_enr_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_lms_enr_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_lms_enr_one CHECK ((user_id IS NULL) <> (learner_id IS NULL)),
  CONSTRAINT chk_lms_enr_status CHECK (status IN ('active','completed','removed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_progress (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  enrollment_id VARCHAR(36) NOT NULL,
  lesson_id     VARCHAR(36) NOT NULL,
  completed_at  DATETIME(3) NULL,
  best_score    TINYINT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_lms_progress (enrollment_id, lesson_id),
  CONSTRAINT fk_lms_prog_enr FOREIGN KEY (enrollment_id) REFERENCES lms_enrollments(id) ON DELETE CASCADE,
  CONSTRAINT fk_lms_prog_lesson FOREIGN KEY (lesson_id) REFERENCES lms_lessons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'lms:manage', 'Create courses and lessons, assign them to learners and staff'),
  (UUID(), 'lms:read',   'See course progress of learners and staff');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON r.code IN ('super_admin','org_admin','branch_admin') AND p.code IN ('lms:manage','lms:read');
