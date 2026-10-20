/**
 * Automation: remember the last event id at activation, so a workflow only reacts to events
 * that happened after it was approved (timestamps alone are too coarse). Additive only.
 */
module.exports = {
  id: '009_automation_activation_watermark',

  async up(db) {
    await db.ensureColumn('automation_workflows', 'activated_after_event_id', 'BIGINT NULL');
  }
};
