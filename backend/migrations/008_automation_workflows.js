/**
 * Rule-based automation workflows (AI Campaigns → Automations).
 * Events are recorded by existing modules (leads, email sequences, social publishing) with
 * an idempotency key; the worker turns each event into at most one run per workflow
 * (unique workflow_id + event_id) and executes its steps with retries and an audit trail.
 * Additive only: new tables, no changes to existing data.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '008_automation_workflows',

  async up(db) {
    await db.ensureTable('automation_workflows', `CREATE TABLE automation_workflows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      description VARCHAR(1000) NULL,
      trigger_type VARCHAR(40) NOT NULL,
      trigger_config_json TEXT NULL,
      conditions_json TEXT NULL,
      steps_json LONGTEXT NOT NULL,
      exit_on_reply TINYINT NOT NULL DEFAULT 1,
      max_runs_per_day INT NOT NULL DEFAULT 200,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      version INT NOT NULL DEFAULT 1,
      activated_by INT NULL,
      activated_at DATETIME NULL,
      activated_version INT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_automation_workflows_ws (workspace_id, status, trigger_type),
      CONSTRAINT fk_automation_workflows_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('automation_events', `CREATE TABLE automation_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      subject_type VARCHAR(20) NOT NULL,
      subject_id INT NOT NULL,
      payload_json TEXT NULL,
      idempotency_key VARCHAR(191) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME NULL,
      UNIQUE KEY uq_automation_event (workspace_id, idempotency_key),
      KEY idx_automation_events_pending (status, id)
    ) ${TABLE_OPTS}`);

    await db.ensureTable('automation_runs', `CREATE TABLE automation_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      workflow_id INT NOT NULL,
      workflow_version INT NOT NULL,
      event_id BIGINT NOT NULL,
      subject_type VARCHAR(20) NOT NULL,
      subject_id INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'waiting',
      current_step INT NOT NULL DEFAULT 0,
      next_run_at DATETIME NOT NULL,
      locked_by VARCHAR(120) NULL,
      locked_at DATETIME NULL,
      exit_reason VARCHAR(500) NULL,
      last_error VARCHAR(1000) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      UNIQUE KEY uq_automation_run (workflow_id, event_id),
      KEY idx_automation_runs_due (status, next_run_at),
      KEY idx_automation_runs_ws (workspace_id, workflow_id, id),
      CONSTRAINT fk_automation_runs_workflow FOREIGN KEY (workflow_id) REFERENCES automation_workflows(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('automation_run_steps', `CREATE TABLE automation_run_steps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      run_id INT NOT NULL,
      step_index INT NOT NULL,
      step_type VARCHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      attempts INT NOT NULL DEFAULT 0,
      result_json TEXT NULL,
      error VARCHAR(1000) NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME NULL,
      UNIQUE KEY uq_automation_run_step (run_id, step_index),
      CONSTRAINT fk_automation_run_steps_run FOREIGN KEY (run_id) REFERENCES automation_runs(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
