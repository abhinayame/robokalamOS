-- Phase 7: Communication. WhatsApp (AiSensy) templates and campaigns with a de-duplicated recipient SNAPSHOT,
-- a message log, delivery webhooks, opt-outs, and in-app announcements.

CREATE TABLE whatsapp_templates (
  id                    VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id                VARCHAR(36) NOT NULL,
  name                  VARCHAR(120) NOT NULL,
  aisensy_campaign_name VARCHAR(160) NOT NULL,        -- the API campaign created in the AiSensy dashboard
  use_case              VARCHAR(40) NOT NULL,
  body_preview          TEXT NULL,                    -- what the approved template says, with {{1}} {{2}} placeholders
  variable_names        JSON NULL,                    -- ["Learner name","Date"]: position = AiSensy template parameter
  status                VARCHAR(10) NOT NULL DEFAULT 'active',
  created_by            VARCHAR(36) NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wat_name (org_id, name),
  UNIQUE KEY uq_wat_id_org (id, org_id),
  CONSTRAINT fk_wat_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT chk_wat_status CHECK (status IN ('active','inactive'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE whatsapp_campaigns (
  id                 VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id             VARCHAR(36) NOT NULL,
  name               VARCHAR(160) NOT NULL,
  template_id        VARCHAR(36) NOT NULL,
  audience           VARCHAR(10) NOT NULL DEFAULT 'parents',   -- parents | learners
  selector           JSON NOT NULL,                            -- the batch selection engine input, exactly as chosen
  variables          JSON NULL,                                -- one text per template parameter; may use {learner_name} etc.
  scheduled_at       DATETIME(3) NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'draft',
  created_by         VARCHAR(36) NOT NULL,
  confirmed_at       DATETIME(3) NULL,
  confirmed_by       VARCHAR(36) NULL,
  started_at         DATETIME(3) NULL,
  finished_at        DATETIME(3) NULL,
  cancelled_at       DATETIME(3) NULL,
  cancelled_by       VARCHAR(36) NULL,
  -- the numbers the sender confirmed (frozen at confirmation)
  selected_batches   INT NOT NULL DEFAULT 0,
  batch_memberships  INT NOT NULL DEFAULT 0,
  unique_learners    INT NOT NULL DEFAULT 0,
  duplicates_removed INT NOT NULL DEFAULT 0,
  total_recipients   INT NOT NULL DEFAULT 0,
  skipped            INT NOT NULL DEFAULT 0,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wac_id_org (id, org_id),
  KEY idx_campaigns_status (status, scheduled_at),
  KEY idx_campaigns_org (org_id, created_at),
  CONSTRAINT fk_wac_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_wac_template FOREIGN KEY (template_id, org_id) REFERENCES whatsapp_templates (id, org_id),
  CONSTRAINT fk_wac_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_wac_status CHECK (status IN ('draft','scheduled','processing','completed','partially_failed','failed','cancelled')),
  CONSTRAINT chk_wac_audience CHECK (audience IN ('parents','learners'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Snapshot taken at confirmation: ONE row per unique learner AND per unique phone
-- (siblings who share a parent's number get a single message).
CREATE TABLE whatsapp_recipients (
  id                  VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id              VARCHAR(36) NOT NULL,
  campaign_id         VARCHAR(36) NOT NULL,
  learner_id          VARCHAR(36) NOT NULL,
  parent_id           VARCHAR(36) NULL,
  phone               VARCHAR(20) NOT NULL,
  params              JSON NULL,                       -- the rendered template parameters for this person
  status              VARCHAR(10) NOT NULL DEFAULT 'pending',
  attempts            INT NOT NULL DEFAULT 0,
  next_attempt_at     DATETIME(3) NULL,
  claimed_at          DATETIME(3) NULL,
  claim_token         VARCHAR(36) NULL,                -- which worker run owns this row (safe with several instances)
  provider_message_id VARCHAR(120) NULL,
  last_error          VARCHAR(500) NULL,
  sent_at             DATETIME(3) NULL,
  delivered_at        DATETIME(3) NULL,
  read_at             DATETIME(3) NULL,
  UNIQUE KEY uq_war_learner (campaign_id, learner_id),
  UNIQUE KEY uq_war_phone (campaign_id, phone),
  KEY idx_war_queue (status, next_attempt_at),
  KEY idx_war_campaign (campaign_id, status),
  KEY idx_war_provider (provider_message_id),
  UNIQUE KEY uq_war_id_org (id, org_id),
  CONSTRAINT fk_war_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_war_campaign FOREIGN KEY (campaign_id, org_id) REFERENCES whatsapp_campaigns (id, org_id),
  CONSTRAINT fk_war_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id),
  CONSTRAINT chk_war_status CHECK (status IN ('pending','queued','sent','delivered','read','failed','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every attempt and every provider event, newest last. Nothing here is ever updated.
CREATE TABLE whatsapp_messages (
  id                  BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id              VARCHAR(36) NOT NULL,
  campaign_id         VARCHAR(36) NULL,
  recipient_id        VARCHAR(36) NULL,
  learner_id          VARCHAR(36) NULL,
  phone               VARCHAR(20) NULL,
  provider_message_id VARCHAR(120) NULL,
  event               VARCHAR(20) NOT NULL,            -- attempt | sent | delivered | read | failed | webhook
  status              VARCHAR(20) NOT NULL,
  error_code          VARCHAR(40) NULL,
  error_message       VARCHAR(500) NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_wam_recipient (recipient_id, id),
  KEY idx_wam_campaign (campaign_id, id),
  KEY idx_wam_learner (learner_id, id),
  KEY idx_wam_provider (provider_message_id),
  CONSTRAINT fk_wam_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE whatsapp_optouts (
  id         VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id     VARCHAR(36) NOT NULL,
  phone      VARCHAR(20) NOT NULL,
  reason     VARCHAR(200) NULL,
  created_by VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_optout (org_id, phone),
  CONSTRAINT fk_wao_org FOREIGN KEY (org_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE webhook_events (
  id           BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider     VARCHAR(30) NOT NULL,
  event_key    VARCHAR(190) NOT NULL,                  -- provider event id, or a hash of the body: replays are ignored
  payload      JSON NOT NULL,
  provider_message_id VARCHAR(120) NULL,
  delivery_status     VARCHAR(20) NULL,
  error_message       VARCHAR(500) NULL,
  outcome      VARCHAR(30) NULL,                       -- applied | ignored | unmatched | invalid
  received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_webhook_event (provider, event_key),
  KEY idx_webhook_pending (provider, outcome, provider_message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE announcements (
  id                 VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id             VARCHAR(36) NOT NULL,
  title              VARCHAR(200) NOT NULL,
  body               TEXT NOT NULL,
  selector           JSON NOT NULL,
  post_to_stream     BOOLEAN NOT NULL DEFAULT FALSE,
  unique_learners    INT NOT NULL DEFAULT 0,
  notified_users     INT NOT NULL DEFAULT 0,
  streams_posted     INT NOT NULL DEFAULT 0,
  created_by         VARCHAR(36) NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_announcements_org (org_id, created_at),
  CONSTRAINT fk_ann_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_ann_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'comms:read',     'View WhatsApp templates, campaigns and message logs'),
  (UUID(), 'comms:campaign', 'Create, confirm and cancel WhatsApp campaigns'),
  (UUID(), 'comms:manage',   'Manage WhatsApp templates and opt-outs'),
  (UUID(), 'comms:announce', 'Send in-app announcements to learners and parents in your scope');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON
     (r.code IN ('super_admin','org_admin','branch_admin','counsellor') AND p.code IN ('comms:read','comms:campaign'))
  OR (r.code IN ('super_admin','org_admin') AND p.code = 'comms:manage')
  OR (r.code IN ('super_admin','org_admin','branch_admin','teacher','counsellor') AND p.code = 'comms:announce');
