import * as XLSX from 'xlsx';

/**
 * Reading lead spreadsheets whatever their layout: any sheet, headings on any of the first rows,
 * and any heading names. Each file column is matched to a lead field automatically (by known
 * names and close spellings); the user can change the matches before importing. Columns that
 * match nothing can be kept in the lead's notes so no information is lost.
 */

/** One lead built from a spreadsheet row (blank cells stay blank). */
export interface LeadSheetRow {
  name: string; companyName: string; email: string; phone: string; country?: string; address?: string;
  product: string; productId: string; estimatedBudget: string; notes: string;
}

export interface SheetData { name: string; cells: string[][] }

export type LeadField = '' | 'name' | 'firstName' | 'lastName' | 'companyName' | 'email' | 'phone' | 'country' | 'address' | 'city'
  | 'product' | 'productId' | 'estimatedBudget' | 'notes';

/** Lead fields a column can be matched to, with the heading names recognised for each. */
export const LEAD_FIELDS: { key: Exclude<LeadField, ''>; label: string; names: string[] }[] = [
  { key: 'name', label: 'Full name', names: ['name', 'full name', 'contact name', 'contact', 'contact person', 'person', 'lead name', 'customer name', 'client name', 'attendee', 'nombre'] },
  { key: 'firstName', label: 'First name', names: ['first name', 'firstname', 'given name', 'forename', 'first'] },
  { key: 'lastName', label: 'Last name', names: ['last name', 'lastname', 'surname', 'family name', 'last'] },
  { key: 'companyName', label: 'Company', names: ['company', 'company name', 'organisation', 'organization', 'org', 'business', 'business name', 'account', 'account name', 'firm', 'employer', 'trading name'] },
  { key: 'email', label: 'Email', names: ['email', 'e-mail', 'email address', 'mail', 'contact email', 'work email', 'business email', 'email id', 'emailid'] },
  { key: 'phone', label: 'Phone', names: ['phone', 'phone number', 'mobile', 'mobile number', 'cell', 'telephone', 'tel', 'contact number', 'whatsapp', 'work phone', 'ph', 'mob'] },
  { key: 'country', label: 'Country', names: ['country', 'country name', 'nation', 'region'] },
  { key: 'address', label: 'Address', names: ['address', 'street address', 'full address', 'location', 'street', 'address line 1', 'postal address'] },
  { key: 'city', label: 'City (added to address)', names: ['city', 'town', 'suburb', 'state', 'province', 'postcode', 'zip', 'zip code', 'postal code'] },
  { key: 'product', label: 'Product name', names: ['product', 'product name', 'interest', 'interested in', 'product interest', 'service', 'solution'] },
  { key: 'productId', label: 'Product ID', names: ['product id', 'productid', 'product_id', 'product code'] },
  { key: 'estimatedBudget', label: 'Budget', names: ['budget', 'estimated budget', 'deal value', 'value', 'amount', 'deal size', 'revenue', 'potential value'] },
  { key: 'notes', label: 'Notes', names: ['notes', 'note', 'comments', 'comment', 'remarks', 'description', 'details', 'message', 'requirement', 'requirements'] }
];
/** Fields several columns may be matched to (their values are joined). */
const MULTI: LeadField[] = ['notes', 'city'];

