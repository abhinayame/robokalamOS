-- ============================================================================
-- Robokalam Learner OS — Migration 002: Phase 2 Classroom
-- Stream, classwork (topics / materials / assignments), people, submissions, files.
-- A batch IS the classroom: every table references (batch_id, org_id), so there is no
-- copy of learners or batches. Submissions are one row per (assignment, learner).
-- Files are stored privately in the database (hosts such as Hostinger replace the app
-- folder on each deploy, so disk storage would not be durable) and are only ever served
-- through an authenticated, access-checked endpoint.
-- ============================================================================

CREATE TABLE files (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id           VARCHAR(36) NOT NULL,
  uploader_user_id VARCHAR(36) NOT NULL,
  original_name    VARCHAR(255) NOT NULL,
  mime_type        VARCHAR(100) NOT NULL,        -- derived from verified content, never from the client
  size_bytes       INT NOT NULL,
  sha256           VARCHAR(64) NOT NULL,
  owner_type       VARCHAR(20) NULL,             -- NULL until attached: material | assignment | submission
  owner_id         VARCHAR(36) NULL,
  data             LONGBLOB NOT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at       DATETIME(3) NULL,
  KEY idx_files_owner (owner_type, owner_id),
  KEY idx_files_uploader (uploader_user_id, created_at),
  CONSTRAINT fk_files_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_files_uploader FOREIGN KEY (uploader_user_id) REFERENCES users(id),
  CONSTRAINT chk_files_owner CHECK (owner_type IS NULL OR owner_type IN ('material','assignment','submission'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE topics (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  batch_id    VARCHAR(36) NOT NULL,
  title       VARCHAR(200) NOT NULL,
  position    INT NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3) NULL,
  UNIQUE KEY uq_topics_id_org (id, org_id),
  KEY idx_topics_batch (batch_id, position),
  CONSTRAINT fk_topics_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_topics_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE classroom_posts (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id           VARCHAR(36) NOT NULL,
  batch_id         VARCHAR(36) NOT NULL,
  author_user_id   VARCHAR(36) NOT NULL,
  kind             VARCHAR(14) NOT NULL,          -- announcement | link | assignment | material
  title            VARCHAR(255) NULL,
  body             TEXT NULL,
  url              VARCHAR(1000) NULL,
  ref_type         VARCHAR(12) NULL,              -- system posts point at the assignment/material they announce
  ref_id           VARCHAR(36) NULL,
  comments_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pinned           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at       DATETIME(3) NULL,
  UNIQUE KEY uq_posts_id_org (id, org_id),
  KEY idx_posts_batch_time (batch_id, pinned, created_at),
  KEY idx_posts_ref (ref_type, ref_id),
  CONSTRAINT fk_posts_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_posts_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_posts_author FOREIGN KEY (author_user_id) REFERENCES users(id),
  CONSTRAINT chk_post_kind CHECK (kind IN ('announcement','link','assignment','material'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE comments (
  id                 VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id             VARCHAR(36) NOT NULL,
  post_id            VARCHAR(36) NOT NULL,
  parent_comment_id  VARCHAR(36) NULL,
  author_user_id     VARCHAR(36) NOT NULL,
  body               TEXT NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3) NULL,
  KEY idx_comments_post (post_id, created_at),
  CONSTRAINT fk_comments_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_comments_post FOREIGN KEY (post_id, org_id) REFERENCES classroom_posts (id, org_id),
  CONSTRAINT fk_comments_parent FOREIGN KEY (parent_comment_id) REFERENCES comments(id),
  CONSTRAINT fk_comments_author FOREIGN KEY (author_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE materials (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  batch_id      VARCHAR(36) NOT NULL,
  topic_id      VARCHAR(36) NULL,
  title         VARCHAR(255) NOT NULL,
  description   TEXT NULL,
  kind          VARCHAR(8) NOT NULL,              -- pdf | ppt | doc | image | link | video | other
  external_url  VARCHAR(1000) NULL,               -- links and videos (YouTube, Vimeo, private platforms …)
  file_id       VARCHAR(36) NULL,
  position      INT NOT NULL DEFAULT 0,
  created_by    VARCHAR(36) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at    DATETIME(3) NULL,
  UNIQUE KEY uq_materials_id_org (id, org_id),
  KEY idx_materials_batch (batch_id, topic_id, position),
  CONSTRAINT fk_materials_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_materials_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_materials_topic FOREIGN KEY (topic_id, org_id) REFERENCES topics (id, org_id),
  CONSTRAINT fk_materials_file FOREIGN KEY (file_id) REFERENCES files(id),
  CONSTRAINT fk_materials_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_material_kind CHECK (kind IN ('pdf','ppt','doc','image','link','video','other'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE assignments (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  batch_id        VARCHAR(36) NOT NULL,
  topic_id        VARCHAR(36) NULL,
  title           VARCHAR(255) NOT NULL,
  description     TEXT NULL,
  instructions    TEXT NULL,
  due_at          DATETIME(3) NULL,
  max_marks       DECIMAL(8,2) NOT NULL DEFAULT 100,   -- marks themselves are recorded in Phase 3 (scores)
  allow_resubmit  BOOLEAN NOT NULL DEFAULT FALSE,
  position        INT NOT NULL DEFAULT 0,
  created_by      VARCHAR(36) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  UNIQUE KEY uq_assignments_id_org (id, org_id),
  KEY idx_assignments_batch_due (batch_id, due_at),
  CONSTRAINT fk_assign_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_assign_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_assign_topic FOREIGN KEY (topic_id, org_id) REFERENCES topics (id, org_id),
  CONSTRAINT fk_assign_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_assign_marks CHECK (max_marks > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (assignment, learner). "Not started" is the ABSENCE of a row.
CREATE TABLE submissions (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  assignment_id VARCHAR(36) NOT NULL,
  learner_id    VARCHAR(36) NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'draft',
  body          TEXT NULL,
  link_url      VARCHAR(1000) NULL,
  submitted_at  DATETIME(3) NULL,
  evaluated_at  DATETIME(3) NULL,
  evaluated_by  VARCHAR(36) NULL,
  feedback      TEXT NULL,
  version       INT NOT NULL DEFAULT 0,               -- number of times it has been submitted
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_submission_once (assignment_id, learner_id),
  UNIQUE KEY uq_submissions_id_org (id, org_id),
  KEY idx_submissions_status (assignment_id, status),
  KEY idx_submissions_learner (learner_id, status),
  CONSTRAINT fk_sub_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_sub_assign FOREIGN KEY (assignment_id, org_id) REFERENCES assignments (id, org_id),
  CONSTRAINT fk_sub_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_sub_evaluator FOREIGN KEY (evaluated_by) REFERENCES users(id),
  CONSTRAINT chk_sub_status CHECK (status IN ('draft','submitted','late','evaluated','returned'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Permissions
--   classroom:read      see a classroom you belong to (staff in scope, learners, parents)
--   classroom:manage    post, create topics/materials/assignments, review submissions
--   classroom:interact  comment and submit work (learners)
-- ---------------------------------------------------------------------------
INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'classroom:read',     'View classrooms you belong to or manage'),
  (UUID(), 'classroom:manage',   'Post, create classwork and review submissions'),
  (UUID(), 'classroom:interact', 'Comment and submit assignments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin','teacher') AND p.code IN ('classroom:read','classroom:manage'))
  OR (r.code = 'learner' AND p.code IN ('classroom:read','classroom:interact'))
  OR (r.code = 'parent'  AND p.code = 'classroom:read');
