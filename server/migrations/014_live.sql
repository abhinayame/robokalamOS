-- Phase 11: live classes. A class session can get a Zoom meeting created from the schedule; Zoom's webhooks tell us who joined and for how long,
-- and attendance is marked from that (never over a mark a teacher made by hand). Recordings arrive as links.

ALTER TABLE class_sessions
  ADD COLUMN zoom_meeting_id          VARCHAR(30) NULL,
  ADD COLUMN live_started_at          DATETIME(3) NULL,
  ADD COLUMN live_ended_at            DATETIME(3) NULL,
  ADD COLUMN attendance_finalized_at  DATETIME(3) NULL,
  ADD UNIQUE KEY uq_sessions_zoom (zoom_meeting_id);

-- Who marked the row: the teacher ('manual', always wins) or the Zoom join log ('auto').
ALTER TABLE attendance
  ADD COLUMN source         VARCHAR(10) NOT NULL DEFAULT 'manual',
  ADD COLUMN joined_minutes INT NULL,
  ADD CONSTRAINT chk_att_source CHECK (source IN ('manual','auto'));

-- One row per time somebody joined (a learner who rejoins has several).
CREATE TABLE live_participants (
  id                  BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id              VARCHAR(36) NOT NULL,
  session_id          VARCHAR(36) NOT NULL,
  zoom_participant_id VARCHAR(100) NOT NULL,
  name                VARCHAR(200) NOT NULL,
  email               VARCHAR(200) NULL,
  joined_at           DATETIME(3) NOT NULL,
  left_at             DATETIME(3) NULL,
  learner_id          VARCHAR(36) NULL,
  match_method        VARCHAR(10) NULL,                 -- email | name | alias | manual
  event_key           VARCHAR(190) NOT NULL,
  UNIQUE KEY uq_live_join (event_key),
  KEY idx_live_session (session_id, learner_id),
  KEY idx_live_open (session_id, zoom_participant_id, left_at),
  CONSTRAINT fk_live_session FOREIGN KEY (session_id, org_id) REFERENCES class_sessions (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chk_live_match CHECK (match_method IS NULL OR match_method IN ('email','name','alias','manual'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "Zoom name -> learner" a teacher confirmed once; used automatically in later classes.
CREATE TABLE live_aliases (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  alias       VARCHAR(200) NOT NULL,                    -- normalised display name
  learner_id  VARCHAR(36) NOT NULL,
  created_by  VARCHAR(36) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_alias (org_id, alias),
  CONSTRAINT fk_alias_learner FOREIGN KEY (learner_id, org_id) REFERENCES learners (id, org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE class_recordings (
  id          VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id      VARCHAR(36) NOT NULL,
  session_id  VARCHAR(36) NOT NULL,
  provider    VARCHAR(10) NOT NULL DEFAULT 'zoom',
  share_url   VARCHAR(1000) NOT NULL,
  passcode    VARCHAR(100) NULL,
  duration_min INT NULL,
  size_mb     DECIMAL(10,1) NULL,
  recorded_at DATETIME(3) NULL,
  event_key   VARCHAR(190) NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_recording_event (event_key),
  KEY idx_recordings_session (session_id),
  CONSTRAINT fk_recording_session FOREIGN KEY (session_id, org_id) REFERENCES class_sessions (id, org_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
