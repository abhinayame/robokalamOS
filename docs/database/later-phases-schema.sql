-- ============================================================================
-- Robokalam Learner OS — COMPLETE SCHEMA, PHASES 2–9 (design reference)
--
-- Phase 1 tables live in server/migrations/001_foundation.sql and are IMPLEMENTED.
-- Everything below is the agreed target design for later phases. Each phase ships its
-- own numbered migration containing ONLY its tables; this file is validated in CI by
-- applying it on top of 001 (see docs/ARCHITECTURE.md §3). Conventions are identical:
--   * org_id on every business table; composite FKs (id, org_id) keep tenants apart
--   * learner activity is attached to learners(id) — NEVER copied per batch
--   * money is stored in paise (bigint); timestamps are timestamptz
-- ============================================================================

-- ------------------------------ PHASE 2: CLASSROOM -------------------------
CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  course_id uuid NOT NULL, name text NOT NULL, position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, org_id), FOREIGN KEY (course_id, org_id) REFERENCES courses (id, org_id)
);

CREATE TABLE topics (                                   -- classwork sections inside a batch
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL, subject_id uuid, title text NOT NULL, position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE INDEX idx_topics_batch ON topics (batch_id, position);

CREATE TABLE classroom_posts (                          -- STREAM
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL, author_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('announcement','assignment','material','video','link','poll','quiz')),
  title text, body text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  comments_enabled boolean NOT NULL DEFAULT true, pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE INDEX idx_posts_batch_time ON classroom_posts (batch_id, created_at DESC);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  post_id uuid NOT NULL, parent_comment_id uuid REFERENCES comments(id), author_user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  FOREIGN KEY (post_id, org_id) REFERENCES classroom_posts (id, org_id)
);
CREATE INDEX idx_comments_post ON comments (post_id, created_at);

CREATE TABLE materials (                                -- files and links; storage_key is never exposed, access via signed URL
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid, course_id uuid, topic_id uuid, title text NOT NULL, description text,
  kind text NOT NULL CHECK (kind IN ('pdf','ppt','doc','image','video','link')),
  storage_key text, external_url text, mime_type text, size_bytes bigint, uploaded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id), FOREIGN KEY (course_id, org_id) REFERENCES courses (id, org_id),
  FOREIGN KEY (topic_id, org_id) REFERENCES topics (id, org_id)
);

CREATE TABLE videos (                                   -- provider-agnostic: youtube | vimeo | storage | private
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  material_id uuid NOT NULL, provider text NOT NULL, provider_ref text NOT NULL, duration_seconds int,
  UNIQUE (id, org_id), FOREIGN KEY (material_id, org_id) REFERENCES materials (id, org_id)
);
CREATE TABLE video_progress (
  video_id uuid NOT NULL REFERENCES videos(id), learner_id uuid NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id),
  seconds_watched int NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, learner_id), FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL, topic_id uuid, post_id uuid, title text NOT NULL, description text, instructions text,
  due_at timestamptz, max_marks numeric(8,2) NOT NULL DEFAULT 100 CHECK (max_marks > 0), allow_resubmit boolean NOT NULL DEFAULT false,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb, created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE INDEX idx_assignments_batch_due ON assignments (batch_id, due_at);

CREATE TABLE submissions (                              -- one row per (assignment, learner)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  assignment_id uuid NOT NULL, learner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','draft','submitted','late','evaluated','returned')),
  body text, attachments jsonb NOT NULL DEFAULT '[]'::jsonb, submitted_at timestamptz, version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, learner_id), UNIQUE (id, org_id),
  FOREIGN KEY (assignment_id, org_id) REFERENCES assignments (id, org_id), FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_submissions_learner ON submissions (learner_id, status);

-- ------------------------------ PHASE 3: ASSESSMENT ------------------------
CREATE TABLE quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL, title text NOT NULL, instructions text, time_limit_minutes int, max_attempts int NOT NULL DEFAULT 1,
  opens_at timestamptz, closes_at timestamptz, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  quiz_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN ('single','multiple','short','long')), prompt text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb, answer_key jsonb, marks numeric(6,2) NOT NULL DEFAULT 1, position int NOT NULL DEFAULT 0,
  FOREIGN KEY (quiz_id, org_id) REFERENCES quizzes (id, org_id)
);
CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  quiz_id uuid NOT NULL, learner_id uuid NOT NULL, answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz, score numeric(8,2),
  FOREIGN KEY (quiz_id, org_id) REFERENCES quizzes (id, org_id), FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);

