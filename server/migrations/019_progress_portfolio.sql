-- Phase 15: monthly progress reports for parents (teacher notes) and a project portfolio per learner.

CREATE TABLE progress_notes (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id         VARCHAR(36) NOT NULL,
  learner_id     VARCHAR(36) NOT NULL,
  batch_id       VARCHAR(36) NOT NULL,
  month          CHAR(7) NOT NULL,                       -- YYYY-MM in the organization's time zone
  body           VARCHAR(1000) NOT NULL,
  author_user_id VARCHAR(36) NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_progress_note (learner_id, batch_id, month, author_user_id),
  KEY idx_progress_note_batch (batch_id, month),
  CONSTRAINT fk_pn_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_pn_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_pn_author FOREIGN KEY (author_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE portfolio_items (
  id                 VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id             VARCHAR(36) NOT NULL,
  learner_id         VARCHAR(36) NOT NULL,
  batch_id           VARCHAR(36) NULL,
  title              VARCHAR(120) NOT NULL,
  description        VARCHAR(1000) NULL,
  video_url          VARCHAR(500) NULL,
  status             VARCHAR(10) NOT NULL DEFAULT 'pending',   -- pending (waiting for a teacher) | published | rejected
  submitted_by       VARCHAR(36) NOT NULL,
  reviewed_by        VARCHAR(36) NULL,
  reviewed_at        DATETIME(3) NULL,
  reject_reason      VARCHAR(300) NULL,
  feedback           VARCHAR(500) NULL,
  feedback_by        VARCHAR(36) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3) NULL,
  KEY idx_portfolio_learner (learner_id, status, created_at),
  KEY idx_portfolio_queue (org_id, status, created_at),
  CONSTRAINT fk_pf_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_pf_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT chk_pf_status CHECK (status IN ('pending','published','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE files DROP CONSTRAINT chk_files_owner;
ALTER TABLE files ADD CONSTRAINT chk_files_owner CHECK (owner_type IS NULL OR owner_type IN ('material','assignment','submission','branding','portfolio'));

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'portfolio:review', 'Approve, reject and comment on learners\' portfolio items, and add items for them');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON r.code IN ('super_admin','org_admin','branch_admin','teacher') AND p.code = 'portfolio:review';
