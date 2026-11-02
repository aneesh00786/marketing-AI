import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiRoot } from '../../core/api-base';

export type CrmSection = 'dashboard' | 'contacts' | 'companies' | 'deals' | 'support' | 'calls';
export type CrmParent = 'contacts' | 'companies' | 'deals' | 'tickets';
/** The signed-in user's CRM grant. Null means no access. */
export interface CrmAccess { role: string; capabilities: string[] }

export const CRM_SECTIONS: { key: CrmSection; label: string; icon: string }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { key: 'contacts', label: 'Contacts', icon: 'leads' },
  { key: 'companies', label: 'Companies', icon: 'building' },
  { key: 'deals', label: 'Deals', icon: 'briefcase' },
  { key: 'support', label: 'Support', icon: 'inbox' },
  { key: 'calls', label: 'Calls', icon: 'phone' }
];

/** Resolves a deep link (?view=crm&section=…) to a CRM section, or null when it is not a CRM link. */
export function crmSectionFromLink(view: string | null, section: string | null): CrmSection | null {
  if (view !== 'crm') return null;
  return CRM_SECTIONS.some(s => s.key === section) ? section as CrmSection : 'dashboard';
}

/** Tone of a status, stage or priority tag. The label always says the value too. */
export function statusTone(s: string | null): string {
  if (s === 'Won' || s === 'Customer' || s === 'Resolved') return 'good';
  if (s === 'Lost' || s === 'High') return 'bad';
  if (s === 'In Progress' || s === 'Medium') return 'warn';
  if (s === 'New' || s === 'Open' || s === 'Prospect') return 'info';
  return '';
}

export const errorText = (e: any): string => e?.error?.error || e?.message || 'Request failed.';

/** The server checks sign-in, the CRM grant and the permission on every call. */
@Injectable({ providedIn: 'root' })
export class CrmApiService {
  private base = `${apiRoot()}/api/v1/global-crm`;

  constructor(private http: HttpClient) {}

  private params(q: Record<string, any>): Record<string, string> {
    return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
  }

  overview(): Observable<any> { return this.http.get(`${this.base}/overview`); }
  team(): Observable<any> { return this.http.get(`${this.base}/team`); }

  contacts(q: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/contacts`, { params: this.params(q) }); }
  contact(id: number): Observable<any> { return this.http.get(`${this.base}/contacts/${id}`); }
  saveContact(id: number | null, body: any): Observable<any> {
    return id ? this.http.patch(`${this.base}/contacts/${id}`, body) : this.http.post(`${this.base}/contacts`, body);
  }

  companies(q: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/companies`, { params: this.params(q) }); }
  company(id: number): Observable<any> { return this.http.get(`${this.base}/companies/${id}`); }
  saveCompany(id: number | null, body: any): Observable<any> {
    return id ? this.http.patch(`${this.base}/companies/${id}`, body) : this.http.post(`${this.base}/companies`, body);
  }

  deals(q: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/deals`, { params: this.params(q) }); }
  deal(id: number): Observable<any> { return this.http.get(`${this.base}/deals/${id}`); }
  saveDeal(id: number | null, body: any): Observable<any> {
    return id ? this.http.patch(`${this.base}/deals/${id}`, body) : this.http.post(`${this.base}/deals`, body);
  }
  deleteDeal(id: number): Observable<any> { return this.http.delete(`${this.base}/deals/${id}`); }

  tickets(q: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/tickets`, { params: this.params(q) }); }
  ticket(id: number): Observable<any> { return this.http.get(`${this.base}/tickets/${id}`); }
  saveTicket(id: number | null, body: any): Observable<any> {
    return id ? this.http.patch(`${this.base}/tickets/${id}`, body) : this.http.post(`${this.base}/tickets`, body);
  }

  calls(q: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/calls`, { params: this.params(q) }); }
  call(id: number): Observable<any> { return this.http.get(`${this.base}/calls/${id}`); }
  removeTranscript(id: number): Observable<any> { return this.http.delete(`${this.base}/calls/${id}/transcript`); }

  activities(parent: CrmParent, id: number): Observable<any> { return this.http.get(`${this.base}/${parent}/${id}/activities`); }
  addActivity(parent: CrmParent, id: number, body: any): Observable<any> { return this.http.post(`${this.base}/${parent}/${id}/activities`, body); }
  setTaskDone(id: number, done: boolean): Observable<any> { return this.http.patch(`${this.base}/activities/${id}`, { done }); }
}
