-- Phase 12: organization branding. Name, tagline, colors, a logo, an optional custom domain and support contacts, applied to the sign-in page,
-- the app chrome and the installable app (PWA manifest).

ALTER TABLE organizations
  ADD COLUMN brand_app_name    VARCHAR(40)  NULL,
  ADD COLUMN brand_tagline     VARCHAR(160) NULL,
  ADD COLUMN brand_color       VARCHAR(7)   NULL,
  ADD COLUMN brand_accent      VARCHAR(7)   NULL,
  ADD COLUMN brand_logo_file_id VARCHAR(36) NULL,
  ADD COLUMN custom_domain     VARCHAR(190) NULL,
  ADD COLUMN support_email     VARCHAR(160) NULL,
  ADD COLUMN support_phone     VARCHAR(30)  NULL,
  ADD UNIQUE KEY uq_org_custom_domain (custom_domain),
  ADD CONSTRAINT chk_org_brand_color  CHECK (brand_color  IS NULL OR brand_color  REGEXP '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT chk_org_brand_accent CHECK (brand_accent IS NULL OR brand_accent REGEXP '^#[0-9a-fA-F]{6}$');

-- A logo is a file that belongs to the organization itself (so the 2-day clean-up of unattached uploads never removes it).
ALTER TABLE files DROP CONSTRAINT chk_files_owner;
ALTER TABLE files ADD CONSTRAINT chk_files_owner CHECK (owner_type IS NULL OR owner_type IN ('material','assignment','submission','branding'));
