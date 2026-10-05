-- Phase 13 (part 2): certificates. A design says what the certificate says; issuing it to a learner freezes the wording and gives it a public
-- verification code, so a printed certificate can be checked by anyone.

CREATE TABLE certificate_designs (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  name            VARCHAR(120) NOT NULL,
  title_text      VARCHAR(120) NOT NULL DEFAULT 'Certificate of Completion',
  body_text       VARCHAR(600) NOT NULL DEFAULT 'has successfully completed {course_name} ({batch_name}) on {date}.',
  signatory_name  VARCHAR(120) NULL,
  signatory_title VARCHAR(120) NULL,
  show_logo       BOOLEAN NOT NULL DEFAULT TRUE,
  status          VARCHAR(10) NOT NULL DEFAULT 'active',
  created_by      VARCHAR(36) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_cert_design_name (org_id, name),
  UNIQUE KEY uq_cert_design_id_org (id, org_id),
  CONSTRAINT fk_cert_design_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_cert_design_status CHECK (status IN ('active','archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE certificates (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  learner_id      VARCHAR(36) NOT NULL,
  batch_id        VARCHAR(36) NULL,
  design_id       VARCHAR(36) NOT NULL,
  code            VARCHAR(20) NOT NULL,                 -- public verification code, e.g. RKC-7K3P-9QXM
  title           VARCHAR(120) NOT NULL,                -- wording frozen at issue time
  recipient_name  VARCHAR(160) NOT NULL,
  body            VARCHAR(800) NOT NULL,
  course_name     VARCHAR(160) NULL,
  batch_name      VARCHAR(160) NULL,
  signatory_name  VARCHAR(120) NULL,
  signatory_title VARCHAR(120) NULL,
  issued_on       DATE NOT NULL,
  issued_by       VARCHAR(36) NULL,
  revoked_at      DATETIME(3) NULL,
  revoked_by      VARCHAR(36) NULL,
  revoke_reason   VARCHAR(200) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- one live certificate per learner per design per batch: issuing twice is a no-op
  active_key      VARCHAR(120) GENERATED ALWAYS AS (IF(revoked_at IS NULL, CONCAT(learner_id, ':', design_id, ':', IFNULL(batch_id, '-')), NULL)) STORED,
  UNIQUE KEY uq_cert_code (code),
  UNIQUE KEY uq_cert_active (active_key),
  UNIQUE KEY uq_cert_id_org (id, org_id),
  KEY idx_cert_learner (learner_id, created_at),
  KEY idx_cert_org (org_id, created_at),
  CONSTRAINT fk_cert_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_cert_design FOREIGN KEY (design_id, org_id) REFERENCES certificate_designs (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'cert:read',   'View issued certificates'),
  (UUID(), 'cert:manage', 'Design certificates, issue them to learners and revoke them');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin') AND p.code IN ('cert:read','cert:manage'))
  OR (r.code IN ('teacher','counsellor') AND p.code = 'cert:read');
