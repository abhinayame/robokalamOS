-- Phase 18: a fuller LMS (course landing pages, modules, open enrolment, sequential lessons, assignments, notes,
-- reviews, Q&A, announcements, quiz attempts and analytics). Everything here is additive: existing courses keep working.

ALTER TABLE lms_courses
  ADD COLUMN category        VARCHAR(60)  NULL,
  ADD COLUMN level           VARCHAR(12)  NULL,
  ADD COLUMN description     TEXT         NULL,
  ADD COLUMN outcomes        JSON         NULL,                       -- "What you will learn": a list of short lines
  ADD COLUMN requirements    VARCHAR(500) NULL,
  ADD COLUMN instructor_name VARCHAR(120) NULL,
  ADD COLUMN language        VARCHAR(30)  NOT NULL DEFAULT 'English',
  ADD COLUMN icon            VARCHAR(8)   NULL,
  ADD COLUMN enrollment_mode VARCHAR(8)   NOT NULL DEFAULT 'assigned', -- assigned (admin gives it) | open (people enrol themselves from the catalog)
  ADD COLUMN sequential      BOOLEAN      NOT NULL DEFAULT FALSE,     -- lessons unlock one after another
  ADD COLUMN min_grade       TINYINT      NULL,                       -- average quiz score needed to complete the course
  ADD COLUMN xp_reward       SMALLINT     NOT NULL DEFAULT 0,         -- XP a learner earns on completing the course
  ADD COLUMN published_at    DATETIME(3)  NULL,
  ADD CONSTRAINT chk_lms_course_level CHECK (level IS NULL OR level IN ('beginner','intermediate','advanced')),
  ADD CONSTRAINT chk_lms_course_enrol CHECK (enrollment_mode IN ('assigned','open')),
  ADD CONSTRAINT chk_lms_course_grade CHECK (min_grade IS NULL OR (min_grade BETWEEN 1 AND 100));
UPDATE lms_courses SET published_at = COALESCE(updated_at, created_at) WHERE status = 'published';

