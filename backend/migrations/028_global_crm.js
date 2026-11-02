/**
 * Global CRM and customer support. Additive only: new tables, no change to any existing table.
 *
 * These tables have no workspace_id on purpose. The CRM is one shared system, separate from the
 * workspace marketing platform: it does not read or copy Leads, and Leads do not read it.
 *
 * crm_user_access: who may use the CRM. Workspace roles do not grant access, because every person
 * who registers is the owner of their own workspace. Grants are made per user with
 * `npm run crm-access` (see modules/crm/crmAccess.js). No grant is created here: after this
 * migration only the platform admin (the Owner of workspace 1) can open the CRM until one is made.
 * crm_activities: notes, follow-up tasks and recorded changes, each on one contact, company, deal
 * or support ticket (one of the four columns is set, enforced by crmService).
 *
 * Deleting a user removes their access and clears their name from records. Deleting a contact or
 * company keeps its deals and tickets, without the link. Deleting a deal deletes its activities.
 *
 * Rollback: older code ignores these tables, so restoring the previous release needs no database
 * change. To remove them, drop in this order: crm_activities, crm_support_tickets, crm_deals,
 * crm_contacts, crm_companies, crm_user_access; then delete the 028_global_crm row from
 * schema_migrations. That deletes all CRM data, so take a backup first.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '028_global_crm',

  async up(db) {
    await db.ensureTable('crm_user_access', `CREATE TABLE crm_user_access (
      user_id INT PRIMARY KEY,
      role VARCHAR(20) NOT NULL,
      granted_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      CONSTRAINT fk_crm_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_crm_access_grantor FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);

    await db.ensureTable('crm_companies', `CREATE TABLE crm_companies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      website VARCHAR(500) NULL,
      industry VARCHAR(100) NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_crm_companies_name (name(191)),
      CONSTRAINT fk_crm_companies_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);

    await db.ensureTable('crm_contacts', `CREATE TABLE crm_contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      phone_digits VARCHAR(50) NULL,
      company_id INT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Prospect',
      assigned_to INT NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_crm_contacts_email (email(191)),
      KEY idx_crm_contacts_phone (phone_digits),
      KEY idx_crm_contacts_name (full_name(100)),
      KEY idx_crm_contacts_company (company_id),
      KEY idx_crm_contacts_assigned (assigned_to),
      CONSTRAINT fk_crm_contacts_company FOREIGN KEY (company_id) REFERENCES crm_companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_contacts_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_contacts_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);

    await db.ensureTable('crm_deals', `CREATE TABLE crm_deals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      contact_id INT NULL,
      company_id INT NULL,
      value DECIMAL(14,2) NULL,
      stage VARCHAR(20) NOT NULL DEFAULT 'New',
      assigned_to INT NULL,
      expected_close_date DATE NULL,
      notes TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_crm_deals_stage (stage),
      KEY idx_crm_deals_contact (contact_id),
      KEY idx_crm_deals_company (company_id),
      KEY idx_crm_deals_assigned (assigned_to),
      CONSTRAINT fk_crm_deals_contact FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_deals_company FOREIGN KEY (company_id) REFERENCES crm_companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_deals_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_deals_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);

    await db.ensureTable('crm_support_tickets', `CREATE TABLE crm_support_tickets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      subject VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      contact_id INT NULL,
      company_id INT NULL,
      priority VARCHAR(10) NOT NULL DEFAULT 'Medium',
      status VARCHAR(20) NOT NULL DEFAULT 'Open',
      assigned_to INT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_crm_tickets_status (status),
      KEY idx_crm_tickets_contact (contact_id),
      KEY idx_crm_tickets_company (company_id),
      KEY idx_crm_tickets_assigned (assigned_to),
      CONSTRAINT fk_crm_tickets_contact FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_tickets_company FOREIGN KEY (company_id) REFERENCES crm_companies(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_tickets_assigned FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_tickets_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);

    await db.ensureTable('crm_activities', `CREATE TABLE crm_activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      contact_id INT NULL,
      company_id INT NULL,
      deal_id INT NULL,
      ticket_id INT NULL,
      type VARCHAR(20) NOT NULL,
      body TEXT NOT NULL,
      due_date DATE NULL,
      done_at DATETIME NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_crm_activities_created (created_at),
      KEY idx_crm_activities_contact (contact_id),
      KEY idx_crm_activities_company (company_id),
      KEY idx_crm_activities_deal (deal_id),
      KEY idx_crm_activities_ticket (ticket_id),
      CONSTRAINT fk_crm_activities_contact FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE,
      CONSTRAINT fk_crm_activities_company FOREIGN KEY (company_id) REFERENCES crm_companies(id) ON DELETE CASCADE,
      CONSTRAINT fk_crm_activities_deal FOREIGN KEY (deal_id) REFERENCES crm_deals(id) ON DELETE CASCADE,
      CONSTRAINT fk_crm_activities_ticket FOREIGN KEY (ticket_id) REFERENCES crm_support_tickets(id) ON DELETE CASCADE,
      CONSTRAINT fk_crm_activities_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);
  }
};
