/**
 * Leads get an address, shown with the lead and matched by the Leads search.
 * Leads found with AI Lead Discovery already carry Google's address in their notes
 * ("Address: …"): it is copied over. Others stay empty until edited or imported with one.
 */
module.exports = {
  id: '039_lead_address',
  async up(db) {
    await db.ensureColumn('leads', 'address', 'VARCHAR(500) NULL');
    const rows = await db.query("SELECT id, notes FROM leads WHERE address IS NULL AND notes LIKE '%Address: %'");
    for (const r of rows) {
      const m = /^Address: (.+)$/m.exec(String(r.notes || ''));
      if (m && m[1].trim()) await db.query('UPDATE leads SET address = ? WHERE id = ? AND address IS NULL', [m[1].trim().slice(0, 500), r.id]);
    }
  }
};
