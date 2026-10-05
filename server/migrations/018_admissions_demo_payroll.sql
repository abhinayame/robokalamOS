-- Phase 14: demo class booking, inbound WhatsApp replies, automatic receipts, teacher workload and pay estimates.
-- (Admissions needs no tables: enrolling a lead uses the existing membership, fee and CRM tables in one transaction.)

ALTER TABLE organizations
  ADD COLUMN demo_booking_enabled BOOLEAN NOT NULL DEFAULT FALSE,   -- public booking page is opt-in
  ADD COLUMN receipt_email        BOOLEAN NOT NULL DEFAULT TRUE;    -- e-mail a receipt when a payment is recorded (only if e-mail is configured)

CREATE TABLE demo_slots (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  branch_id   VARCHAR(36) NULL,
  course_id   VARCHAR(36) NULL,
  title       VARCHAR(120) NOT NULL,
  starts_at   DATETIME(3) NOT NULL,
  ends_at     DATETIME(3) NOT NULL,
  capacity    INT NOT NULL DEFAULT 10,
  meeting_url VARCHAR(500) NULL,
  location    VARCHAR(200) NULL,
  host_user_id VARCHAR(36) NULL,
  status      VARCHAR(10) NOT NULL DEFAULT 'open',
  created_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_demo_slot_id_org (id, org_id),
  KEY idx_demo_slots_when (org_id, status, starts_at),
  CONSTRAINT fk_demo_slot_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_demo_slot_branch FOREIGN KEY (branch_id, org_id) REFERENCES branches (id, org_id),
  CONSTRAINT fk_demo_slot_course FOREIGN KEY (course_id, org_id) REFERENCES courses (id, org_id),
  CONSTRAINT chk_demo_slot_status CHECK (status IN ('open','cancelled')),
  CONSTRAINT chk_demo_slot_cap CHECK (capacity BETWEEN 1 AND 500),
  CONSTRAINT chk_demo_slot_time CHECK (ends_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE demo_bookings (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  slot_id     VARCHAR(36) NOT NULL,
  learner_id  VARCHAR(36) NOT NULL,
  status      VARCHAR(10) NOT NULL DEFAULT 'booked',
  booked_via  VARCHAR(8) NOT NULL DEFAULT 'public',
  note        VARCHAR(300) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- a learner holds one seat per slot while the booking is live
  live_key    VARCHAR(80) GENERATED ALWAYS AS (IF(status IN ('booked','attended'), CONCAT(slot_id, ':', learner_id), NULL)) STORED,
  UNIQUE KEY uq_demo_live (live_key),
  KEY idx_demo_booking_slot (slot_id, status),
  KEY idx_demo_booking_learner (learner_id, status),
  CONSTRAINT fk_demo_b_slot FOREIGN KEY (slot_id, org_id) REFERENCES demo_slots (id, org_id),
  CONSTRAINT fk_demo_b_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_demo_b_status CHECK (status IN ('booked','attended','no_show','cancelled')),
  CONSTRAINT chk_demo_b_via CHECK (booked_via IN ('public','staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- reminders can now be about an upcoming demo
ALTER TABLE reminder_rules DROP CONSTRAINT chk_rules_kind;
ALTER TABLE reminder_rules ADD CONSTRAINT chk_rules_kind CHECK (kind IN ('fee_due','fee_overdue','class_upcoming','absence','demo_upcoming'));

-- messages people send us on WhatsApp (STOP, YES, questions). Stored once per provider message id.
CREATE TABLE whatsapp_inbound (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NULL,
  phone       VARCHAR(20) NOT NULL,
  learner_id  VARCHAR(36) NULL,
  provider_message_id VARCHAR(120) NOT NULL,
  body        VARCHAR(1000) NULL,
  intent      VARCHAR(12) NOT NULL,
  outcome     VARCHAR(40) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_inbound_msg (provider_message_id, org_id, learner_id),
  KEY idx_inbound_org (org_id, received_at),
  KEY idx_inbound_phone (phone, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- pay rate per teacher; the rate in force at the end of a month is used for that month's estimate
CREATE TABLE teacher_rates (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  teacher_user_id VARCHAR(36) NOT NULL,
  rate_per_hour   DECIMAL(10,2) NOT NULL,
  effective_from  DATE NOT NULL,
  created_by      VARCHAR(36) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_teacher_rate (teacher_user_id, effective_from),
  KEY idx_teacher_rate_org (org_id),
  CONSTRAINT fk_rate_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_rate_user FOREIGN KEY (teacher_user_id) REFERENCES users(id),
  CONSTRAINT chk_rate_positive CHECK (rate_per_hour >= 0 AND rate_per_hour <= 100000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'payroll:read',   'View teacher workload and pay estimates'),
  (UUID(), 'payroll:manage', 'Set teacher pay rates');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin','accountant') AND p.code = 'payroll:read')
  OR (r.code IN ('super_admin','org_admin') AND p.code = 'payroll:manage');
