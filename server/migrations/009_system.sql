-- Phase 9: operations. One permission for the System status page (health, traffic, queues, integrity checks).
INSERT INTO permissions (id, code, description) VALUES
  (UUID(), 'system:read', 'View the System status page: health, traffic, queues and data-integrity checks');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'system:read' WHERE r.code IN ('super_admin','org_admin');
