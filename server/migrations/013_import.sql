-- Phase 10: CSV import of learners (with parents and batch memberships).
-- A job is first PREVIEWED (every row checked, nothing written) and only then CONFIRMED; rows are processed one transaction each,
-- so one bad row never blocks the rest, and a restart simply resumes whatever is still waiting.

CREATE TABLE import_jobs (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  org_id        VARCHAR(36) NOT NULL,
  kind          VARCHAR(20) NOT NULL DEFAULT 'learners',
  status        VARCHAR(12) NOT NULL DEFAULT 'previewed',      -- previewed | running | completed | cancelled
  file_name     VARCHAR(200) NULL,
  total_rows    INT NOT NULL DEFAULT 0,
  options       JSON NULL,                                     -- { on_duplicate: 'skip' | 'merge' }
  summary       JSON NULL,
  created_by    VARCHAR(36) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  confirmed_at  DATETIME(3) NULL,
  finished_at   DATETIME(3) NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_import_jobs_id_org (id, org_id),
  KEY idx_import_jobs_org (org_id, created_at),
  KEY idx_import_jobs_status (status),
  CONSTRAINT fk_import_jobs_org FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT fk_import_jobs_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_import_status CHECK (status IN ('previewed','running','completed','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE import_rows (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id      VARCHAR(36) NOT NULL,
  org_id      VARCHAR(36) NOT NULL,
  row_no      INT NOT NULL,                                   -- the line in the file (header is line 1)
  status      VARCHAR(12) NOT NULL,                           -- valid | error | duplicate | processing | created | merged | skipped | failed
  raw         JSON NOT NULL,                                  -- the cells as uploaded, so an error file can be given back
  clean       JSON NULL,                                      -- the cleaned values that will be written
  message     VARCHAR(300) NULL,
  learner_id  VARCHAR(36) NULL,
  claim_token VARCHAR(36) NULL,
  KEY idx_import_rows_job (job_id, row_no),
  KEY idx_import_rows_status (job_id, status),
  CONSTRAINT fk_import_rows_job FOREIGN KEY (job_id, org_id) REFERENCES import_jobs (id, org_id) ON DELETE CASCADE,
  CONSTRAINT chk_import_row_status CHECK (status IN ('valid','error','duplicate','processing','created','merged','skipped','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
