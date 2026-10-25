/**
 * Reusable email templates (Mail Center > Email Templates). Additive only.
 * - mail_templates: one workspace's saved templates. HTML is stored sanitized, with images as
 *   internal references (mkt-asset://<id>) so links survive a domain change. version supports
 *   safe concurrent edits.
 * - mail_template_assets: images/fonts extracted from uploaded packages. Files live in a
 *   workspace folder on disk under an opaque random public_id; only that id appears in URLs.
 *   template_id is cleared (not cascaded) when a template is deleted, because emails and
 *   campaigns copied from it may still show the images; unreferenced assets are removed only by
 *   the explicit cleanup. import_id marks assets of an import preview that was not saved yet.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '019_mail_templates',

  async up(db) {
    await db.ensureTable('mail_templates', `CREATE TABLE mail_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      description VARCHAR(500) NULL,
      category VARCHAR(50) NOT NULL DEFAULT 'Custom',
      html MEDIUMTEXT NOT NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'blank',
      source_filename VARCHAR(255) NULL,
      warnings_json TEXT NULL,
      version INT NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_mail_templates_ws (workspace_id, updated_at),
      KEY idx_mail_templates_category (workspace_id, category),
      CONSTRAINT fk_mail_templates_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_template_assets', `CREATE TABLE mail_template_assets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      public_id CHAR(43) CHARACTER SET ascii NOT NULL,
      template_id INT NULL,
      import_id CHAR(32) CHARACTER SET ascii NULL,
      mime VARCHAR(50) NOT NULL,
      size_bytes INT NOT NULL,
      sha256 CHAR(64) CHARACTER SET ascii NOT NULL,
      original_name VARCHAR(255) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_template_assets_public (public_id),
      KEY idx_mail_template_assets_ws (workspace_id, template_id),
      KEY idx_mail_template_assets_import (workspace_id, import_id),
      CONSTRAINT fk_mail_template_assets_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_template_assets_tpl FOREIGN KEY (template_id) REFERENCES mail_templates(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);
  }
};
