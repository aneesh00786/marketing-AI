import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiRoot } from '../../core/api-base';

/** Client for /api/v1/outreach (email outreach campaigns). Authorization is attached by the auth interceptor. */
@Injectable({ providedIn: 'root' })
export class OutreachApiService {
  private base = `${apiRoot()}/api/v1/outreach`;

  constructor(private http: HttpClient) {}

  status(): Observable<any> { return this.http.get(`${this.base}/status`); }
  campaigns(): Observable<any> { return this.http.get(`${this.base}/campaigns`); }
  campaign(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}`); }
  create(body: any): Observable<any> { return this.http.post(`${this.base}/campaigns`, body); }
  update(id: number, body: any): Observable<any> { return this.http.patch(`${this.base}/campaigns/${id}`, body); }
  remove(id: number): Observable<any> { return this.http.delete(`${this.base}/campaigns/${id}`); }

  generate(id: number, steps: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/generate`, { steps }); }
  saveSteps(id: number, steps: { delayDays: number; subject: string; body: string }[]): Observable<any> { return this.http.put(`${this.base}/campaigns/${id}/steps`, { steps }); }

  previewAudience(filter: any): Observable<any> { return this.http.post(`${this.base}/audience/preview`, { filter }); }
  recipients(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}/recipients`); }
  addRecipients(id: number, leadIds: number[]): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/recipients`, { leadIds }); }
  removeRecipient(id: number, rid: number): Observable<any> { return this.http.delete(`${this.base}/campaigns/${id}/recipients/${rid}`); }
  retryRecipient(id: number, rid: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/recipients/${rid}/retry`, { confirm: true }); }

  readiness(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}/readiness`); }
  approve(id: number, acknowledgeFlags: boolean): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/approve`, { confirm: true, acknowledgeFlags }); }
  resume(id: number, acknowledgeFlags: boolean): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/resume`, { confirm: true, acknowledgeFlags }); }
  pause(id: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/pause`, {}); }
  stop(id: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/stop`, {}); }

  products(): Observable<any> { return this.http.get(`${apiRoot()}/api/v1/products`); }
  leadStatuses(): Observable<any> { return this.http.get(`${apiRoot()}/api/v1/leads`, { params: { limit: '1' } }); }
}
