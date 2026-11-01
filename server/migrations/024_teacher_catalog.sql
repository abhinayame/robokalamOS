-- Teachers could always read programs and courses; they can now also create and edit them (admins and branch admins already could).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = 'catalog:manage'
WHERE r.code = 'teacher' AND NOT EXISTS (SELECT 1 FROM role_permissions x WHERE x.role_id = r.id AND x.permission_id = p.id);
