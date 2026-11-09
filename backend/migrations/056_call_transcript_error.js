/**
 * crm_call_logs.transcript_error: why a call's transcript could not be made (e.g. Telnyx's
 * refusal, without credentials), so the call history can say why, not only "failed".
 * Reversible: down() drops the column.
 */
module.exports = {
  id: '056_call_transcript_error',
  async up(db) {
    await db.ensureColumn('crm_call_logs', 'transcript_error', 'VARCHAR(300) NULL');
  },
  async down(db) {
    await db.query('ALTER TABLE crm_call_logs DROP COLUMN IF EXISTS transcript_error').catch(() => null);
  }
};
