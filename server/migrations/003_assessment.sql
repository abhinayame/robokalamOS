-- Phase 3: Assessment. Scores (+ audited history), manual activities, quizzes.
-- Every graded thing (assignment, quiz, manual activity) becomes ONE row in `scores` per learner.

CREATE TABLE activities (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  batch_id    VARCHAR(36) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  category    VARCHAR(60) NULL,                 -- Project, Class participation, Competition …
  max_score   DECIMAL(8,2) NOT NULL DEFAULT 100,
  held_on     DATE NULL,
  created_by  VARCHAR(36) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at  DATETIME(3) NULL,
  UNIQUE KEY uq_activities_id_org (id, org_id),
  KEY idx_activities_batch (batch_id, held_on),
  CONSTRAINT fk_act_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_act_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_act_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_act_max CHECK (max_score > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE quizzes (
  id                 VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id             VARCHAR(36) NOT NULL,
  batch_id           VARCHAR(36) NOT NULL,
  topic_id           VARCHAR(36) NULL,
  title              VARCHAR(255) NOT NULL,
  instructions       TEXT NULL,
  time_limit_minutes INT NULL,
  max_attempts       INT NOT NULL DEFAULT 1,
  opens_at           DATETIME(3) NULL,
  closes_at          DATETIME(3) NULL,
  published          BOOLEAN NOT NULL DEFAULT FALSE,   -- learners never see drafts or questions
  reveal_answers     BOOLEAN NOT NULL DEFAULT FALSE,   -- show correct answers after submitting
  created_by         VARCHAR(36) NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at         DATETIME(3) NULL,
  UNIQUE KEY uq_quizzes_id_org (id, org_id),
  KEY idx_quizzes_batch (batch_id, published),
  CONSTRAINT fk_quiz_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_quiz_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_quiz_topic FOREIGN KEY (topic_id, org_id) REFERENCES topics (id, org_id),
  CONSTRAINT fk_quiz_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_quiz_attempts CHECK (max_attempts BETWEEN 1 AND 20),
  CONSTRAINT chk_quiz_time CHECK (time_limit_minutes IS NULL OR time_limit_minutes BETWEEN 1 AND 600)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE questions (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  quiz_id     VARCHAR(36) NOT NULL,
  kind        VARCHAR(8) NOT NULL,              -- single | multiple | short (all auto-graded)
  prompt      TEXT NOT NULL,
  options     JSON NULL,                        -- ["A","B",…] for single / multiple
  answer_key  JSON NULL,                        -- single: index; multiple: [indexes]; short: ["accepted answer",…]
  marks       DECIMAL(6,2) NOT NULL DEFAULT 1,
  position    INT NOT NULL DEFAULT 0,
  KEY idx_questions_quiz (quiz_id, position),
  CONSTRAINT fk_q_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_q_quiz FOREIGN KEY (quiz_id, org_id) REFERENCES quizzes (id, org_id),
  CONSTRAINT chk_q_kind CHECK (kind IN ('single','multiple','short')),
  CONSTRAINT chk_q_marks CHECK (marks > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE quiz_attempts (
  id           VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id       VARCHAR(36) NOT NULL,
  quiz_id      VARCHAR(36) NOT NULL,
  learner_id   VARCHAR(36) NOT NULL,
  attempt_no   INT NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'in_progress',   -- in_progress | submitted | expired
  answers      JSON NULL,
  started_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deadline_at  DATETIME(3) NULL,                              -- started_at + time limit, set by the server
  submitted_at DATETIME(3) NULL,
  score        DECIMAL(8,2) NULL,
  max_score    DECIMAL(8,2) NULL,
  UNIQUE KEY uq_attempt_no (quiz_id, learner_id, attempt_no),
  KEY idx_attempts_learner (learner_id, status),
  CONSTRAINT fk_qa_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_qa_quiz FOREIGN KEY (quiz_id, org_id) REFERENCES quizzes (id, org_id),
  CONSTRAINT fk_qa_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_qa_status CHECK (status IN ('in_progress','submitted','expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE scores (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  learner_id      VARCHAR(36) NOT NULL,
  batch_id        VARCHAR(36) NOT NULL,
  teacher_user_id VARCHAR(36) NOT NULL,         -- who last set it (for quizzes: the teacher who authored it)
  source_type     VARCHAR(12) NOT NULL,         -- assignment | quiz | activity
  source_id       VARCHAR(36) NOT NULL,
  activity_name   VARCHAR(255) NOT NULL,        -- snapshot, so history reads right even after a rename
  category        VARCHAR(60) NULL,
  score           DECIMAL(8,2) NOT NULL,
  max_score       DECIMAL(8,2) NOT NULL,
  feedback        TEXT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3) NULL,
  -- one live score per learner per graded item; removing a score frees the slot
  live_key        VARCHAR(36) GENERATED ALWAYS AS (IF(deleted_at IS NULL, source_id, NULL)) STORED,
  UNIQUE KEY uq_scores_id_org (id, org_id),
  UNIQUE KEY uq_scores_live (learner_id, batch_id, source_type, live_key),
  KEY idx_scores_learner (learner_id, created_at),
  KEY idx_scores_batch (batch_id, source_type, source_id),
  CONSTRAINT fk_scores_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_scores_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_scores_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_scores_teacher FOREIGN KEY (teacher_user_id) REFERENCES users(id),
  CONSTRAINT chk_score_range CHECK (score >= 0 AND max_score > 0 AND score <= max_score),
  CONSTRAINT chk_score_src CHECK (source_type IN ('assignment','quiz','activity'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE score_history (
  id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  score_id        VARCHAR(36) NOT NULL,
  changed_by      VARCHAR(36) NOT NULL,
  action          VARCHAR(8) NOT NULL,          -- created | updated | deleted
  previous_score  DECIMAL(8,2) NULL,
  new_score       DECIMAL(8,2) NULL,
  previous_max    DECIMAL(8,2) NULL,
  new_max         DECIMAL(8,2) NULL,
  previous_feedback TEXT NULL,
  new_feedback    TEXT NULL,
  changed_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_score_history_score (score_id, changed_at),
  CONSTRAINT fk_sh_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_sh_score FOREIGN KEY (score_id, org_id) REFERENCES scores (id, org_id),
  CONSTRAINT fk_sh_user FOREIGN KEY (changed_by) REFERENCES users(id),
  CONSTRAINT chk_sh_action CHECK (action IN ('created','updated','deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
