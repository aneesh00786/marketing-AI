/**
 * Social media library, multi-account composer and saved post templates. Additive only.
 * - assets: uploaded files. Files live in a workspace folder on disk under an opaque random
 *   public_id (SOCIAL_MEDIA_STORAGE_DIR); only that id appears in URLs. The probed facts
 *   (dimensions, duration, codecs, frame rate) are stored so platform rules can be checked
 *   before publishing. Files are never overwritten: "replace" uploads a new asset and edits the
 *   posts that used the old one, which bumps their version and revokes their approval.
 *   Deleting marks the row deleted and removes the file; rows stay for publication history.
 * - content_items.post_group_id links the per-account posts created together in the composer.
 * - content_items.platform_options_json holds per-platform publish options (e.g. YouTube privacy).
 * - social_post_templates: reusable captions/post templates per workspace.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '023_social_media_library',

  async up(db) {
    await db.ensureColumn('assets', 'public_id', 'CHAR(43) CHARACTER SET ascii NULL');
    await db.ensureColumn('assets', 'status', "VARCHAR(20) NOT NULL DEFAULT 'ready'");
    await db.ensureColumn('assets', 'original_name', 'VARCHAR(255) NULL');
    await db.ensureColumn('assets', 'video_codec', 'VARCHAR(20) NULL');
    await db.ensureColumn('assets', 'audio_codec', 'VARCHAR(20) NULL');
    await db.ensureColumn('assets', 'frame_rate', 'DECIMAL(8,3) NULL');
    await db.ensureColumn('assets', 'thumbnail_asset_id', 'INT NULL');
    await db.ensureColumn('assets', 'alt_text', 'VARCHAR(1000) NULL');
    await db.ensureColumn('assets', 'deleted_at', 'DATETIME NULL');
    await db.ensureColumn('assets', 'updated_at', 'DATETIME NULL');
    await db.ensureIndex('assets', 'uq_assets_public_id', 'UNIQUE KEY uq_assets_public_id (public_id)');
    await db.ensureIndex('assets', 'idx_assets_ws_status', 'KEY idx_assets_ws_status (workspace_id, status, id)');

    await db.ensureColumn('content_items', 'post_group_id', 'VARCHAR(36) NULL');
    await db.ensureColumn('content_items', 'platform_options_json', 'LONGTEXT NULL');
    await db.ensureIndex('content_items', 'idx_content_ws_post_group', 'KEY idx_content_ws_post_group (workspace_id, post_group_id)');

    await db.ensureTable('social_post_templates', `CREATE TABLE social_post_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      caption TEXT NULL,
      hashtags VARCHAR(3000) NULL,
      call_to_action VARCHAR(255) NULL,
      link_url VARCHAR(500) NULL,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_social_templates_ws (workspace_id, name),
      CONSTRAINT fk_social_templates_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
