import * as XLSX from 'xlsx';

/** One spreadsheet row, mapped from known column names only (blank cells stay blank). */
export interface LeadSheetRow {
  name: string; companyName: string; email: string; phone: string; country?: string;
  product: string; productId: string; estimatedBudget: string; notes: string;
}

const pick = (row: any, keys: string[]) => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

/** Reads the first sheet of an .xlsx / .xls / .csv file. Rows without a name are counted, not returned. */
export function parseLeadSheet(file: File): Promise<{ rows: LeadSheetRow[]; skippedNoName: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = (e: any) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' });
        const rows = raw.map(row => ({
          name: pick(row, ['Name', 'name', 'Contact Name', 'Full Name', 'Contact', 'First Name']),
          companyName: pick(row, ['Company', 'company', 'Company Name', 'Organisation', 'Organization', 'Business', 'Business Name']),
          email: pick(row, ['Email', 'email', 'E-mail', 'Email Address', 'Contact Email']),
          phone: pick(row, ['Phone', 'phone', 'Mobile', 'Phone Number', 'Contact Number']),
          country: pick(row, ['Country', 'country', 'Country Name']),
          address: pick(row, ['Address', 'address', 'Street Address', 'Full Address', 'Location']),
          product: pick(row, ['Product', 'product', 'Product Name', 'Interest', 'interest']),
          productId: pick(row, ['Product ID', 'product_id', 'productId', 'Product Id']),
          estimatedBudget: pick(row, ['Budget', 'budget', 'Estimated Budget', 'Deal Value']),
          notes: pick(row, ['Notes', 'notes', 'Comments'])
        }));
        // A row with only a company is still a contact: the company becomes its name.
        for (const r of rows) if (!r.name && r.companyName && r.email) r.name = r.companyName;
        resolve({ rows: rows.filter(r => r.name), skippedNoName: rows.filter(r => !r.name).length });
      } catch (err: any) {
        reject(new Error(`Error reading spreadsheet: ${err?.message || err}`));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}
