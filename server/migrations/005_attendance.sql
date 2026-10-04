-- Phase 5: class sessions (with live-class links), attendance, in-app notifications.
-- Attendance always belongs to ONE class session of ONE batch; batches are never merged.

CREATE TABLE class_sessions (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id           VARCHAR(36) NOT NULL,
  batch_id         VARCHAR(36) NOT NULL,
  title            VARCHAR(255) NULL,
  starts_at        DATETIME(3) NOT NULL,          -- UTC
  ends_at          DATETIME(3) NULL,
  meeting_provider VARCHAR(12) NULL,              -- google_meet | zoom | webrtc | other
  meeting_url      VARCHAR(1000) NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'scheduled',   -- scheduled | started | completed | cancelled
  cancel_reason    VARCHAR(255) NULL,
  created_by       VARCHAR(36) NOT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sessions_id_org (id, org_id),
  UNIQUE KEY uq_sessions_slot (batch_id, starts_at),         -- generating twice never duplicates a class
  KEY idx_sessions_batch_time (batch_id, starts_at),
  KEY idx_sessions_time (org_id, starts_at),
  CONSTRAINT fk_sess_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_sess_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_sess_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_sess_status CHECK (status IN ('scheduled','started','completed','cancelled')),
  CONSTRAINT chk_sess_provider CHECK (meeting_provider IS NULL OR meeting_provider IN ('google_meet','zoom','webrtc','other')),
  CONSTRAINT chk_sess_times CHECK (ends_at IS NULL OR ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE attendance (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  session_id  VARCHAR(36) NOT NULL,
  batch_id    VARCHAR(36) NOT NULL,               -- denormalised from the session so reports never join across batches by mistake
  learner_id  VARCHAR(36) NOT NULL,
  status      VARCHAR(8) NOT NULL,                -- present | absent | late | excused
  note        VARCHAR(300) NULL,
  marked_by   VARCHAR(36) NOT NULL,
  marked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_attendance_once (session_id, learner_id),
  KEY idx_attendance_learner (learner_id, batch_id),
  KEY idx_attendance_batch (batch_id, status),
  CONSTRAINT fk_att_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_att_session FOREIGN KEY (session_id, org_id) REFERENCES class_sessions (id, org_id),
  CONSTRAINT fk_att_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_att_user FOREIGN KEY (marked_by) REFERENCES users(id),
  CONSTRAINT chk_att_status CHECK (status IN ('present','absent','late','excused'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  user_id     VARCHAR(36) NOT NULL,
  learner_id  VARCHAR(36) NULL,                   -- which child it is about (parents have several)
  kind        VARCHAR(40) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  body        VARCHAR(1000) NULL,
  link        VARCHAR(500) NULL,
  read_at     DATETIME(3) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_notifications_user (user_id, read_at, created_at),
  CONSTRAINT fk_notif_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'attendance:read',   'View attendance and class sessions you belong to or manage'),
  (UUID(), 'attendance:manage', 'Schedule class sessions and mark attendance');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin','teacher','counsellor','learner','parent') AND p.code = 'attendance:read')
  OR (r.code IN ('super_admin','org_admin','branch_admin','teacher') AND p.code = 'attendance:manage');
