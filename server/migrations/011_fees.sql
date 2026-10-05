-- Phase 10: fees and payments.
-- Money is DECIMAL(12,2) rupees. A fee plan is a template; assigning it to a learner creates a learner_fee with dated installments.
-- Payments are allocated to installments (payment_allocations) so partial payments, refunds and reports always add up.

CREATE TABLE fee_plans (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  description   VARCHAR(500) NULL,
  total_amount  DECIMAL(12,2) NOT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'active',
  created_by    VARCHAR(36) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_fee_plans_name (org_id, name),
  UNIQUE KEY uq_fee_plans_id_org (id, org_id),
  CONSTRAINT fk_fee_plans_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_fee_plans_status CHECK (status IN ('active','archived')),
  CONSTRAINT chk_fee_plans_total CHECK (total_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The schedule: each item is due `due_days` days after the fee's start date.
CREATE TABLE fee_plan_items (
  id        VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id    VARCHAR(36) NOT NULL,
  plan_id   VARCHAR(36) NOT NULL,
  label     VARCHAR(120) NOT NULL,
  amount    DECIMAL(12,2) NOT NULL,
  due_days  INT NOT NULL DEFAULT 0,
  position  INT NOT NULL DEFAULT 0,
  KEY idx_fee_items_plan (plan_id, position),
  CONSTRAINT fk_fee_items_plan FOREIGN KEY (plan_id, org_id) REFERENCES fee_plans (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chk_fee_items_amount CHECK (amount > 0),
  CONSTRAINT chk_fee_items_days CHECK (due_days >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What one learner owes. ONE active fee per learner per plan per batch (generated key), so assigning twice is a no-op.
CREATE TABLE learner_fees (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  learner_id      VARCHAR(36) NOT NULL,
  batch_id        VARCHAR(36) NULL,
  plan_id         VARCHAR(36) NULL,
  title           VARCHAR(160) NOT NULL,
  gross_amount    DECIMAL(12,2) NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_amount      DECIMAL(12,2) NOT NULL,
  start_date      DATE NOT NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'active',
  note            VARCHAR(300) NULL,
  created_by      VARCHAR(36) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  cancelled_at    DATETIME(3) NULL,
  cancel_reason   VARCHAR(200) NULL,
  active_key      VARCHAR(120) GENERATED ALWAYS AS (IF(status = 'active' AND plan_id IS NOT NULL, CONCAT(learner_id, ':', plan_id, ':', IFNULL(batch_id, '-')), NULL)) STORED,
  UNIQUE KEY uq_learner_fee_active (active_key),
  UNIQUE KEY uq_learner_fees_id_org (id, org_id),
  KEY idx_lf_learner (learner_id, status),
  KEY idx_lf_org (org_id, status),
  CONSTRAINT fk_lf_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT fk_lf_batch FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id),
  CONSTRAINT fk_lf_plan FOREIGN KEY (plan_id, org_id) REFERENCES fee_plans (id, org_id),
  CONSTRAINT chk_lf_status CHECK (status IN ('active','cancelled')),
  CONSTRAINT chk_lf_amounts CHECK (gross_amount > 0 AND discount_amount >= 0 AND net_amount >= 0 AND discount_amount <= gross_amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fee_installments (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id         VARCHAR(36) NOT NULL,
  learner_fee_id VARCHAR(36) NOT NULL,
  learner_id     VARCHAR(36) NOT NULL,
  label          VARCHAR(120) NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  paid_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
  due_date       DATE NOT NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'pending',     -- pending | partial | paid | cancelled
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_installments_id_org (id, org_id),
  KEY idx_inst_due (org_id, status, due_date),
  KEY idx_inst_learner (learner_id, status, due_date),
  KEY idx_inst_fee (learner_fee_id),
  CONSTRAINT fk_inst_fee FOREIGN KEY (learner_fee_id, org_id) REFERENCES learner_fees (id, org_id),
  CONSTRAINT fk_inst_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_inst_status CHECK (status IN ('pending','partial','paid','cancelled')),
  CONSTRAINT chk_inst_amounts CHECK (amount > 0 AND paid_amount >= 0 AND paid_amount <= amount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_links (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id           VARCHAR(36) NOT NULL,
  learner_id       VARCHAR(36) NOT NULL,
  amount           DECIMAL(12,2) NOT NULL,
  installment_ids  JSON NOT NULL,
  provider         VARCHAR(20) NOT NULL DEFAULT 'razorpay',
  provider_link_id VARCHAR(80) NOT NULL,
  short_url        VARCHAR(300) NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'created',   -- created | paid | expired | cancelled
  expires_at       DATETIME(3) NOT NULL,
  created_by       VARCHAR(36) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at          DATETIME(3) NULL,
  UNIQUE KEY uq_pl_provider (provider, provider_link_id),
  UNIQUE KEY uq_pl_id_org (id, org_id),
  KEY idx_pl_learner (learner_id, status),
  CONSTRAINT fk_pl_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_pl_status CHECK (status IN ('created','paid','expired','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payments (
  id                  VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id              VARCHAR(36) NOT NULL,
  learner_id          VARCHAR(36) NOT NULL,
  amount              DECIMAL(12,2) NOT NULL,
  unallocated_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,       -- paid online after the dues were cleared another way: kept as credit
  method              VARCHAR(16) NOT NULL,
  provider            VARCHAR(10) NOT NULL DEFAULT 'manual',  -- manual | razorpay
  provider_payment_id VARCHAR(80) NULL,
  payment_link_id     VARCHAR(36) NULL,
  receipt_no          VARCHAR(40) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'captured',  -- captured | partially_refunded | refunded
  refunded_amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid_at             DATETIME(3) NOT NULL,
  reference           VARCHAR(100) NULL,
  note                VARCHAR(300) NULL,
  recorded_by         VARCHAR(36) NULL,
  request_id          VARCHAR(36) NULL,                       -- client-supplied: double clicks and retries cannot double-record
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_payments_receipt (org_id, receipt_no),
  UNIQUE KEY uq_payments_provider (provider, provider_payment_id),
  UNIQUE KEY uq_payments_request (org_id, request_id),
  UNIQUE KEY uq_payments_id_org (id, org_id),
  KEY idx_payments_learner (learner_id, paid_at),
  KEY idx_payments_org_paid (org_id, paid_at),
  CONSTRAINT fk_payments_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_payments_method CHECK (method IN ('cash','upi','card','bank_transfer','cheque','online','other')),
  CONSTRAINT chk_payments_status CHECK (status IN ('captured','partially_refunded','refunded')),
  CONSTRAINT chk_payments_amount CHECK (amount > 0 AND refunded_amount >= 0 AND refunded_amount <= amount AND unallocated_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_allocations (
  id             BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id         VARCHAR(36) NOT NULL,
  payment_id     VARCHAR(36) NOT NULL,
  installment_id VARCHAR(36) NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  UNIQUE KEY uq_alloc (payment_id, installment_id),
  KEY idx_alloc_installment (installment_id),
  CONSTRAINT fk_alloc_payment FOREIGN KEY (payment_id, org_id) REFERENCES payments (id, org_id),
  CONSTRAINT fk_alloc_installment FOREIGN KEY (installment_id, org_id) REFERENCES fee_installments (id, org_id),
  CONSTRAINT chk_alloc_amount CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fee_refunds (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  payment_id  VARCHAR(36) NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  reason      VARCHAR(200) NOT NULL,
  refunded_by VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_refunds_payment (payment_id),
  CONSTRAINT fk_refunds_payment FOREIGN KEY (payment_id, org_id) REFERENCES payments (id, org_id),
  CONSTRAINT chk_refund_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'fee:read',        'View fee plans, dues, payments and receipts'),
  (UUID(), 'fee:manage',      'Create fee plans, assign fees, adjust or cancel fees'),
  (UUID(), 'payment:record',  'Record payments and create online payment links'),
  (UUID(), 'payment:refund',  'Refund recorded payments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','accountant') AND p.code IN ('fee:read','fee:manage','payment:record','payment:refund'))
  OR (r.code = 'branch_admin' AND p.code IN ('fee:read','payment:record'));
