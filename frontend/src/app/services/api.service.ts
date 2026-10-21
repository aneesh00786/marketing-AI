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

  private getHeaders(): HttpHeaders {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('tradesage_token') : null;
    let headers = new HttpHeaders();
    if (token) {
      headers = headers.set('Authorization', `Bearer ${token}`);
    }
    return headers;
  }

  // 1. Authentication
  login(credentials: { email: string; password: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/login`, credentials);
  }

  register(data: { email: string; password: string; displayName: string; workspaceName: string; industry: string }): Observable<any> {
    return this.http.post(`${this.baseUrl}/auth/register`, data);
  }

  getMe(): Observable<any> {
    return this.http.get(`${this.baseUrl}/auth/me`, { headers: this.getHeaders() });
  }

  logout(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('tradesage_token');
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
  sendEmail(data: { recipient_email: string; recipient_name?: string; subject: string; body: string }, confirm: boolean): Observable<any> {
    return this.http.post(`${this.root}/api/emails/send`, { ...data, confirm });
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
  importLeadsBulk(leads: any[]): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/import-bulk`, { leads });
  }

  qualifyLeadWithAi(leadId: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/${leadId}/ai-qualify`, {});
  }

  qualifyAllLeadsWithAi(productId?: number): Observable<any> {
    return this.http.post(`${this.baseUrl}/leads/ai-qualify-all`, productId ? { productId } : {});
  }

  // 23. Visual HTML Email & Email AI Analysis
  sendHtmlEmail(data: { recipient_email: string; recipient_name?: string; subject: string; html_body: string; body_text?: string }, confirm: boolean): Observable<any> {
    return this.http.post(`${this.root}/api/emails/send-html`, { ...data, confirm });
  }

  analyzeEmailWithAi(emailId: number): Observable<any> {
    return this.http.post(`${this.root}/api/emails/${emailId}/ai-analyze`, {});
  }

  // 24. Mail Drafts & Approvals Workflow
  getMailDrafts(): Observable<any> {
    return this.http.get(`${this.root}/api/drafts`);
  }

  generateMailDraft(data: { productId?: number; recipientName?: string; recipientEmail?: string; goal?: string; tone?: string }): Observable<any> {
    return this.http.post(`${this.root}/api/drafts/generate`, data);
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

  updateMailDraft(id: number, data: { recipient_email?: string; recipient_name?: string; subject?: string }): Observable<any> {
    return this.http.patch(`${this.root}/api/drafts/${id}`, data);
  }

  deleteMailDraft(id: number): Observable<any> {
    return this.http.delete(`${this.root}/api/drafts/${id}`);
  }

  // 26. Company Mail Authorization (SMTP & IMAP)
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

