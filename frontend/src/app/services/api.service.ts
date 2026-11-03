import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiRoot } from '../core/api-base';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private root = apiRoot();
  private baseUrl = `${this.root}/api/v1`;

  constructor(private http: HttpClient) {}

  /** No token here: the auth interceptor sends the HttpOnly session cookie and the app header. */
  private getHeaders(): HttpHeaders {
    return new HttpHeaders();
  }

  // 1. Authentication
  login(credentials: { email: string; password: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/login`, credentials);
  }

  register(data: { email: string; password: string; displayName: string; workspaceName: string; industry: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/register`, data);
  }

  // Workspaces of the signed-in user. Switching and creating return a new token for that workspace.
  getWorkspaces(): Observable<any> {
    return this.http.get(`${this.baseUrl}/workspaces`);
  }

  switchWorkspace(workspaceId: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/switch-workspace`, { workspaceId });
  }

  createWorkspace(data: { name: string; industry?: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/workspaces`, data);
  }

  // Invitations sent to the signed-in account. Accepting needs the token from the invitation link.
  getMyInvitations(): Observable<any> {
    return this.http.get(`${this.baseUrl}/invitations`);
  }

  previewInvitation(token: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/invitations/preview`, { token });
  }

  acceptInvitation(token: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/invitations/accept`, { token });
  }

  declineInvitation(body: { token?: string; id?: number }): Observable<any> {
    return this.http.post(`${this.baseUrl}/invitations/decline`, body);
  }

  /** The signed-in user's global CRM grant ({ access: null } when they have none). */
  getCrmAccess(): Observable<any> {
    return this.http.get(`${this.baseUrl}/global-crm/me`);
  }

  /** Whether the signed-in user is the platform admin ({ admin: boolean }). */
  getPlatformAccess(): Observable<any> {
    return this.http.get(`${this.baseUrl}/platform/me`);
  }

  getMe(): Observable<any> {
    return this.http.get(`${this.baseUrl}/auth/me`, { headers: this.getHeaders() });
  }

  /** Ends this sign-in on the server (a copy of the token stops working too). */
  signOutOnServer(): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/logout`, {});
  }

  /** Ends every sign-in of this user, on every device. */
  signOutEverywhere(): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/logout-all`, {});
  }

  logout(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('marketech_session');
      localStorage.removeItem('tradesage_user');
      localStorage.removeItem('tradesage_workspace');
    }
  }

  // 2. Dashboard
  getDashboardSummary(): Observable<any> {
    return this.http.get(`${this.baseUrl}/dashboard/summary`, { headers: this.getHeaders() });
  }

  // 3. AI Assistant & Chat
  sendChatMessage(agentKey: string, message: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/assistant/chat`, { agentKey, message }, { headers: this.getHeaders() });
  }

  getAgents(): Observable<any> {
    return this.http.get(`${this.baseUrl}/agents`, { headers: this.getHeaders() });
  }

  // 4. Tasks
  getTasks(): Observable<any> {
    return this.http.get(`${this.baseUrl}/tasks`, { headers: this.getHeaders() });
  }

  // 5. Marketing & Content
  getCampaigns(): Observable<any> {
    return this.http.get(`${this.baseUrl}/marketing/campaigns`, { headers: this.getHeaders() });
  }

  createCampaign(campaignData: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/marketing/campaigns`, campaignData, { headers: this.getHeaders() });
  }

  generatePost(campaignId: number | null, productId: number | null, customTopic = ''): Observable<any> {
    return this.http.post(`${this.baseUrl}/marketing/generate-post`, { campaignId, productId, customTopic }, { headers: this.getHeaders() });
  }

  // 6. Video Studio
  getVideoJobs(): Observable<any> {
    return this.http.get(`${this.baseUrl}/videos`, { headers: this.getHeaders() });
  }

  createVideoJob(productKey: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/videos/create`, { productKey }, { headers: this.getHeaders() });
  }

  // 7. Telephony & Voice
  getTelnyxConfig(): Observable<any> {
    return this.http.get(`${this.baseUrl}/telnyx/config`, { headers: this.getHeaders() });
  }

  simulateCall(speech: string, callerPhone: string, callerName: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/telnyx/simulate`, { speech, callerPhone, callerName }, { headers: this.getHeaders() });
  }

  getCallRecords(): Observable<any> {
    return this.http.get(`${this.baseUrl}/telnyx/call-records`, { headers: this.getHeaders() });
  }

  // 8. Business Profile & CRM
  getBusinessProfile(): Observable<any> {
    return this.http.get(`${this.baseUrl}/business-profile`, { headers: this.getHeaders() });
  }

  updateBusinessProfile(data: any): Observable<any> {
    return this.http.put(`${this.baseUrl}/business-profile`, data, { headers: this.getHeaders() });
  }

  // Leads CRM (workspace-scoped; the server derives the workspace from the session)
  getLeads(params: Record<string, any> = {}): Observable<any> {
    return this.http.get(`${this.baseUrl}/leads`, { params });
  }

  /** Every lead matching the filters (no paging), for export. */
  exportLeads(params: Record<string, any> = {}): Observable<any> {
    return this.http.get(`${this.baseUrl}/leads/export`, { params });
  }

  getLeadProducts(): Observable<any> {
    return this.http.get(`${this.baseUrl}/leads/products`);
  }

  createLead(data: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads`, data);
  }

  updateLead(id: number, data: any): Observable<any> {
    return this.http.patch(`${this.baseUrl}/leads/${id}`, data);
  }

  deleteLead(id: number): Observable<any> {
    return this.http.delete(`${this.baseUrl}/leads/${id}`);
  }

  getLeadEmailDraft(id: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/${id}/email-draft`, {});
  }

  // 9. Billing & Usage
  getPlans(): Observable<any> {
    return this.http.get(`${this.baseUrl}/billing/plans`, { headers: this.getHeaders() });
  }

  getSubscription(): Observable<any> {
    return this.http.get(`${this.baseUrl}/billing/subscription`, { headers: this.getHeaders() });
  }

  changePlan(planKey: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/billing/change-plan`, { planKey }, { headers: this.getHeaders() });
  }

  getUsageSummary(): Observable<any> {
    return this.http.get(`${this.baseUrl}/usage/summary`, { headers: this.getHeaders() });
  }

  // 10. Voice & ElevenLabs
  /** Voice agent readiness (key, agent, remaining ElevenLabs credits). Never starts a call. */
  getVoiceStatus(): Observable<any> {
    return this.http.get(`${this.baseUrl}/voice/status`, { headers: this.getHeaders() });
  }

  getVoiceSignedUrl(): Observable<any> {
    return this.http.get(`${this.baseUrl}/voice/signed-url`, { headers: this.getHeaders() });
  }

  // 11. B2B Clients & Inquiries (CRM)
  getB2bClients(): Observable<any> {
    return this.http.get(`${this.baseUrl}/b2b/clients`, { headers: this.getHeaders() });
  }

  createB2bClient(data: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/b2b/clients`, data, { headers: this.getHeaders() });
  }

  // 12. Email Campaigns & Outreach
  getB2bCampaigns(): Observable<any> {
    return this.http.get(`${this.baseUrl}/b2b/campaigns`, { headers: this.getHeaders() });
  }

  createB2bCampaign(data: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/b2b/campaigns`, data, { headers: this.getHeaders() });
  }

  sendB2bCampaignEmail(campaignId: number, clientId: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/b2b/campaigns/send`, { campaignId, clientId }, { headers: this.getHeaders() });
  }

  // 13. Client Replies Feed
  getB2bReplies(): Observable<any> {
    return this.http.get(`${this.baseUrl}/b2b/replies`, { headers: this.getHeaders() });
  }

  // 14. Simplified B2B Statistics & Executive Briefing
  getB2bStatistics(): Observable<any> {
    return this.http.get(`${this.baseUrl}/b2b/statistics`, { headers: this.getHeaders() });
  }

  getExecutiveBriefing(): Observable<any> {
    return this.http.get(`${this.baseUrl}/executive/briefing`, { headers: this.getHeaders() });
  }

  // 15. Marketing & Growth Ideas Generator
  getB2bIdeas(productKey: string = 'traivo'): Observable<any> {
    return this.http.get(`${this.baseUrl}/b2b/ideas?productKey=${productKey}`, { headers: this.getHeaders() });
  }

  // 16. Traivo MySQL Live Integration
  getTraivoIntegration(): Observable<any> {
    return this.http.get(`${this.baseUrl}/integrations/traivo`, { headers: this.getHeaders() });
  }

  // 17. Connected Businesses (My Business + Client Businesses)
  getConnectedBusinesses(): Observable<any> {
    return this.http.get(`${this.root}/api/businesses/connected`);
  }

  connectBusiness(data: any): Observable<any> {
    return this.http.post(`${this.root}/api/businesses/connected`, data);
  }

  generateMarketingIdeas(data: { businessId: number; productId?: number | null; goal?: string }): Observable<any> {
    return this.http.post(`${this.root}/api/marketing/generate-ideas`, data);
  }

  /** Creates Mail Drafts for the selected leads; it never sends. */
  dispatchCampaign(data: { businessId?: number; productId?: number | null; subject: string; body: string; leadIds: number[] }): Observable<any> {
    return this.http.post(`${this.root}/api/marketing/dispatch-campaign`, data);
  }

  // 18. Email Command Center (Inbox & Send Mail)
  getEmails(): Observable<any> {
    return this.http.get(`${this.root}/api/emails`);
  }

  // Sending requires the user's explicit confirmation; callers pass it after a confirm dialog.
  // idempotencyKey: one per compose action, reused if the same send is retried (never sends twice).
  sendEmail(data: { recipient_email: string; recipient_name?: string; subject: string; body: string; purpose?: 'transactional' | 'marketing' | null; templateId?: number | null }, confirm: boolean, idempotencyKey: string): Observable<any> {
    return this.http.post(`${this.root}/api/emails/send`, { ...data, confirm }, { headers: { 'Idempotency-Key': idempotencyKey } });
  }

  // 19. Appointments & CRM
  getAppointments(): Observable<any> {
    return this.http.get(`${this.root}/api/appointments`);
  }

  bookAppointment(data: { customer_name: string; service?: string; date: string; time: string; notes?: string }): Observable<any> {
    return this.http.post(`${this.root}/api/appointments`, data);
  }

  trackLead(data: any): Observable<any> {
    return this.createLead(data);
  }

  // 21. Digital Products Hub & AI URL Extractor
  extractProductFromUrl(url: string): Observable<any> {
    return this.http.post(`${this.root}/api/products/extract-url`, { url });
  }

  getDigitalProducts(): Observable<any> {
    return this.http.get(`${this.root}/api/products`);
  }

  createDigitalProduct(data: any): Observable<any> {
    return this.http.post(`${this.root}/api/products`, data);
  }

  deleteDigitalProduct(id: number): Observable<any> {
    return this.http.delete(`${this.root}/api/products/${id}`);
  }

  // Live Google Places details for a lead found by AI Lead Discovery (fetched, never stored)
  getLeadPlaceDetails(leadId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/leads/discovery/leads/${leadId}/place`);
  }

  // 22. Bulk Lead Import & AI Qualification
  importLeadsBulk(leads: any[], extras: { consent?: any; zohoList?: any } = {}): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/import-bulk`, { leads, ...extras });
  }

  qualifyLeadWithAi(leadId: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/${leadId}/ai-qualify`, {});
  }

  qualifyAllLeadsWithAi(productId?: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/ai-qualify-all`, productId ? { productId } : {});
  }

  // 23. Visual HTML Email & Email AI Analysis
  sendHtmlEmail(data: { recipient_email: string; recipient_name?: string; subject: string; html_body: string; body_text?: string; purpose?: 'transactional' | 'marketing' | null; templateId?: number | null }, confirm: boolean, idempotencyKey: string): Observable<any> {
    return this.http.post(`${this.root}/api/emails/send-html`, { ...data, confirm }, { headers: { 'Idempotency-Key': idempotencyKey } });
  }

  saveEmailAsTemplate(data: { name: string; html: string; category?: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/mail/templates`, { ...data, source: 'email' });
  }

  /** After checking the recipient's mailbox: was a send with an unknown outcome delivered? */
  resolveMailDraft(id: number, outcome: 'sent' | 'not_sent'): Observable<any> {
    return this.http.post(`${this.root}/api/drafts/${id}/resolve`, { outcome, confirm: true });
  }

  analyzeEmailWithAi(emailId: number): Observable<any> {
    return this.http.post(`${this.root}/api/emails/${emailId}/ai-analyze`, {});
  }

  // 24. Mail Drafts & Approvals Workflow
  getMailDrafts(): Observable<any> {
    return this.http.get(`${this.root}/api/drafts`);
  }

  // templateId: start from a saved template (its HTML is copied into the draft).
  // leadId: the recipient is that lead (name and email are read from the lead on the server).
  generateMailDraft(data: { productId?: number; recipientName?: string; recipientEmail?: string; goal?: string; tone?: string; templateId?: number | null; leadId?: number }): Observable<any> {
    return this.http.post(`${this.root}/api/drafts/generate`, data);
  }

  /** Whether this workspace can send marketing email (an SMTP mailbox approved for marketing). */
  getMarketingDelivery(): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/marketing`);
  }

  /** Owner/Admin: approve (or withdraw) this workspace's SMTP mailbox for marketing email. */
  setMarketingApproval(approved: boolean, note?: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/mail/marketing`, { approved, confirm: true, ...(note ? { note } : {}) });
  }

  /** Compose send report (Owners/Admins): purpose records, masked recipients, no content. */
  getComposeReport(params: { from?: string; to?: string; purpose?: string; page?: number }): Observable<any> {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p[k] = String(v);
    return this.http.get(`${this.baseUrl}/mail/compose-report`, { params: p });
  }

  // ---------- Mail Center: Inbox and Sent Mail ----------
  getInbox(params: { q?: string; read?: string; from?: string; to?: string; page?: number } = {}): Observable<any> {
    return this.http.get(`${this.baseUrl}/emails/inbox`, { params: this.queryParams(params) });
  }

  getSentMail(params: { q?: string; status?: string; purpose?: string; from?: string; to?: string; page?: number; sentOnly?: '1' } = {}): Observable<any> {
    return this.http.get(`${this.baseUrl}/emails/sent`, { params: this.queryParams(params) });
  }

  getEmail(id: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/emails/${id}`);
  }

  setEmailRead(id: number, read: boolean): Observable<any> {
    return this.http.put(`${this.baseUrl}/emails/${id}/read`, { read });
  }

  private queryParams(params: Record<string, any>): Record<string, string> {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p[k] = String(v);
    return p;
  }

  // ---------- Mail activity: Overview charts and campaign log (read-only) ----------
  getMailActivitySummary(days: 7 | 30 | 90 = 30): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/activity/summary`, { params: { days: String(days) } });
  }

  getCampaignLog(params: { type?: string; from?: string; to?: string; page?: number } = {}): Observable<any> {
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p[k] = String(v);
    return this.http.get(`${this.baseUrl}/mail/activity/campaigns`, { params: p });
  }

  // ---------- Email tracking (delivery, opens, clicks) ----------
  getMailTrackingSettings(): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/tracking/settings`);
  }

  updateMailTrackingSettings(body: { trackOpens: boolean; trackClicks: boolean }): Observable<any> {
    return this.http.put(`${this.baseUrl}/mail/tracking/settings`, body);
  }

  updateZeptoWebhook(body: { authKey?: string; enabled?: boolean; rotateUrl?: boolean }): Observable<any> {
    return this.http.put(`${this.baseUrl}/mail/tracking/zeptomail-webhook`, body);
  }

  getEmailTracking(emailId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/tracking/emails/${emailId}`);
  }

  getDraftTracking(draftId: number): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/tracking/drafts/${draftId}`);
  }

  getCampaignRecipients(campaignId: number, activity: string, page = 1): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/campaigns/${campaignId}/recipients`, { params: { activity, page: String(page) } });
  }

  rewriteMailDraft(id: number, instruction: string): Observable<any> {
    return this.http.post(`${this.root}/api/drafts/${id}/rewrite`, { instruction });
  }

  approveMailDraft(id: number): Observable<any> {
    return this.http.put(`${this.root}/api/drafts/${id}/approve`, {});
  }

  sendMailDraft(id: number, confirm: boolean): Observable<any> {
    return this.http.post(`${this.root}/api/drafts/${id}/send`, { confirm });
  }

  updateMailDraft(id: number, data: { recipient_email?: string; recipient_name?: string; subject?: string; body_html?: string; replacements?: Record<string, string> }): Observable<any> {
    return this.http.patch(`${this.root}/api/drafts/${id}`, data);
  }

  deleteMailDraft(id: number): Observable<any> {
    return this.http.delete(`${this.root}/api/drafts/${id}`);
  }

  // 26. Company Mail Authorization (SMTP & IMAP)
  // Zoho Campaigns API client entered in Settings (the secret is sent, never returned)
  getZohoApp(): Observable<any> {
    return this.http.get(`${this.baseUrl}/mail/zoho/app`);
  }

  saveZohoApp(body: { clientId: string; clientSecret?: string }): Observable<any> {
    return this.http.put(`${this.baseUrl}/mail/zoho/app`, body);
  }

  removeZohoApp(): Observable<any> {
    return this.http.delete(`${this.baseUrl}/mail/zoho/app`);
  }

  getMailConfig(): Observable<any> {
    return this.http.get(`${this.root}/api/mail/config`);
  }

  saveMailConfig(config: any): Observable<any> {
    return this.http.post(`${this.root}/api/mail/config`, config);
  }

  testSmtp(config?: any): Observable<any> {
    return this.http.post(`${this.root}/api/mail/test-smtp`, { config });
  }

  syncCompanyMail(): Observable<any> {
    return this.http.post(`${this.root}/api/mail/sync`, {});
  }

  getStatus(): Observable<any> {
    return this.http.get(`${this.root}/api/status`);
  }
}

