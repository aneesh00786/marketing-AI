/**
 * Contact lists kept in Marketech.ai. Additive only.
 * - mail_lists: a workspace's own mailing lists. Lists copied from Zoho when it is connected keep
 *   the key of their Zoho list (zoho_list_key) while that list exists in Zoho.
 * - mail_contacts: each person once per workspace (by email), with the details copied from Zoho or
 *   entered here. Separate from Leads.
 * - mail_list_members: who is in which list, with their status in that list
 *   (subscribed, unsubscribed, bounced). Unsubscribed and bounced people are never sent to.
 * - mail_contacts.in_zoho: the person is already in the Zoho account (copied from it, or uploaded
 *   for a send), so sending to them again does not add to the Zoho plan's contact count.
 * - mail_campaigns: the Marketech.ai lists a campaign goes to (mail_list_ids_json), the upload
 *   progress while they are put into Zoho for the send (upload_total / upload_done), and the
 *   temporary Zoho lists made for it (temp_lists_json), deleted once Zoho reports it Sent
 *   (temp_lists_deleted_at).
 * Rollback: older code ignores these tables and columns; drop them (members first) and delete the
 * 034 row from schema_migrations.
 */
const OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '034_mail_contact_lists',

  async up(db) {
    await db.ensureTable('mail_lists', `CREATE TABLE mail_lists (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'local',
      zoho_list_key VARCHAR(200) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_lists_name (workspace_id, name),
      KEY idx_mail_lists_zoho (workspace_id, zoho_list_key),
      CONSTRAINT fk_mail_lists_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${OPTS}`);
    await db.ensureTable('mail_contacts', `CREATE TABLE mail_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NULL,
      last_name VARCHAR(100) NULL,
      company VARCHAR(200) NULL,
      phone VARCHAR(50) NULL,
      city VARCHAR(100) NULL,
      state VARCHAR(100) NULL,
      country VARCHAR(100) NULL,
      source VARCHAR(20) NOT NULL DEFAULT 'local',
      in_zoho TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_contacts_email (workspace_id, email),
      CONSTRAINT fk_mail_contacts_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${OPTS}`);
    await db.ensureTable('mail_list_members', `CREATE TABLE mail_list_members (
      list_id INT NOT NULL,
      contact_id INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'subscribed',
      added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (list_id, contact_id),
      KEY idx_mail_list_members_contact (contact_id),
      CONSTRAINT fk_mail_list_members_list FOREIGN KEY (list_id) REFERENCES mail_lists(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_list_members_contact FOREIGN KEY (contact_id) REFERENCES mail_contacts(id) ON DELETE CASCADE
    ) ${OPTS}`);
    await db.ensureColumn('mail_contacts', 'in_zoho', 'TINYINT(1) NOT NULL DEFAULT 0');
    await db.ensureColumn('mail_campaigns', 'mail_list_ids_json', 'TEXT NULL');
    await db.ensureColumn('mail_campaigns', 'upload_total', 'INT NULL');
    await db.ensureColumn('mail_campaigns', 'upload_done', 'INT NULL');
    await db.ensureColumn('mail_campaigns', 'temp_lists_json', 'TEXT NULL');
    await db.ensureColumn('mail_campaigns', 'temp_lists_deleted_at', 'DATETIME NULL');
  }
};
