-- Phase 17: provider self-test permission (more tables are added below as the phase grows).
INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'system:test', 'Run live self-tests of WhatsApp, e-mail, Razorpay and Zoom from the System status page');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'system:test' WHERE r.code IN ('super_admin','org_admin');

-- ---------------------------------------------------------------- parent-teacher chat (one family thread per learner)
INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'chat:use', 'Send and read messages in family threads you belong to'),
  (UUID(), 'chat:moderate', 'See every family thread, hide a message, close a thread');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'chat:use' WHERE r.code IN ('super_admin','org_admin','branch_admin','counsellor','teacher','parent');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'chat:moderate' WHERE r.code IN ('super_admin','org_admin');

CREATE TABLE chat_threads (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  learner_id      VARCHAR(36) NOT NULL,
  status          VARCHAR(8) NOT NULL DEFAULT 'open',
  last_message_at DATETIME(3) NULL,
  created_by      VARCHAR(36) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_chat_thread_learner (org_id, learner_id),
  UNIQUE KEY uq_chat_thread_id_org (id, org_id),
  KEY idx_chat_thread_recent (org_id, last_message_at),
  CONSTRAINT fk_chat_thread_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_chat_thread_status CHECK (status IN ('open','closed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE chat_messages (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  thread_id   VARCHAR(36) NOT NULL,
  sender_id   VARCHAR(36) NOT NULL,
  body        VARCHAR(2000) NOT NULL,
  hidden_at   DATETIME(3) NULL,
  hidden_by   VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_chat_msg_thread (thread_id, created_at),
  CONSTRAINT fk_chat_msg_thread FOREIGN KEY (thread_id, org_id) REFERENCES chat_threads (id, org_id),
  CONSTRAINT fk_chat_msg_sender FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE chat_reads (
  thread_id    VARCHAR(36) NOT NULL,
  user_id      VARCHAR(36) NOT NULL,
  last_read_at DATETIME(3) NOT NULL,
  PRIMARY KEY (thread_id, user_id),
  CONSTRAINT fk_chat_read_thread FOREIGN KEY (thread_id) REFERENCES chat_threads(id),
  CONSTRAINT fk_chat_read_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- web push (a notification is pushed once, by a worker)
ALTER TABLE notifications ADD COLUMN push_state VARCHAR(8) NOT NULL DEFAULT 'pending', ADD KEY idx_notif_push (push_state, created_at),
  ADD CONSTRAINT chk_notif_push CHECK (push_state IN ('pending','sent','skipped'));
UPDATE notifications SET push_state = 'skipped';   -- never push history

CREATE TABLE push_subscriptions (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  user_id       VARCHAR(36) NOT NULL,
  endpoint_hash CHAR(64) NOT NULL,
  endpoint      VARCHAR(1000) NOT NULL,
  p256dh        VARCHAR(200) NOT NULL,
  auth          VARCHAR(100) NOT NULL,
  user_agent    VARCHAR(200) NULL,
  failures      TINYINT NOT NULL DEFAULT 0,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_ok_at    DATETIME(3) NULL,
  UNIQUE KEY uq_push_endpoint (endpoint_hash),
  KEY idx_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- question bank + learning paths
INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'qbank:manage', 'Write and edit questions in the question bank');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'qbank:manage' WHERE r.code IN ('super_admin','org_admin','branch_admin','teacher');

CREATE TABLE qb_questions (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  topic       VARCHAR(80) NOT NULL,
  difficulty  VARCHAR(6) NOT NULL DEFAULT 'medium',
  q           VARCHAR(300) NOT NULL,
  options     JSON NOT NULL,
  answer      TINYINT NOT NULL,
  created_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3) NULL,
  KEY idx_qb_topic (org_id, topic, difficulty),
  CONSTRAINT fk_qb_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_qb_difficulty CHECK (difficulty IN ('easy','medium','hard'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_paths (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  title      VARCHAR(160) NOT NULL,
  summary    VARCHAR(500) NULL,
  status     VARCHAR(10) NOT NULL DEFAULT 'draft',
  created_by VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_lms_path_id_org (id, org_id),
  CONSTRAINT fk_lms_path_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_lms_path_status CHECK (status IN ('draft','published','archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE lms_path_courses (
  path_id   VARCHAR(36) NOT NULL,
  course_id VARCHAR(36) NOT NULL,
  org_id    VARCHAR(36) NOT NULL,
  position  SMALLINT NOT NULL,
  PRIMARY KEY (path_id, course_id),
  KEY idx_lms_pc_course (course_id),
  CONSTRAINT fk_lms_pc_path FOREIGN KEY (path_id, org_id) REFERENCES lms_paths (id, org_id),
  CONSTRAINT fk_lms_pc_course FOREIGN KEY (course_id, org_id) REFERENCES lms_courses (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- who is walking a path; the next course is unlocked (enrolled) when the previous one is finished
CREATE TABLE lms_path_members (
  id           VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id       VARCHAR(36) NOT NULL,
  path_id      VARCHAR(36) NOT NULL,
  user_id      VARCHAR(36) NULL,
  learner_id   VARCHAR(36) NULL,
  assigned_by  VARCHAR(36) NULL,
  due_days     SMALLINT NULL,                                -- each unlocked course is due this many days after it unlocks
  completed_at DATETIME(3) NULL,
  removed_at   DATETIME(3) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  person_key   VARCHAR(36) GENERATED ALWAYS AS (IF(removed_at IS NOT NULL, NULL, COALESCE(user_id, learner_id))) STORED,
  UNIQUE KEY uq_lms_path_member (path_id, person_key),
  CONSTRAINT fk_lms_pm_path FOREIGN KEY (path_id, org_id) REFERENCES lms_paths (id, org_id),
  CONSTRAINT fk_lms_pm_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_lms_pm_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_lms_pm_one CHECK ((user_id IS NULL) <> (learner_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- QR check-in and live polls
ALTER TABLE attendance DROP CONSTRAINT chk_att_source, ADD CONSTRAINT chk_att_source CHECK (source IN ('manual','auto','qr'));
ALTER TABLE class_sessions ADD COLUMN checkin_secret CHAR(32) NULL, ADD COLUMN checkin_open_until DATETIME(3) NULL;

CREATE TABLE polls (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  batch_id    VARCHAR(36) NOT NULL,
  session_id  VARCHAR(36) NULL,
  question    VARCHAR(300) NOT NULL,
  options     JSON NOT NULL,
  status      VARCHAR(6) NOT NULL DEFAULT 'open',
  created_by  VARCHAR(36) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at   DATETIME(3) NULL,
  UNIQUE KEY uq_poll_id_org (id, org_id),
  KEY idx_poll_batch (batch_id, status, created_at),
  CONSTRAINT fk_poll_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT chk_poll_status CHECK (status IN ('open','closed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE poll_votes (
  poll_id    VARCHAR(36) NOT NULL,
  learner_id VARCHAR(36) NOT NULL,
  org_id     VARCHAR(36) NOT NULL,
  choice     TINYINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (poll_id, learner_id),
  CONSTRAINT fk_vote_poll FOREIGN KEY (poll_id, org_id) REFERENCES polls (id, org_id),
  CONSTRAINT fk_vote_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