const norm = (s: string) => String(s || '').toLowerCase().replace(/[_\-./]+/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const text = (v: any) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Reads every non-empty sheet of an .xlsx / .xls / .csv file as text cells (as shown in Excel). */
export function readWorkbook(file: File): Promise<SheetData[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = (e: any) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const sheets = wb.SheetNames.map(name => {
          // raw: false gives the displayed text, so phone numbers keep leading zeros and are not turned into 6.1E+10.
          const cells: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false, blankrows: false });
          return { name, cells: cells.map(r => r.map(text)).filter(r => r.some(c => c)) };
        }).filter(s => s.cells.length);
        if (!sheets.length) throw new Error('The file has no data.');
        resolve(sheets);
      } catch (err: any) {
        reject(new Error(err?.message?.startsWith('The file') ? err.message : `Error reading spreadsheet: ${err?.message || err}`));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Which lead field a heading looks like ('' = none). Exact names first, then close matches. */
export function guessField(heading: string): LeadField {
  const h = norm(heading);
  if (!h) return '';
  for (const f of LEAD_FIELDS) if (f.names.includes(h)) return f.key;
  // "Customer E-mail", "Primary phone no", "Company / Organisation"…
  if (/\bemail|\bmail\b/.test(h)) return 'email';
  if (/phone|mobile|\bcell|\btel\b|whatsapp/.test(h)) return 'phone';
  if (/first ?name|given/.test(h)) return 'firstName';
  if (/last ?name|surname|family/.test(h)) return 'lastName';
  if (/product.*(id|code)/.test(h)) return 'productId';
  if (/product|interest|service/.test(h)) return 'product';
  if (/compan|organi[sz]ation|business|employer|firm/.test(h)) return 'companyName';
  if (/countr/.test(h)) return 'country';
  if (/address|street|location/.test(h)) return 'address';
  if (/city|town|suburb|post ?code|zip/.test(h)) return 'city';
  if (/budget|value|amount|revenue/.test(h)) return 'estimatedBudget';
  if (/note|comment|remark|description|requirement/.test(h)) return 'notes';
  if (/\bname\b|contact|person/.test(h)) return 'name';
  return '';
}

/** The row holding the headings: of the first 15 rows, the one whose cells look most like headings. */
export function detectHeaderRow(cells: string[][]): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(15, cells.length); i++) {
    const row = cells[i];
    const filled = row.filter(c => c).length;
    if (filled < 2) continue;
    const known = row.filter(c => guessField(c)).length;
    const looksLikeData = row.some(c => EMAIL_RE.test(c) || /^\+?\d[\d\s()-]{6,}$/.test(c));
    const score = known * 10 + filled - (looksLikeData ? 50 : 0);
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

/** One field per column; a single-value field matched twice keeps only the first column. */
export function autoMap(headings: string[]): LeadField[] {
  const used = new Set<LeadField>();
  return headings.map(hd => {
    const f = guessField(hd);
    if (!f || (used.has(f) && !MULTI.includes(f))) return '';
    used.add(f);
    return f;
  });
}

/** A key for remembering the matches chosen for files with the same headings. */
export const headingsKey = (headings: string[]) => headings.map(norm).join('|');

/** The file's headings (blank ones named by their column letter). */
export function headingsOf(cells: string[][], headerRow: number): string[] {
  const width = Math.max(0, ...cells.map(r => r.length));
  const row = cells[headerRow] || [];
  return Array.from({ length: width }, (_, i) => row[i] || `Column ${XLSX.utils.encode_col(i)}`);
}

/** Builds leads from the rows under the headings with the chosen matches. */
export function buildLeadRows(cells: string[][], headerRow: number, mapping: LeadField[], { extraToNotes = true } = {}): { rows: LeadSheetRow[]; skippedNoName: number } {
  const headings = headingsOf(cells, headerRow);
  const rows: LeadSheetRow[] = [];
  let skippedNoName = 0;
  for (const r of cells.slice(headerRow + 1)) {
    if (!r.some(c => c)) continue;
    const get = (f: LeadField) => mapping.map((m, i) => (m === f ? text(r[i]) : '')).filter(Boolean);
    const one = (f: LeadField) => get(f)[0] || '';
    const emailCell = one('email');
    const email = (emailCell.match(EMAIL_RE) || [''])[0].toLowerCase(); // "Ann <ann@x.com>", "a@x.com; b@x.com"
    const notes = get('notes');
    if (extraToNotes) {
      mapping.forEach((m, i) => { if (!m && text(r[i])) notes.push(`${headings[i]}: ${text(r[i])}`); });
    }
    // Lengths fit the lead fields, so one long cell never stops the import.
    const lead: LeadSheetRow = {
      name: (one('name') || [one('firstName'), one('lastName')].filter(Boolean).join(' ')).slice(0, 255),
      companyName: one('companyName').slice(0, 255),
      email,
      phone: one('phone').slice(0, 50),
      country: one('country').slice(0, 100),
      address: [one('address'), ...get('city')].filter(Boolean).join(', ').slice(0, 500),
      product: one('product').slice(0, 255),
      productId: one('productId'),
      estimatedBudget: one('estimatedBudget').slice(0, 100),
      notes: notes.join('\n').slice(0, 5000)
    };
    // A row with only a company is still a contact: the company becomes its name.
    if (!lead.name && lead.companyName) lead.name = lead.companyName;
    if (!lead.name && lead.email) lead.name = lead.email.split('@')[0];
    if (lead.name) rows.push(lead); else skippedNoName++;
  }
  return { rows, skippedNoName };
}

/** One-step read with automatic matches (first sheet), for places without the matching step. */
export async function parseLeadSheet(file: File): Promise<{ rows: LeadSheetRow[]; skippedNoName: number }> {
  const [sheet] = await readWorkbook(file);
  const headerRow = detectHeaderRow(sheet.cells);
  return buildLeadRows(sheet.cells, headerRow, autoMap(headingsOf(sheet.cells, headerRow)), { extraToNotes: false });
}
