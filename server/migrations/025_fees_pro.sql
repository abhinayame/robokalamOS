-- Phase 21: discounts you can give and change later, payments you can correct or cancel (with a trail and a revised receipt),
-- receipt designs chosen per school, and course levels so a learner's years with the school read as one journey.

-- ---------------------------------------------------------------- discounts
-- the list price of each instalment, so a discount can be changed or removed later and the instalments always re-split from the same shares
ALTER TABLE fee_installments ADD COLUMN base_amount DECIMAL(12,2) NULL;
UPDATE fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id SET i.base_amount = IF(f.net_amount > 0, ROUND(i.amount * f.gross_amount / f.net_amount, 2), i.amount);
ALTER TABLE learner_fees
  ADD COLUMN discount_type   VARCHAR(7)  NULL,                    -- percent | amount: how the discount was entered
  ADD COLUMN discount_value  DECIMAL(12,2) NULL,                  -- 10 (percent) or 600 (rupees)
  ADD COLUMN discount_reason VARCHAR(200) NULL,
  ADD COLUMN level_label     VARCHAR(60) NULL,                    -- "Level 2", shown on the ledger and the receipt
  ADD CONSTRAINT chk_lf_discount_type CHECK (discount_type IS NULL OR discount_type IN ('percent','amount'));

CREATE TABLE fee_adjustments (
  id              BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id          VARCHAR(36) NOT NULL,
  learner_fee_id  VARCHAR(36) NOT NULL,
  learner_id      VARCHAR(36) NOT NULL,
  before_discount DECIMAL(12,2) NOT NULL,
  after_discount  DECIMAL(12,2) NOT NULL,
  before_net      DECIMAL(12,2) NOT NULL,
  after_net       DECIMAL(12,2) NOT NULL,
  discount_type   VARCHAR(7) NULL,
  discount_value  DECIMAL(12,2) NULL,
  reason          VARCHAR(200) NOT NULL,
  preset_id       VARCHAR(36) NULL,
  adjusted_by     VARCHAR(36) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_fee_adj_fee (learner_fee_id, created_at),
  KEY idx_fee_adj_org (org_id, created_at),
  CONSTRAINT fk_fee_adj_fee FOREIGN KEY (learner_fee_id, org_id) REFERENCES learner_fees (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- named discounts the accounts team picks from: "Sibling 10%", "Early bird", "Scholarship"
CREATE TABLE fee_discount_presets (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  name       VARCHAR(80) NOT NULL,
  kind       VARCHAR(7) NOT NULL,
  value      DECIMAL(12,2) NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_fee_preset_name (org_id, name),
  CONSTRAINT fk_fee_preset_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_fee_preset_kind CHECK (kind IN ('percent','amount')),
  CONSTRAINT chk_fee_preset_value CHECK (value > 0 AND (kind = 'amount' OR value <= 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- correcting payments
ALTER TABLE payments
  ADD COLUMN revision    INT NOT NULL DEFAULT 0,
  ADD COLUMN edited_at   DATETIME(3) NULL,
  ADD COLUMN voided_at   DATETIME(3) NULL,
  ADD COLUMN void_reason VARCHAR(200) NULL;
ALTER TABLE payments DROP CONSTRAINT chk_payments_status, ADD CONSTRAINT chk_payments_status CHECK (status IN ('captured','partially_refunded','refunded','voided'));

-- every change to a payment, with what it was before: nothing is silently overwritten
CREATE TABLE payment_revisions (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  payment_id  VARCHAR(36) NOT NULL,
  revision    INT NOT NULL,
  kind        VARCHAR(8) NOT NULL,                                 -- edit | void
  reason      VARCHAR(200) NOT NULL,
  before_json JSON NOT NULL,
  after_json  JSON NOT NULL,
  changed_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_pay_rev (payment_id, revision),
  CONSTRAINT fk_pay_rev_payment FOREIGN KEY (payment_id, org_id) REFERENCES payments (id, org_id),
  CONSTRAINT chk_pay_rev_kind CHECK (kind IN ('edit','void'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- receipt design and fee settings
ALTER TABLE organizations
  ADD COLUMN receipt_template       VARCHAR(10) NOT NULL DEFAULT 'classic',
  ADD COLUMN receipt_address        VARCHAR(300) NULL,
  ADD COLUMN receipt_tax_id         VARCHAR(40) NULL,              -- GSTIN or registration number, printed if set
  ADD COLUMN receipt_header         VARCHAR(160) NULL,             -- a line under the school name
  ADD COLUMN receipt_footer         VARCHAR(500) NULL,             -- terms, "fees are non-refundable"…
  ADD COLUMN receipt_signatory      VARCHAR(80) NULL,
  ADD COLUMN receipt_signatory_title VARCHAR(80) NULL,
  ADD COLUMN receipt_accent         VARCHAR(7) NULL,
  ADD COLUMN receipt_show_logo      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN discount_limit_percent TINYINT NULL,                  -- the most the accounts team may give without an owner (NULL = no limit)
  ADD CONSTRAINT chk_org_receipt_template CHECK (receipt_template IN ('classic','modern','slip')),
  ADD CONSTRAINT chk_org_receipt_accent CHECK (receipt_accent IS NULL OR receipt_accent REGEXP '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT chk_org_discount_limit CHECK (discount_limit_percent IS NULL OR discount_limit_percent BETWEEN 0 AND 100);

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'fee:discount',           'Give or change a discount on a learner''s fee'),
  (UUID(), 'fee:discount_unlimited', 'Give any discount, even above the limit set for the accounts team'),
  (UUID(), 'payment:edit',           'Correct the date, method, reference or amount of a recorded payment, or cancel it by mistake');
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin') AND p.code IN ('fee:discount','fee:discount_unlimited','payment:edit'))
  OR (r.code = 'accountant' AND p.code IN ('fee:discount','payment:edit'));

-- ---------------------------------------------------------------- levels
ALTER TABLE courses ADD COLUMN level_no SMALLINT NULL, ADD CONSTRAINT chk_courses_level CHECK (level_no IS NULL OR level_no BETWEEN 1 AND 50);
