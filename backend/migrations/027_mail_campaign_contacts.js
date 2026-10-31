/**
 * Contacts chosen one by one for an email campaign. Additive only.
 *
 * mail_campaign_contacts: the selection of one campaign, either leads from Leads CRM (re-checked
 * against consent and suppression at send time) or contacts picked from a Zoho mailing list.
 * synced_version records which campaign version a contact was already added to Zoho for, so a
 * failed send resumes where it stopped. Deleting the campaign, the lead or the workspace deletes
 * the row. The contacts themselves are not copied anywhere else.
 *
 * mail_campaigns.contact_list_*: the Zoho list made for the selection when the campaign is sent.
 * Its generated name is stored before Zoho is called, so a retry after an unclear result finds
 * the same list and never adopts a list of the same name from another system.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '027_mail_campaign_contacts',

  async up(db) {
    await db.ensureTable('mail_campaign_contacts', `CREATE TABLE mail_campaign_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NOT NULL,
      lead_id INT NULL,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(200) NULL,
      company VARCHAR(200) NULL,
      source VARCHAR(20) NOT NULL,
      source_list_key VARCHAR(200) NULL,
      synced_version INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_campaign_contact (campaign_id, email(191)),
      KEY idx_mail_campaign_contacts_ws (workspace_id),
      KEY idx_mail_campaign_contacts_lead (lead_id),
      CONSTRAINT fk_mail_campaign_contacts_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_campaign_contacts_campaign FOREIGN KEY (campaign_id) REFERENCES mail_campaigns(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_campaign_contacts_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
    await db.ensureColumn('mail_campaigns', 'contact_list_name', 'VARCHAR(100) NULL');
    await db.ensureColumn('mail_campaigns', 'contact_list_key', 'VARCHAR(200) NULL');
    await db.ensureColumn('mail_campaigns', 'contact_list_version', 'INT NULL');
  }
};
