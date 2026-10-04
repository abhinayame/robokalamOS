-- Phase 10: automatic reminders (fee due, fee overdue, upcoming class, absence). A rule says WHEN and WHICH template; the scheduler turns what is
-- due into ordinary WhatsApp campaigns (kind = 'auto'), so delivery, retries, opt-outs and webhooks are exactly the same as for manual campaigns.

ALTER TABLE whatsapp_campaigns
  ADD COLUMN kind    VARCHAR(10) NOT NULL DEFAULT 'manual',
  ADD COLUMN rule_id VARCHAR(36) NULL,
  ADD CONSTRAINT chk_wac_kind CHECK (kind IN ('manual','auto'));

CREATE TABLE reminder_rules (
  id             VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id         VARCHAR(36) NOT NULL,
  name           VARCHAR(120) NOT NULL,
  kind           VARCHAR(20) NOT NULL,                 -- fee_due | fee_overdue | class_upcoming | absence
  template_id    VARCHAR(36) NOT NULL,
  audience       VARCHAR(10) NOT NULL DEFAULT 'parents',
  variables      JSON NOT NULL,                        -- one text per template parameter; may use the tokens of this kind
  offset_value   INT NOT NULL DEFAULT 1,               -- fee_due: days before due. fee_overdue: days after due. class_upcoming: hours before. absence: hours after the class
  repeat_days    INT NULL,                             -- fee_overdue only: repeat every N days
  max_sends      INT NOT NULL DEFAULT 1,               -- fee_overdue only: stop after this many reminders per installment
  send_from_hour TINYINT NOT NULL DEFAULT 9,           -- only send between these hours of the organization's day
  send_to_hour   TINYINT NOT NULL DEFAULT 20,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     VARCHAR(36) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_run_at    DATETIME(3) NULL,
  UNIQUE KEY uq_rules_name (org_id, name),
  UNIQUE KEY uq_rules_id_org (id, org_id),
  KEY idx_rules_enabled (enabled, org_id),
  CONSTRAINT fk_rules_template FOREIGN KEY (template_id, org_id) REFERENCES whatsapp_templates (id, org_id),
  CONSTRAINT chk_rules_kind CHECK (kind IN ('fee_due','fee_overdue','class_upcoming','absence')),
  CONSTRAINT chk_rules_audience CHECK (audience IN ('parents','learners')),
  CONSTRAINT chk_rules_offset CHECK (offset_value >= 0 AND offset_value <= 720),
  CONSTRAINT chk_rules_hours CHECK (send_from_hour BETWEEN 0 AND 23 AND send_to_hour BETWEEN 1 AND 24 AND send_from_hour < send_to_hour),
  CONSTRAINT chk_rules_repeat CHECK (max_sends BETWEEN 1 AND 12 AND (repeat_days IS NULL OR repeat_days BETWEEN 1 AND 90))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per thing a rule has dealt with. The unique key is what makes "never send the same reminder twice" true even with two servers.
CREATE TABLE reminder_log (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  rule_id     VARCHAR(36) NOT NULL,
  dedupe_key  VARCHAR(190) NOT NULL,
  learner_id  VARCHAR(36) NOT NULL,
  campaign_id VARCHAR(36) NULL,
  outcome     VARCHAR(10) NOT NULL DEFAULT 'queued',   -- queued | skipped
  reason      VARCHAR(120) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_reminder_once (rule_id, dedupe_key),
  KEY idx_reminder_org (org_id, created_at),
  KEY idx_reminder_learner (learner_id, created_at),
  CONSTRAINT fk_reminder_rule FOREIGN KEY (rule_id, org_id) REFERENCES reminder_rules (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chk_reminder_outcome CHECK (outcome IN ('queued','skipped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
