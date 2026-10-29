-- Phase 19: chapters inside chapters, auto-assign rules, how someone joined a course.
ALTER TABLE lms_modules
  ADD COLUMN parent_id VARCHAR(36) NULL,                       -- NULL = a chapter; set = a section inside that chapter (one level only)
  ADD CONSTRAINT fk_lms_module_parent FOREIGN KEY (parent_id, org_id) REFERENCES lms_modules (id, org_id);

ALTER TABLE lms_enrollments
  ADD COLUMN source VARCHAR(8) NOT NULL DEFAULT 'assigned',    -- assigned (an admin) | self (joined or took it themselves) | auto (a rule)
  ADD CONSTRAINT chk_lms_enr_source CHECK (source IN ('assigned','self','auto'));
UPDATE lms_enrollments SET source = 'self' WHERE assigned_by IS NULL AND source = 'assigned';

-- "Everyone who becomes a teacher gets Welcome to the team", "everyone who joins this batch gets Robotics basics"
CREATE TABLE lms_auto_rules (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  course_id  VARCHAR(36) NOT NULL,
  kind       VARCHAR(5) NOT NULL,                              -- role | batch
  ref        VARCHAR(36) NOT NULL,                             -- a staff role code, or a batch id
  due_days   SMALLINT NULL,                                    -- due this many days after they are enrolled
  created_by VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_lms_auto_rule (course_id, kind, ref),
  KEY idx_lms_auto_ref (org_id, kind, ref),
  CONSTRAINT fk_lms_auto_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id),
  CONSTRAINT chk_lms_auto_kind CHECK (kind IN ('role','batch'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