-- Every graded item (assignment, quiz, project, manual activity) is a SCORE for a learner in a batch.
CREATE TABLE scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  learner_id uuid NOT NULL, batch_id uuid NOT NULL, teacher_user_id uuid NOT NULL REFERENCES users(id),
  source_type text NOT NULL CHECK (source_type IN ('assignment','quiz','project','activity')), source_id uuid,
  activity_name text NOT NULL, category text, score numeric(8,2) NOT NULL CHECK (score >= 0),
  max_score numeric(8,2) NOT NULL CHECK (max_score > 0), feedback text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE INDEX idx_scores_learner ON scores (learner_id, created_at DESC);
CREATE INDEX idx_scores_batch ON scores (batch_id, source_type);
CREATE UNIQUE INDEX uq_scores_source ON scores (learner_id, batch_id, source_type, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE score_history (                            -- append-only audit of every change
  id bigserial PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), score_id uuid NOT NULL REFERENCES scores(id),
  changed_by uuid NOT NULL REFERENCES users(id), action text NOT NULL CHECK (action IN ('created','updated','deleted')),
  previous_score numeric(8,2), new_score numeric(8,2), previous_max numeric(8,2), new_max numeric(8,2), previous_feedback text, new_feedback text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_score_history_score ON score_history (score_id, changed_at);

-- ------------------------------ PHASE 4: GAMIFICATION ----------------------
CREATE TABLE levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  level_no int NOT NULL, name text NOT NULL, min_xp int NOT NULL CHECK (min_xp >= 0), UNIQUE (org_id, level_no), UNIQUE (org_id, min_xp)
);
CREATE TABLE badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL, description text, icon text, category text, xp_reward int NOT NULL DEFAULT 0, criteria text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, name), UNIQUE (id, org_id)
);
CREATE TABLE learner_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  learner_id uuid NOT NULL, badge_id uuid NOT NULL, batch_id uuid, awarded_by uuid NOT NULL REFERENCES users(id), reason text,
  awarded_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id), FOREIGN KEY (badge_id, org_id) REFERENCES badges (id, org_id)
);
CREATE UNIQUE INDEX uq_learner_badge_once ON learner_badges (learner_id, badge_id, COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE revoked_at IS NULL;

-- XP is a LEDGER. Balance = SUM(points). learners.xp_cached (added in that migration) is a trigger-maintained cache.
CREATE TABLE xp_transactions (
  id bigserial PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), learner_id uuid NOT NULL, batch_id uuid,
  points int NOT NULL CHECK (points <> 0), reason text NOT NULL, source_type text, source_id text,
  created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_xp_learner ON xp_transactions (learner_id, created_at DESC);
CREATE INDEX idx_xp_batch ON xp_transactions (batch_id, created_at);

-- ------------------------------ PHASE 5: ATTENDANCE & PARENT ---------------
CREATE TABLE class_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL, title text, starts_at timestamptz NOT NULL, ends_at timestamptz,
  meeting_provider text CHECK (meeting_provider IN ('google_meet','zoom','webrtc','other')), meeting_url text,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','started','completed','cancelled')),
  created_by uuid REFERENCES users(id), UNIQUE (id, org_id), FOREIGN KEY (batch_id, org_id) REFERENCES batches (id, org_id)
);
CREATE INDEX idx_sessions_batch_time ON class_sessions (batch_id, starts_at);

CREATE TABLE attendance (                               -- always tied to a class session of ONE batch
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
  session_id uuid NOT NULL, batch_id uuid NOT NULL, learner_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','late','excused')), marked_by uuid NOT NULL REFERENCES users(id),
  marked_at timestamptz NOT NULL DEFAULT now(), note text,
  UNIQUE (session_id, learner_id),
  FOREIGN KEY (session_id, org_id) REFERENCES class_sessions (id, org_id), FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_attendance_learner ON attendance (learner_id, batch_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL, title text NOT NULL, body text, link text, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications (user_id, read_at, created_at DESC);

-- ------------------------------ PHASE 6: CRM -------------------------------
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, color text,
  UNIQUE (org_id, name), UNIQUE (id, org_id)
);
CREATE TABLE learner_tags (
  learner_id uuid NOT NULL, tag_id uuid NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id), added_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (learner_id, tag_id),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id), FOREIGN KEY (tag_id, org_id) REFERENCES tags (id, org_id)
);
CREATE INDEX idx_learner_tags_tag ON learner_tags (tag_id);

