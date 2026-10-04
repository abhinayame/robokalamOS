-- Phase 6: CRM. A lead IS a learner profile (one master record): converting never copies data.
-- Tags are reusable labels on learners; activities are the CRM timeline; follow-ups are tasks for staff.

CREATE TABLE tags (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  name        VARCHAR(80) NOT NULL,
  color       VARCHAR(20) NOT NULL DEFAULT 'gray',
  description VARCHAR(200) NULL,
  created_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tags_name (org_id, name),
  UNIQUE KEY uq_tags_id_org (id, org_id),
  CONSTRAINT fk_tags_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_tags_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE learner_tags (
  learner_id VARCHAR(36) NOT NULL,
  tag_id     VARCHAR(36) NOT NULL,
  org_id     VARCHAR(36) NOT NULL,
  added_by   VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (learner_id, tag_id),
  KEY idx_learner_tags_tag (tag_id, learner_id),
  CONSTRAINT fk_lt_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_lt_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_lt_tag FOREIGN KEY (tag_id, org_id) REFERENCES tags (id, org_id) ON DELETE CASCADE,
  CONSTRAINT fk_lt_user FOREIGN KEY (added_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE crm_leads (
  id                    VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id                VARCHAR(36) NOT NULL,
  learner_id            VARCHAR(36) NOT NULL,
  lead_source           VARCHAR(80) NULL,
  lead_status           VARCHAR(16) NOT NULL DEFAULT 'new',
  lost_reason           VARCHAR(255) NULL,
  interested_program_id VARCHAR(36) NULL,
  interested_course_id  VARCHAR(36) NULL,
  interested_batch_id   VARCHAR(36) NULL,
  counsellor_user_id    VARCHAR(36) NULL,
  temperature           VARCHAR(4) NULL,
  next_follow_up_at     DATETIME(3) NULL,           -- kept in step with the earliest open follow-up
  notes                 TEXT NULL,
  converted_at          DATETIME(3) NULL,
  created_by            VARCHAR(36) NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_leads_learner (learner_id),         -- ONE CRM record per learner
  UNIQUE KEY uq_leads_id_org (id, org_id),
  KEY idx_leads_status (org_id, lead_status),
  KEY idx_leads_counsellor (counsellor_user_id, next_follow_up_at),
  CONSTRAINT fk_leads_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_leads_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_leads_counsellor FOREIGN KEY (counsellor_user_id) REFERENCES users(id),
  CONSTRAINT fk_leads_program FOREIGN KEY (interested_program_id, org_id) REFERENCES programs (id, org_id),
  CONSTRAINT fk_leads_course FOREIGN KEY (interested_course_id, org_id) REFERENCES courses (id, org_id),
  CONSTRAINT fk_leads_batch FOREIGN KEY (interested_batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT chk_lead_status CHECK (lead_status IN ('new','contacted','interested','demo_scheduled','demo_attended','follow_up','converted','not_interested','lost')),
  CONSTRAINT chk_lead_temp CHECK (temperature IS NULL OR temperature IN ('cold','warm','hot'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE crm_activities (
  id                VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id            VARCHAR(36) NOT NULL,
  learner_id        VARCHAR(36) NOT NULL,
  type              VARCHAR(40) NOT NULL,
  description       TEXT NULL,
  staff_user_id     VARCHAR(36) NULL,
  occurred_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  next_follow_up_at DATETIME(3) NULL,
  KEY idx_crm_activities_learner (learner_id, occurred_at),
  KEY idx_crm_activities_staff (staff_user_id, occurred_at),
  CONSTRAINT fk_cact_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_cact_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_cact_staff FOREIGN KEY (staff_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE follow_ups (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  learner_id    VARCHAR(36) NOT NULL,
  assigned_to   VARCHAR(36) NOT NULL,
  due_at        DATETIME(3) NOT NULL,
  note          VARCHAR(500) NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'open',
  completed_at  DATETIME(3) NULL,
  completed_by  VARCHAR(36) NULL,
  created_by    VARCHAR(36) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_follow_ups_due (assigned_to, status, due_at),
  KEY idx_follow_ups_learner (learner_id, status),
  CONSTRAINT fk_fu_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_fu_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_fu_user FOREIGN KEY (assigned_to) REFERENCES users(id),
  CONSTRAINT chk_fu_status CHECK (status IN ('open','done','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'crm:read',    'View leads, CRM activities and follow-ups in your scope'),
  (UUID(), 'crm:manage',  'Create and update leads, log activities, assign counsellors, manage follow-ups'),
  (UUID(), 'tag:read',    'See tags on learners'),
  (UUID(), 'tag:apply',   'Add and remove tags on learners'),
  (UUID(), 'tag:manage',  'Create, rename and delete tags');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin','counsellor') AND p.code IN ('crm:read','crm:manage','tag:manage'))
  OR (r.code IN ('super_admin','org_admin','branch_admin','counsellor','teacher','accountant') AND p.code = 'tag:read')
  OR (r.code IN ('super_admin','org_admin','branch_admin','counsellor','teacher') AND p.code = 'tag:apply');
