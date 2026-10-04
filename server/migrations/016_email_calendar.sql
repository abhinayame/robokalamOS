-- Phase 13 (part 1): an e-mail channel (outbox + worker), self-service password reset, personal calendar feeds, and e-mail as a second
-- channel for automatic reminders.

CREATE TABLE email_outbox (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NULL,
  to_email      VARCHAR(200) NOT NULL,
  to_name       VARCHAR(160) NULL,
  subject       VARCHAR(300) NOT NULL,
  body_text     TEXT NOT NULL,
  body_html     MEDIUMTEXT NULL,
  category      VARCHAR(14) NOT NULL DEFAULT 'notification',   -- transactional (always sent) | notification (respects opt-outs)
  status        VARCHAR(10) NOT NULL DEFAULT 'pending',        -- pending | sending | sent | failed | skipped
  attempts      INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  claimed_at    DATETIME(3) NULL,
  claim_token   VARCHAR(36) NULL,
  sent_at       DATETIME(3) NULL,
  last_error    VARCHAR(500) NULL,
  learner_id    VARCHAR(36) NULL,
  dedupe_key    VARCHAR(190) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_email_dedupe (dedupe_key),
  KEY idx_email_queue (status, next_attempt_at),
  KEY idx_email_org (org_id, created_at),
  CONSTRAINT chk_email_status CHECK (status IN ('pending','sending','sent','failed','skipped')),
  CONSTRAINT chk_email_category CHECK (category IN ('transactional','notification'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE email_optouts (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NULL,
  email      VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_email_optout (org_id, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only the hash of a reset token is stored; a token works once and for 30 minutes.
CREATE TABLE password_resets (
  id           VARCHAR(36) NOT NULL PRIMARY KEY,
  user_id      VARCHAR(36) NOT NULL,
  token_hash   VARCHAR(64) NOT NULL,
  expires_at   DATETIME(3) NOT NULL,
  used_at      DATETIME(3) NULL,
  requested_ip VARCHAR(64) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_reset_token (token_hash),
  KEY idx_reset_user (user_id, created_at),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A personal calendar feed (subscribe from Google/Apple/Outlook). Only the hash is stored; the link is shown once.
CREATE TABLE calendar_tokens (
  id           VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id       VARCHAR(36) NOT NULL,
  user_id      VARCHAR(36) NOT NULL,
  token_hash   VARCHAR(64) NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  revoked_at   DATETIME(3) NULL,
  UNIQUE KEY uq_calendar_token (token_hash),
  KEY idx_calendar_user (user_id, revoked_at),
  CONSTRAINT fk_calendar_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reminders can go by e-mail instead of WhatsApp (subject and body use the same placeholders).
ALTER TABLE reminder_rules
  ADD COLUMN channel       VARCHAR(10) NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN email_subject VARCHAR(200) NULL,
  ADD COLUMN email_body    TEXT NULL,
  ADD CONSTRAINT chk_rules_channel CHECK (channel IN ('whatsapp','email'));
-- an e-mail rule needs no WhatsApp template
ALTER TABLE reminder_rules DROP FOREIGN KEY fk_rules_template;
ALTER TABLE reminder_rules MODIFY template_id VARCHAR(36) NULL;
ALTER TABLE reminder_rules ADD CONSTRAINT fk_rules_template FOREIGN KEY (template_id, org_id) REFERENCES whatsapp_templates (id, org_id);
