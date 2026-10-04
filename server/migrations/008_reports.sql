-- Phase 8: analytics and reports. No new tables: everything is computed from the data already recorded.
-- One permission gates the reports and cross-batch analytics; each report also checks the permission of the data it reads
-- (CRM report needs crm:read, communication report needs comms:read) and only ever sees the caller's own scope.
INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'report:read', 'Open analytics and download reports for the learners and batches in your scope');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'report:read'
 WHERE r.code IN ('super_admin','org_admin','branch_admin','teacher','counsellor','accountant');
