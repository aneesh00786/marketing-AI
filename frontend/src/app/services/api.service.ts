import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private baseUrl = 'http://localhost:8000/api/v1';

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

  getContent(status: string = 'all'): Observable<any> {
    return this.http.get(`${this.baseUrl}/content?status=${status}`, { headers: this.getHeaders() });
  }

  generatePost(campaignId: number, productKey: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/marketing/generate-post`, { campaignId, productKey }, { headers: this.getHeaders() });
  }

  updateContentStatus(id: number, status: string): Observable<any> {
    return this.http.post(`${this.baseUrl}/content/${id}/status`, { status }, { headers: this.getHeaders() });
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

  getLeads(): Observable<any> {
    return this.http.get(`${this.baseUrl}/leads`, { headers: this.getHeaders() });
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
    return this.http.get('http://localhost:8000/api/businesses/connected');
  }

  connectBusiness(data: any): Observable<any> {
    return this.http.post('http://localhost:8000/api/businesses/connected', data);
  }

  generateMarketingIdeas(businessId?: number, businessName?: string): Observable<any> {
    return this.http.post('http://localhost:8000/api/marketing/generate-ideas', { businessId, businessName });
  }

  dispatchCampaign(data: { businessId?: number; subject: string; body: string; leadIds?: number[] }): Observable<any> {
    return this.http.post('http://localhost:8000/api/marketing/dispatch-campaign', data);
  }

  // 18. Email Command Center (Inbox & Send Mail)
  getEmails(): Observable<any> {
    return this.http.get('http://localhost:8000/api/emails');
  }

  sendEmail(data: { recipient_email: string; recipient_name?: string; subject: string; body: string }): Observable<any> {
    return this.http.post('http://localhost:8000/api/emails/send', data);
  }

  // 19. Appointments & CRM
  getAppointments(): Observable<any> {
    return this.http.get('http://localhost:8000/api/appointments');
  }

  bookAppointment(data: { customer_name: string; service?: string; date: string; time: string; notes?: string }): Observable<any> {
    return this.http.post('http://localhost:8000/api/appointments', data);
  }

  trackLead(data: { name: string; phone?: string; email?: string; interest?: string; company_name?: string; estimated_budget?: string }): Observable<any> {
    return this.http.post('http://localhost:8000/api/leads', data);
  }

  // 20. Desktop Tools & System Controls (Python Parity)
  launchApp(appName: string): Observable<any> {
    return this.http.post('http://localhost:8000/api/tools/launch_app', { app_name: appName });
  }

  systemControl(action: string): Observable<any> {
    return this.http.post('http://localhost:8000/api/tools/system_control', { action });
  }

  getSystemStats(): Observable<any> {
    return this.http.get('http://localhost:8000/api/tools/system_stats');
  }

  // 21. Digital Products Hub & AI URL Extractor
  extractProductFromUrl(url: string): Observable<any> {
    return this.http.post('http://localhost:8000/api/products/extract-url', { url });
  }

  getDigitalProducts(): Observable<any> {
    return this.http.get('http://localhost:8000/api/products');
  }

  createDigitalProduct(data: any): Observable<any> {
    return this.http.post('http://localhost:8000/api/products', data);
  }

  deleteDigitalProduct(id: number): Observable<any> {
    return this.http.delete(`http://localhost:8000/api/products/${id}`);
  }

  // 22. Bulk Lead Import & AI Qualification
  importLeadsBulk(leads: any[]): Observable<any> {
    return this.http.post('http://localhost:8000/api/leads/import-bulk', { leads });
  }

  qualifyLeadWithAi(leadId: number): Observable<any> {
    return this.http.post(`http://localhost:8000/api/leads/${leadId}/ai-qualify`, {});
  }

  qualifyAllLeadsWithAi(): Observable<any> {
    return this.http.post('http://localhost:8000/api/leads/ai-qualify-all', {});
  }

  // 23. Visual HTML Email & Email AI Analysis
  sendHtmlEmail(data: { recipient_email: string; recipient_name?: string; subject: string; html_body: string; body_text?: string }): Observable<any> {
    return this.http.post('http://localhost:8000/api/emails/send-html', data);
  }

  analyzeEmailWithAi(emailId: number): Observable<any> {
    return this.http.post(`http://localhost:8000/api/emails/${emailId}/ai-analyze`, {});
  }

  // 24. Mail Drafts & Approvals Workflow
  getMailDrafts(): Observable<any> {
    return this.http.get('http://localhost:8000/api/drafts');
  }

  generateMailDraft(data: { productId?: number; recipientName?: string; recipientEmail?: string; goal?: string; tone?: string }): Observable<any> {
    return this.http.post('http://localhost:8000/api/drafts/generate', data);
  }

  rewriteMailDraft(id: number, instruction: string): Observable<any> {
    return this.http.post(`http://localhost:8000/api/drafts/${id}/rewrite`, { instruction });
  }

  approveMailDraft(id: number): Observable<any> {
    return this.http.put(`http://localhost:8000/api/drafts/${id}/approve`, {});
  }

  sendMailDraft(id: number): Observable<any> {
    return this.http.post(`http://localhost:8000/api/drafts/${id}/send`, {});
  }

  deleteMailDraft(id: number): Observable<any> {
    return this.http.delete(`http://localhost:8000/api/drafts/${id}`);
  }

  // 25. Social Media Studio
  generateSocialPost(data: { productId?: number; productKey?: string; platform?: string; customTopic?: string; tone?: string; campaignId?: number }): Observable<any> {
    return this.http.post('http://localhost:8000/api/marketing/generate-social-post', data);
  }

  deleteContent(id: number): Observable<any> {
    return this.http.delete(`http://localhost:8000/api/content/${id}`);
  }

  // 26. Company Mail Authorization (SMTP & IMAP)
  getMailConfig(): Observable<any> {
    return this.http.get('http://localhost:8000/api/mail/config');
  }

  saveMailConfig(config: any): Observable<any> {
    return this.http.post('http://localhost:8000/api/mail/config', config);
  }

  testSmtp(config?: any): Observable<any> {
    return this.http.post('http://localhost:8000/api/mail/test-smtp', { config });
  }

  syncCompanyMail(): Observable<any> {
    return this.http.post('http://localhost:8000/api/mail/sync', {});
  }

  getStatus(): Observable<any> {
    return this.http.get('http://localhost:8000/api/status');
  }
}

