import { Injectable } from '@angular/core';
import { HttpClient, HttpEvent, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiRoot } from '../../core/api-base';

/** Client for /api/v1/social. Authorization is attached by the auth interceptor. */
@Injectable({ providedIn: 'root' })
export class SocialApiService {
  private base = `${apiRoot()}/api/v1/social`;

  constructor(private http: HttpClient) {}

  private params(obj: Record<string, any> = {}): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined && v !== '' && v !== 'all') p = p.set(k, String(v));
    }
    return p;
  }

  overview(): Observable<any> { return this.http.get(`${this.base}/overview`); }
  dashboard(params: { range?: string; from?: string; to?: string }): Observable<any> { return this.http.get(`${this.base}/dashboard`, { params: this.params(params) }); }
  capabilities(): Observable<any> { return this.http.get(`${this.base}/capabilities`); }
  providers(): Observable<any> { return this.http.get(`${this.base}/providers`); }
  members(): Observable<any> { return this.http.get(`${this.base}/members`); }

  // Accounts
  startOAuth(provider: string): Observable<any> { return this.http.post(`${this.base}/oauth/${provider}/start`, {}); }
  accounts(includeDisconnected = false): Observable<any> { return this.http.get(`${this.base}/accounts`, { params: this.params({ includeDisconnected: includeDisconnected ? 1 : null }) }); }
  saveProviderApp(provider: string, body: { clientId: string; clientSecret: string }): Observable<any> { return this.http.put(`${this.base}/provider-apps/${provider}`, body); }
  removeProviderApp(provider: string): Observable<any> { return this.http.delete(`${this.base}/provider-apps/${provider}`); }
  checkAccount(id: number): Observable<any> { return this.http.post(`${this.base}/accounts/${id}/check`, {}); }
  disconnectAccount(id: number): Observable<any> { return this.http.delete(`${this.base}/accounts/${id}`); }

  // Products & facts
  products(): Observable<any> { return this.http.get(`${this.base}/products`); }
  extractFacts(url: string): Observable<any> { return this.http.post(`${this.base}/facts/extract`, { url }); }
  saveProduct(p: any): Observable<any> { return this.http.post(`${this.base}/products`, p); }

  // Campaigns
  campaigns(): Observable<any> { return this.http.get(`${this.base}/campaigns`); }
  campaign(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}`); }
  createCampaign(body: any): Observable<any> { return this.http.post(`${this.base}/campaigns`, body); }
  updateCampaign(id: number, body: any): Observable<any> { return this.http.patch(`${this.base}/campaigns/${id}`, body); }
  generateCampaign(id: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/generate`, {}); }

  // Content
  content(filters: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/content`, { params: this.params(filters) }); }
  contentDetail(id: number): Observable<any> { return this.http.get(`${this.base}/content/${id}`); }
  createContent(body: any): Observable<any> { return this.http.post(`${this.base}/content`, body); }
  updateContent(id: number, body: any): Observable<any> { return this.http.patch(`${this.base}/content/${id}`, body); }
  duplicateContent(id: number): Observable<any> { return this.http.post(`${this.base}/content/${id}/duplicate`, {}); }
  regenerateContent(id: number, fields: string[], instruction: string): Observable<any> { return this.http.post(`${this.base}/content/${id}/regenerate`, { fields, instruction }); }
  submitContent(id: number, approverId: number | null): Observable<any> { return this.http.post(`${this.base}/content/${id}/submit`, { approverId }); }
  approveContent(id: number, note?: string): Observable<any> { return this.http.post(`${this.base}/content/${id}/approve`, note ? { note } : {}); }
  rejectContent(id: number, note: string): Observable<any> { return this.http.post(`${this.base}/content/${id}/reject`, { note }); }
  scheduleContent(id: number, body: { accountId?: number; localDateTime: string; timezone?: string }): Observable<any> { return this.http.post(`${this.base}/content/${id}/schedule`, body); }
  publishNow(id: number, accountId?: number): Observable<any> { return this.http.post(`${this.base}/content/${id}/publish-now`, accountId ? { accountId } : {}); }
  unschedule(id: number): Observable<any> { return this.http.post(`${this.base}/content/${id}/unschedule`, {}); }
  cancelContent(id: number): Observable<any> { return this.http.post(`${this.base}/content/${id}/cancel`, {}); }
  deleteContent(id: number): Observable<any> { return this.http.delete(`${this.base}/content/${id}`); }

  // Assets
  assets(): Observable<any> { return this.http.get(`${this.base}/assets`); }
  registerAsset(body: { url: string; assetType: 'image' | 'video'; title?: string }): Observable<any> { return this.http.post(`${this.base}/assets`, body); }

  // Media library (files are sent as the raw request body; progress events drive the upload bar)
  mediaBase(): string { return this.base; }
  media(filters: Record<string, any> = {}): Observable<any> { return this.http.get(`${this.base}/media`, { params: this.params(filters) }); }
  mediaDetail(id: number): Observable<any> { return this.http.get(`${this.base}/media/${id}`); }
  uploadMedia(file: Blob, filename: string, opts: { thumbnailFor?: number; replaceId?: number } = {}): Observable<HttpEvent<any>> {
    const path = opts.replaceId ? `${this.base}/media/${opts.replaceId}/replace` : `${this.base}/media/upload`;
    const params = this.params({ filename, thumbnailFor: opts.thumbnailFor || null });
    return this.http.post(path, file, { params, reportProgress: true, observe: 'events', headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  }
  updateMedia(id: number, body: { title?: string; altText?: string }): Observable<any> { return this.http.patch(`${this.base}/media/${id}`, body); }
  deleteMedia(id: number): Observable<any> { return this.http.delete(`${this.base}/media/${id}`); }

  // Composer, templates, AI help
  validateTargets(body: any): Observable<any> { return this.http.post(`${this.base}/content/validate`, body); }
  compose(body: any): Observable<any> { return this.http.post(`${this.base}/content/compose`, body); }
  templates(): Observable<any> { return this.http.get(`${this.base}/templates`); }
  createTemplate(body: any): Observable<any> { return this.http.post(`${this.base}/templates`, body); }
  deleteTemplate(id: number): Observable<any> { return this.http.delete(`${this.base}/templates/${id}`); }
  aiAssist(body: any): Observable<any> { return this.http.post(`${this.base}/ai/assist`, body); }

  // Calendar & queue
  calendar(filters: Record<string, any>): Observable<any> { return this.http.get(`${this.base}/calendar`, { params: this.params(filters) }); }
  queue(status = 'all'): Observable<any> { return this.http.get(`${this.base}/queue`, { params: this.params({ status }) }); }
  retryJob(id: number, confirmNotPublished = false): Observable<any> { return this.http.post(`${this.base}/queue/${id}/retry`, { confirmNotPublished }); }
  cancelJob(id: number): Observable<any> { return this.http.post(`${this.base}/queue/${id}/cancel`, {}); }

  // Analytics & strategist
  analytics(filters: Record<string, any>): Observable<any> { return this.http.get(`${this.base}/analytics/summary`, { params: this.params(filters) }); }
  syncAnalytics(): Observable<any> { return this.http.post(`${this.base}/analytics/sync`, {}); }
  exportAnalytics(filters: Record<string, any>): Observable<Blob> { return this.http.get(`${this.base}/analytics/export`, { params: this.params(filters), responseType: 'blob' }); }
  ask(question: string): Observable<any> { return this.http.post(`${this.base}/strategist/ask`, { question }); }

  // Inbox
  threads(filters: Record<string, any>): Observable<any> { return this.http.get(`${this.base}/inbox/threads`, { params: this.params(filters) }); }
  thread(id: number): Observable<any> { return this.http.get(`${this.base}/inbox/threads/${id}`); }
  syncInbox(): Observable<any> { return this.http.post(`${this.base}/inbox/sync`, {}); }
  analyzeThread(id: number): Observable<any> { return this.http.post(`${this.base}/inbox/threads/${id}/analyze`, {}); }
  suggestReply(id: number, guidance = ''): Observable<any> { return this.http.post(`${this.base}/inbox/threads/${id}/suggest-reply`, guidance ? { guidance } : {}); }
  sendReply(id: number, text: string, draftMessageId: number | null): Observable<any> { return this.http.post(`${this.base}/inbox/threads/${id}/reply`, { text, draftMessageId }); }
  updateThread(id: number, body: any): Observable<any> { return this.http.patch(`${this.base}/inbox/threads/${id}`, body); }
  createLead(id: number, body: any): Observable<any> { return this.http.post(`${this.base}/inbox/threads/${id}/create-lead`, body); }

  // Settings
  settings(): Observable<any> { return this.http.get(`${this.base}/settings`); }
  saveSettings(body: any): Observable<any> { return this.http.put(`${this.base}/settings`, body); }
  audit(): Observable<any> { return this.http.get(`${this.base}/audit`); }
  usage(): Observable<any> { return this.http.get(`${this.base}/usage`); }
}