CREATE TABLE crm_leads (                                -- ONE CRM record per learner
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), learner_id uuid NOT NULL,
  lead_source text, lead_status text NOT NULL DEFAULT 'new' CHECK (lead_status IN ('new','contacted','interested','demo_scheduled','demo_attended','follow_up','converted','not_interested','lost')),
  interested_program_id uuid, interested_course_id uuid, interested_batch_id uuid, counsellor_user_id uuid REFERENCES users(id),
  temperature text CHECK (temperature IN ('cold','warm','hot')), next_follow_up_at timestamptz, notes text, converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (learner_id), UNIQUE (id, org_id), FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_leads_status ON crm_leads (org_id, lead_status);
CREATE INDEX idx_leads_counsellor ON crm_leads (counsellor_user_id, next_follow_up_at);

CREATE TABLE crm_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), learner_id uuid NOT NULL,
  lead_id uuid, type text NOT NULL, description text, staff_user_id uuid REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT now(), next_follow_up_at timestamptz,
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_crm_activities_learner ON crm_activities (learner_id, occurred_at DESC);
CREATE TABLE follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), learner_id uuid NOT NULL,
  assigned_to uuid NOT NULL REFERENCES users(id), due_at timestamptz NOT NULL, note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')), completed_at timestamptz,
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_follow_ups_due ON follow_ups (assigned_to, status, due_at);

-- ------------------------------ PHASE 7: COMMUNICATION ---------------------
CREATE TABLE whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, aisensy_campaign_name text NOT NULL,
  use_case text NOT NULL, body_preview text, variable_names text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'active',
  UNIQUE (org_id, name), UNIQUE (id, org_id)
);
CREATE TABLE whatsapp_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, template_id uuid NOT NULL,
  selector jsonb NOT NULL,                              -- the selection that produced the audience (kept for audit)
  variables jsonb NOT NULL DEFAULT '{}'::jsonb, scheduled_at timestamptz, created_by uuid NOT NULL REFERENCES users(id),
  confirmed_at timestamptz, confirmed_by uuid REFERENCES users(id),     -- NULL → can never be sent
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','processing','completed','partially_failed','failed','cancelled')),
  total_recipients int NOT NULL DEFAULT 0, batch_memberships int NOT NULL DEFAULT 0, duplicates_removed int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (template_id, org_id) REFERENCES whatsapp_templates (id, org_id)
);
CREATE INDEX idx_campaigns_status ON whatsapp_campaigns (org_id, status, scheduled_at);

-- SNAPSHOT of recipients at confirmation time: one row per UNIQUE learner (UNIQUE guards against duplicates).
CREATE TABLE whatsapp_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), campaign_id uuid NOT NULL, learner_id uuid NOT NULL,
  parent_id uuid, phone text NOT NULL, variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','delivered','read','failed','cancelled','skipped')),
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_error text,
  UNIQUE (campaign_id, learner_id), UNIQUE (campaign_id, phone),
  FOREIGN KEY (campaign_id, org_id) REFERENCES whatsapp_campaigns (id, org_id), FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE INDEX idx_wa_recipients_queue ON whatsapp_recipients (status, next_attempt_at) WHERE status IN ('pending','queued');

CREATE TABLE whatsapp_messages (                        -- one row per provider call / webhook state
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), recipient_id uuid REFERENCES whatsapp_recipients(id),
  campaign_id uuid, provider_message_id text, direction text NOT NULL DEFAULT 'outbound', status text NOT NULL, error_code text, error_message text,
  payload jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wa_messages_provider ON whatsapp_messages (provider_message_id);
CREATE TABLE webhook_events (                           -- raw inbound webhooks, idempotency by provider event id
  id bigserial PRIMARY KEY, provider text NOT NULL, event_id text, payload jsonb NOT NULL, processed_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ------------------------------ PHASE 6/9: FINANCE -------------------------
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), learner_id uuid NOT NULL, batch_id uuid,
  invoice_no text NOT NULL, amount_paise bigint NOT NULL CHECK (amount_paise >= 0), due_on date,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partially_paid','paid','overdue','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, invoice_no), UNIQUE (id, org_id),
  FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), invoice_id uuid NOT NULL, amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  method text NOT NULL, reference text, paid_at timestamptz NOT NULL DEFAULT now(), recorded_by uuid REFERENCES users(id),
  FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
);
CREATE INDEX idx_payments_invoice ON payments (invoice_id);
