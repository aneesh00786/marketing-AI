/**
 * What happens to imported contacts besides becoming leads: marketing consent recorded with its
 * evidence, and a contact list in Marketech.ai to add them to (listKey: its id). Sent with POST /leads/import-bulk.
 */
export interface ImportSync {
  consent: boolean;
  method: string;
  obtainedAt: string;
  evidence: string;
  attest: boolean;
  list: 'none' | 'existing' | 'new';
  listKey: string;
  listName: string;
}

export const CONSENT_METHOD_LABELS: { value: string; label: string }[] = [
  { value: 'web_form', label: 'Website form' },
  { value: 'double_opt_in', label: 'Double opt-in (confirmed by email)' },
  { value: 'checkbox_at_signup', label: 'Tick box at sign-up' },
  { value: 'event_signup', label: 'Event or trade show sign-up' },
  { value: 'written', label: 'Written (signed form, email)' },
  { value: 'customer_request', label: 'They asked to be contacted' }
];

export function newImportSync(listKey = ''): ImportSync {
  return { consent: false, method: 'web_form', obtainedAt: new Date().toISOString().slice(0, 10), evidence: '', attest: false, list: listKey ? 'existing' : 'none', listKey, listName: '' };
}

/** Why the import cannot start yet ('' when it can). */
export function importSyncProblem(o: ImportSync): string {
  if (o.consent) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.obtainedAt)) return 'Give the date consent was given.';
    if (o.obtainedAt > new Date().toISOString().slice(0, 10)) return 'The consent date cannot be in the future.';
    if (o.evidence.trim().length < 3) return 'Describe the proof of consent (form, document, sign-up sheet…).';
    if (!o.attest) return 'Confirm that you hold this proof for these contacts.';
  }
  if (o.list === 'existing' && !o.listKey) return 'Choose the contact list.';
  if (o.list === 'new' && !o.listName.trim()) return 'Enter a name for the new contact list.';
  return '';
}

export function importSyncBody(o: ImportSync): { consent?: any; mailList?: any } {
  const body: any = {};
  if (o.consent) body.consent = { method: o.method, obtainedAt: o.obtainedAt, evidence: o.evidence.trim(), attest: true };
  if (o.list === 'existing' && o.listKey) body.mailList = { id: Number(o.listKey) };
  if (o.list === 'new' && o.listName.trim()) body.mailList = { name: o.listName.trim() };
  return body;
}