CREATE TABLE lms_modules (
  id        VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id    VARCHAR(36) NOT NULL,
  course_id VARCHAR(36) NOT NULL,
  position  INT NOT NULL,
  title     VARCHAR(160) NOT NULL,
  summary   VARCHAR(500) NULL,
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_lms_module_id_org (id, org_id),
  KEY idx_lms_module_course (course_id, position),
  CONSTRAINT fk_lms_module_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE lms_lessons
  ADD COLUMN module_id     VARCHAR(36) NULL,
  ADD COLUMN max_attempts  TINYINT NULL,                              -- quiz: NULL = unlimited
  ADD COLUMN shuffle       BOOLEAN NOT NULL DEFAULT FALSE,            -- quiz: questions and options in a different order each time
  ADD COLUMN show_answers  BOOLEAN NOT NULL DEFAULT TRUE,             -- quiz: reveal correct answers and explanations once passed or out of attempts
  ADD COLUMN auto_accept   BOOLEAN NOT NULL DEFAULT TRUE,             -- assignment: a submission counts as done at once (otherwise a reviewer accepts it)
  ADD CONSTRAINT fk_lms_lesson_module FOREIGN KEY (module_id, org_id) REFERENCES lms_modules (id, org_id);
ALTER TABLE lms_lessons MODIFY kind VARCHAR(12) NOT NULL;
ALTER TABLE lms_lessons DROP CONSTRAINT chk_lms_lesson_kind, ADD CONSTRAINT chk_lms_lesson_kind CHECK (kind IN ('text','video','link','quiz','file','assignment'));
ALTER TABLE files DROP CONSTRAINT chk_files_owner, ADD CONSTRAINT chk_files_owner CHECK (owner_type IS NULL OR owner_type IN ('material','assignment','submission','branding','portfolio','lms_lesson','lms_submission'));

-- every quiz try is kept: retake limits, question-by-question analytics, and an honest history
CREATE TABLE lms_attempts (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  enrollment_id VARCHAR(36) NOT NULL,
  lesson_id     VARCHAR(36) NOT NULL,
  answers       JSON NOT NULL,
  score         TINYINT NOT NULL,
  passed        BOOLEAN NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lms_attempt (enrollment_id, lesson_id),
  KEY idx_lms_attempt_lesson (lesson_id),
  CONSTRAINT fk_lms_attempt_enr FOREIGN KEY (enrollment_id) REFERENCES lms_enrollments(id),
  CONSTRAINT fk_lms_attempt_lesson FOREIGN KEY (lesson_id) REFERENCES lms_lessons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_notes (
  enrollment_id VARCHAR(36) NOT NULL,
  lesson_id     VARCHAR(36) NOT NULL,
  body          TEXT NOT NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (enrollment_id, lesson_id),
  CONSTRAINT fk_lms_note_enr FOREIGN KEY (enrollment_id) REFERENCES lms_enrollments(id),
  CONSTRAINT fk_lms_note_lesson FOREIGN KEY (lesson_id) REFERENCES lms_lessons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_submissions (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  enrollment_id VARCHAR(36) NOT NULL,
  lesson_id     VARCHAR(36) NOT NULL,
  body          TEXT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'submitted',            -- submitted | accepted | returned
  feedback      VARCHAR(2000) NULL,
  reviewed_by   VARCHAR(36) NULL,
  reviewed_at   DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_lms_submission (enrollment_id, lesson_id),
  KEY idx_lms_submission_queue (org_id, status, updated_at),
  CONSTRAINT fk_lms_sub_enr FOREIGN KEY (enrollment_id) REFERENCES lms_enrollments(id),
  CONSTRAINT fk_lms_sub_lesson FOREIGN KEY (lesson_id) REFERENCES lms_lessons(id),
  CONSTRAINT chk_lms_sub_status CHECK (status IN ('submitted','accepted','returned'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_reviews (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  course_id  VARCHAR(36) NOT NULL,
  user_id    VARCHAR(36) NULL,
  learner_id VARCHAR(36) NULL,
  rating     TINYINT NOT NULL,
  comment    VARCHAR(1000) NULL,
  hidden_at  DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  person_key VARCHAR(36) GENERATED ALWAYS AS (COALESCE(user_id, learner_id)) STORED,
  UNIQUE KEY uq_lms_review (course_id, person_key),
  CONSTRAINT fk_lms_review_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id),
  CONSTRAINT chk_lms_review_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT chk_lms_review_one CHECK ((user_id IS NULL) <> (learner_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_discussions (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  course_id  VARCHAR(36) NOT NULL,
  lesson_id  VARCHAR(36) NULL,
  author_id  VARCHAR(36) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       VARCHAR(4000) NOT NULL,
  resolved   BOOLEAN NOT NULL DEFAULT FALSE,
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_at  DATETIME(3) NULL,
  last_activity_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lms_disc_course (course_id, pinned, last_activity_at),
  CONSTRAINT fk_lms_disc_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id),
  CONSTRAINT fk_lms_disc_author FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_replies (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  discussion_id VARCHAR(36) NOT NULL,
  author_id     VARCHAR(36) NOT NULL,
  body          VARCHAR(4000) NOT NULL,
  is_staff      BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_at     DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lms_reply (discussion_id, created_at),
  CONSTRAINT fk_lms_reply_disc FOREIGN KEY (discussion_id) REFERENCES lms_discussions(id),
  CONSTRAINT fk_lms_reply_author FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_announcements (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  course_id  VARCHAR(36) NOT NULL,
  title      VARCHAR(160) NOT NULL,
  body       VARCHAR(4000) NOT NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lms_ann_course (course_id, created_at),
  CONSTRAINT fk_lms_ann_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- taking a course (and uploading or downloading its files) is for everyone who studies or works at the school except parents
INSERT INTO permissions (id, code, description) VALUES (UUID(), 'lms:learn', 'Take courses assigned to you, join open courses, upload assignment files');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'lms:learn' WHERE r.code IN ('super_admin','org_admin','branch_admin','counsellor','accountant','teacher','learner');
