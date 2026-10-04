-- Phase 4: Gamification. XP is an append-only LEDGER; balance = SUM(points). Never an editable total.

CREATE TABLE xp_transactions (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  learner_id  VARCHAR(36) NOT NULL,
  batch_id    VARCHAR(36) NULL,                -- the classroom the XP was earned in (drives batch leaderboards)
  points      INT NOT NULL,                    -- negative = correction / reversal; rows are never edited or deleted
  reason      VARCHAR(255) NOT NULL,
  source_type VARCHAR(20) NULL,                -- manual | badge | score | bulk | reversal
  source_id   VARCHAR(64) NULL,
  dedupe_key  VARCHAR(120) NULL,               -- makes retries / double clicks idempotent
  created_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_xp_dedupe (dedupe_key),
  KEY idx_xp_learner (learner_id, created_at),
  KEY idx_xp_batch (batch_id, created_at, learner_id),
  KEY idx_xp_source (source_type, source_id),
  CONSTRAINT fk_xp_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_xp_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_xp_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_xp_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_xp_points CHECK (points <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE badges (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  name        VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  icon        VARCHAR(16) NOT NULL DEFAULT '🏆',
  category    VARCHAR(60) NULL,
  xp_reward   INT NOT NULL DEFAULT 0,
  criteria    VARCHAR(500) NULL,
  status      VARCHAR(10) NOT NULL DEFAULT 'active',
  created_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_badges_name (org_id, name),
  UNIQUE KEY uq_badges_id_org (id, org_id),
  CONSTRAINT fk_badges_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_badge_status CHECK (status IN ('active','inactive','archived')),
  CONSTRAINT chk_badge_xp CHECK (xp_reward BETWEEN 0 AND 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE learner_badges (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  learner_id  VARCHAR(36) NOT NULL,
  badge_id    VARCHAR(36) NOT NULL,
  batch_id    VARCHAR(36) NULL,
  awarded_by  VARCHAR(36) NOT NULL,
  reason      VARCHAR(500) NULL,
  xp_awarded  INT NOT NULL DEFAULT 0,
  awarded_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at  DATETIME(3) NULL,
  revoked_by  VARCHAR(36) NULL,
  revoke_reason VARCHAR(255) NULL,
  -- one live award per learner per badge (and batch); revoking frees the slot
  active_key  VARCHAR(120) GENERATED ALWAYS AS (IF(revoked_at IS NULL, CONCAT(learner_id, ':', badge_id, ':', IFNULL(batch_id, '-')), NULL)) STORED,
  UNIQUE KEY uq_learner_badge_once (active_key),
  UNIQUE KEY uq_lb_id_org (id, org_id),
  KEY idx_lb_learner (learner_id, awarded_at),
  KEY idx_lb_batch (batch_id, awarded_at),
  CONSTRAINT fk_lb_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_lb_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_lb_badge FOREIGN KEY (badge_id, org_id) REFERENCES badges (id, org_id),
  CONSTRAINT fk_lb_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_lb_user FOREIGN KEY (awarded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional, org-customisable levels. An org with no rows uses the built-in defaults (see levels.ts).
CREATE TABLE levels (
  id        VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id    VARCHAR(36) NOT NULL,
  level_no  INT NOT NULL,
  name      VARCHAR(80) NOT NULL,
  min_xp    INT NOT NULL,
  UNIQUE KEY uq_levels_no (org_id, level_no),
  UNIQUE KEY uq_levels_xp (org_id, min_xp),
  CONSTRAINT fk_levels_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_level_xp CHECK (min_xp >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Competition is opt-in: the leaderboard is OFF until an admin turns it on.
CREATE TABLE gamification_settings (
  org_id              VARCHAR(36) NOT NULL PRIMARY KEY,
  leaderboard_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by          VARCHAR(36) NULL,
  updated_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_gs_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'gamification:read',   'See XP, levels, badges and (if enabled) leaderboards'),
  (UUID(), 'gamification:award',  'Award XP and badges to learners in your scope'),
  (UUID(), 'gamification:manage', 'Create badges, customise levels, switch the leaderboard on or off');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin','teacher','counsellor','learner','parent') AND p.code = 'gamification:read')
  OR (r.code IN ('super_admin','org_admin','branch_admin','teacher') AND p.code = 'gamification:award')
  OR (r.code IN ('super_admin','org_admin') AND p.code = 'gamification:manage');
