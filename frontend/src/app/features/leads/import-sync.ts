/**
 * What happens to imported contacts besides becoming leads: optionally adding them to a contact
 * list in Marketech.ai (listKey: its id). Sent with POST /leads/import-bulk.
 */
export interface ImportSync {
  list: 'none' | 'existing' | 'new';
  listKey: string;
  listName: string;
}

export function newImportSync(listKey = ''): ImportSync {
  return { list: listKey ? 'existing' : 'none', listKey, listName: '' };
}

/** Why the import cannot start yet ('' when it can). */
export function importSyncProblem(o: ImportSync): string {
  if (o.list === 'existing' && !o.listKey) return 'Choose the contact list.';
  if (o.list === 'new' && !o.listName.trim()) return 'Enter a name for the new contact list.';
  return '';
}

export function importSyncBody(o: ImportSync): { mailList?: any } {
  const body: any = {};
  if (o.list === 'existing' && o.listKey) body.mailList = { id: Number(o.listKey) };
  if (o.list === 'new' && o.listName.trim()) body.mailList = { name: o.listName.trim() };
  return body;
}
