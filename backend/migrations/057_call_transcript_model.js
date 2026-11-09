/**
 * crm_call_logs.transcript_model: which speech-to-text model made the transcript (and whether it
 * had timings), shown with the transcript so it is clear why a call reads as a conversation or not.
 * Reversible: down() drops the column.
 */
module.exports = {
  id: '057_call_transcript_model',
  async up(db) {
    await db.ensureColumn('crm_call_logs', 'transcript_model', 'VARCHAR(120) NULL');
  },
  async down(db) {
    await db.query('ALTER TABLE crm_call_logs DROP COLUMN IF EXISTS transcript_model').catch(() => null);
  }
};
