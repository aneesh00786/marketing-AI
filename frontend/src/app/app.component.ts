import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import * as XLSX from 'xlsx';
import { ApiService } from './services/api.service';
import { SpeechService } from './services/speech.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit, OnDestroy {
  // Navigation: Directly accessible HUD
  currentRoute: 'products' | 'leads' | 'emails' | 'drafts' | 'businesses' | 'social' | 'voice' | 'appointments' = 'products';

  // Social Media Studio State
  socialPosts: any[] = [];
  selectedSocialPlatform: 'LinkedIn' | 'Twitter' | 'Instagram' | 'Facebook' = 'LinkedIn';
  selectedSocialProductId: number | null = null;
  socialCustomTopic: string = '';
  socialTone: string = 'High-Converting B2B';
  isGeneratingSocialPost: boolean = false;
  socialStatusFilter: string = 'all';

  // Company Mail Authorization State (SMTP & IMAP)
  showMailConfigModal: boolean = false;
  mailConfig: any = {
    provider: 'custom_smtp',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: '',
    smtp_pass: '',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_tls: true,
    imap_user: '',
    imap_pass: '',
    sender_name: 'Roger Executive Team',
    sender_email: '',
    status: 'Not Configured',
    has_smtp_auth: false,
    has_imap_auth: false
  };
  isSavingMailConfig: boolean = false;
  isTestingSmtp: boolean = false;
  isSyncingMail: boolean = false;
  smtpTestResult: { success?: boolean; message?: string; error?: string } | null = null;

  // Voice Dictation into Quick Chat input
  isListeningQuickChat: boolean = false;

  // Server Status & Mobile LAN
  serverStatus: any = {
    status: 'online',
    agent_name: 'ROGER // Executive AI Voice & Marketing OS',
    voice_engine: 'ElevenLabs Conversational AI',
    lan_ip: '127.0.0.1',
    mobile_url: 'http://localhost:8000'
  };

  // Voice HUD State (ElevenLabs Full-Duplex Real-Time)
  isElevenLabsConnected: boolean = false;
  elevenLabsMode: 'listening' | 'speaking' = 'listening';
  callStatusText: string = 'SAY "HELLO ROGER" OR TAP ORB';
  callSubText: string = 'Speak naturally to converse with Roger in real time';
  callTimer: string = '00:00';
  private timerInterval: any = null;
  private callSeconds: number = 0;

  dialogueTranscript: Array<{ sender: string; text: string; role: 'user' | 'agent'; time?: string }> = [
    {
      sender: 'ROGER',
      text: 'Standing by, sir. Tap the orb or speak in English. I can extract features for your digital products, score leads, draft approved HTML emails, and execute marketing campaigns for ThriveWoo or any connected client.',
      role: 'agent',
      time: 'Ready'
    }
  ];

  // Quick Chat Input Box
  quickTextInput: string = '';
  isProcessingChat: boolean = false;

  // 1. Digital Products Hub (ThriveWoo Flagship & URL Extractor)
  digitalProducts: any[] = [];
  selectedProduct: any = null;
  productUrlInput: string = 'https://thrivewoo.com';
  isExtractingUrl: boolean = false;
  extractedProductPreview: any = null;
  showNewProductModal: boolean = false;
  newProduct = {
    name: '',
    url: '',
    tagline: '',
    description: '',
    featuresText: '',
    target_audience: ''
  };

  // 2. Leads CRM & Excel Importer (Lead Getting & AI Scoring)
  leads: any[] = [];
  showNewLeadModal: boolean = false;
  showExcelImportModal: boolean = false;
  excelFileName: string = '';
  excelPreviewRows: any[] = [];
  isImportingLeads: boolean = false;
  isQualifyingAll: boolean = false;
  newLead = {
    name: '',
    phone: '',
    email: '',
    interest: 'ThriveWoo B2B Platform',
    company_name: '',
    estimated_budget: '$15,000',
    notes: ''
  };

  // 3. Email Command Center (Visual HTML Rendering & AI Summaries)
  emails: any[] = [];
  showComposeModal: boolean = false;
  composeTab: 'visual' | 'code' = 'visual';
  viewingEmailVisual: any = null;
  isAnalyzingEmail: boolean = false;
  composeEmail = {
    recipient_email: '',
    recipient_name: '',
    subject: '',
    body: '',
    html_body: '',
    is_html: true
  };

  // 4. Mail Drafts & Approvals Workflow (Human-in-the-loop)
  drafts: any[] = [];
  selectedDraft: any = null;
  isGeneratingDraft: boolean = false;
  isRewritingDraft: boolean = false;
  newDraftForm = {
    productId: null as any,
    recipientName: '',
    recipientEmail: '',
    goal: 'Automate wholesale ordering, van sales mobile app, and tiered wholesale pricing',
    tone: 'Professional'
  };

  // 5. Connected Businesses & Dynamic Marketing Playbooks
  connectedBusinesses: any[] = [];
  selectedBusiness: any = null;
  generatedIdeas: any[] = [];
  isGeneratingIdeas: boolean = false;
  showNewBusinessModal: boolean = false;
  newBusiness = {
    name: '',
    industry: '',
    website: '',
    description: '',
    productsText: '',
    target_audience: '',
    business_type: 'client'
  };

  // 6. Appointments & Demos
  appointments: any[] = [];
  showBookingModal: boolean = false;
  newBooking = {
    customer_name: '',
    service: 'ThriveWoo B2B Wholesale Platform Demo',
    date: '2026-10-24',
    time: '02:00 PM',
    notes: 'Walkthrough of mobile field sales order booking, wholesale tiers, and live inventory sync.'
  };

  // Executive Briefing Cache & Toast
  executiveBriefing: any = null;
  toastMessage: string = '';
  private toastTimeout: any = null;

  constructor(
    public apiService: ApiService,
    public speechService: SpeechService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit(): void {
    this.loadStatus();
    this.loadDigitalProducts();
    this.loadLeads();
    this.loadEmails();
    this.loadDrafts();
    this.loadSocialPosts();
    this.loadMailConfig();
    this.loadConnectedBusinesses();
    this.loadAppointments();
  }

  ngOnDestroy(): void {
    this.stopCallTimer();
    this.speechService.stopElevenLabsSession();
  }

  showToast(msg: string): void {
    this.toastMessage = msg;
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => this.toastMessage = '', 4000);
  }

  getSafeHtml(html: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(html || '');
  }

  // ==========================================
  // 1. STATUS & ELEVENLABS REAL-TIME VOICE
  // ==========================================
  loadStatus(): void {
    this.apiService.getStatus().subscribe({
      next: (res) => {
        if (res) this.serverStatus = res;
      },
      error: () => console.warn('Status endpoint unavailable')
    });
  }

  async toggleElevenLabsCall(): Promise<void> {
    if (this.isElevenLabsConnected) {
      await this.disconnectElevenLabs();
    } else {
      await this.connectElevenLabs();
    }
  }

  async connectElevenLabs(): Promise<void> {
    try {
      this.callStatusText = 'CONNECTING TO ELEVENLABS...';
      const res: any = await this.apiService.getVoiceSignedUrl().toPromise();
      if (!res?.signed_url) throw new Error('Signed URL was not generated.');

      await this.speechService.startElevenLabsSession(res.signed_url, {
        onConnect: () => {
          this.isElevenLabsConnected = true;
          this.callStatusText = 'CONVERSATION ACTIVE (SPEAK IN ENGLISH)';
          this.callSubText = '🎙️ Real-time full-duplex voice active. Speak naturally.';
          this.startCallTimer();
          this.showToast('Connected to Roger (ElevenLabs Conversational AI)');
        },
        onDisconnect: () => this.disconnectElevenLabs(),
        onError: (err) => {
          console.warn('ElevenLabs Error:', err);
          this.callStatusText = 'VOICE SESSION ERROR';
        },
        onMessage: (msg) => {
          this.dialogueTranscript.unshift({
            sender: msg.role === 'agent' ? 'ROGER' : 'YOU',
            text: msg.text,
            role: msg.role === 'agent' ? 'agent' : 'user',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
        },
        onModeChange: (mode) => {
          this.elevenLabsMode = mode;
        }
      });
    } catch (err: any) {
      console.error('Failed to connect ElevenLabs:', err);
      this.callStatusText = 'STANDBY (CLICK TO CONNECT)';
      this.callSubText = `Connection error: ${err.message || 'Check ElevenLabs key'}`;
      this.showToast('Could not connect to ElevenLabs voice session.');
    }
  }

  async disconnectElevenLabs(): Promise<void> {
    await this.speechService.stopElevenLabsSession();
    this.isElevenLabsConnected = false;
    this.stopCallTimer();
    this.callStatusText = 'SAY "HELLO ROGER" OR TAP ORB';
    this.callSubText = 'Speak naturally to converse with Roger in real time';
    this.showToast('Roger voice session disconnected.');
  }

  private startCallTimer(): void {
    this.callSeconds = 0;
    this.callTimer = '00:00';
    if (this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.callSeconds++;
      const mins = Math.floor(this.callSeconds / 60).toString().padStart(2, '0');
      const secs = (this.callSeconds % 60).toString().padStart(2, '0');
      this.callTimer = `${mins}:${secs}`;
    }, 1000);
  }

  private stopCallTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.callTimer = '00:00';
    this.callSeconds = 0;
  }

  sendQuickText(): void {
    const text = this.quickTextInput.trim();
    if (!text) return;

    this.dialogueTranscript.unshift({
      sender: 'YOU',
      text,
      role: 'user',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    this.quickTextInput = '';
    this.isProcessingChat = true;

    this.apiService.sendChatMessage('executive_assistant', text).subscribe({
      next: (res) => {
        this.isProcessingChat = false;
        this.dialogueTranscript.unshift({
          sender: 'ROGER',
          text: res.reply || 'Acknowledged, sir.',
          role: 'agent',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        this.loadEmails();
        this.loadLeads();
        this.loadDrafts();
        this.loadSocialPosts();
      },
      error: (err) => {
        this.isProcessingChat = false;
        this.dialogueTranscript.unshift({
          sender: 'ROGER',
          text: `Apologies sir, error processing request: ${err.message}`,
          role: 'agent',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }
    });
  }

  toggleVoiceDictation(): void {
    if (this.isListeningQuickChat) {
      this.speechService.stopListening();
      this.isListeningQuickChat = false;
    } else {
      const started = this.speechService.startListening(
        (transcript) => {
          this.quickTextInput = transcript;
          this.isListeningQuickChat = false;
          this.sendQuickText();
        },
        (interim) => {
          this.quickTextInput = interim;
        },
        (err) => {
          console.warn('Voice dictation event:', err);
          this.isListeningQuickChat = false;
        }
      );
      if (started) {
        this.isListeningQuickChat = true;
        this.showToast('🎙️ Listening... Speak your command in English');
      } else {
        this.showToast('Microphone not supported in this browser. Please type.');
      }
    }
  }

  sendPresetPrompt(promptText: string): void {
    this.quickTextInput = promptText;
    this.sendQuickText();
  }

  // ==========================================
  // 2. DIGITAL PRODUCTS HUB & AI URL EXTRACTOR
  // ==========================================
  loadDigitalProducts(): void {
    this.apiService.getDigitalProducts().subscribe({
      next: (res) => {
        this.digitalProducts = res.products || [];
        if (this.digitalProducts.length > 0 && !this.selectedProduct) {
          this.selectedProduct = this.digitalProducts[0];
          this.newDraftForm.productId = this.selectedProduct.id;
        }
      },
      error: (err) => console.warn('Error loading digital products:', err)
    });
  }

  extractFeaturesFromUrl(): void {
    const url = (this.productUrlInput || '').trim();
    if (!url) {
      this.showToast('Please enter a product website URL (e.g. https://thrivewoo.com)');
      return;
    }
    this.isExtractingUrl = true;
    this.extractedProductPreview = null;

    this.apiService.extractProductFromUrl(url).subscribe({
      next: (res) => {
        this.isExtractingUrl = false;
        this.extractedProductPreview = res.product;
        this.showToast(`Extracted ${res.product?.features?.length || 0} features from ${url}!`);
      },
      error: (err) => {
        this.isExtractingUrl = false;
        this.showToast(`Extraction error: ${err.message}`);
      }
    });
  }

  saveExtractedProduct(): void {
    if (!this.extractedProductPreview) return;
    this.apiService.createDigitalProduct(this.extractedProductPreview).subscribe({
      next: (res) => {
        this.showToast(res.message || 'Digital product saved to your Hub!');
        this.extractedProductPreview = null;
        this.loadDigitalProducts();
      },
      error: (err) => this.showToast(`Error saving product: ${err.message}`)
    });
  }

  submitNewProduct(): void {
    if (!this.newProduct.name) return;
    const features = this.newProduct.featuresText.split('\n').map(f => f.trim()).filter(f => f);

    this.apiService.createDigitalProduct({
      name: this.newProduct.name,
      url: this.newProduct.url,
      tagline: this.newProduct.tagline,
      description: this.newProduct.description,
      target_audience: this.newProduct.target_audience,
      features,
      pricing: []
    }).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showNewProductModal = false;
        this.newProduct = { name: '', url: '', tagline: '', description: '', featuresText: '', target_audience: '' };
        this.loadDigitalProducts();
      },
      error: (err) => this.showToast(`Error adding product: ${err.message}`)
    });
  }

  deleteDigitalProduct(id: number): void {
    if (!confirm('Are you sure you want to remove this digital product?')) return;
    this.apiService.deleteDigitalProduct(id).subscribe({
      next: () => {
        this.showToast('Digital product removed');
        this.loadDigitalProducts();
      },
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  askRogerAboutProduct(prod: any): void {
    const prodName = prod?.name || 'ThriveWoo';
    this.currentRoute = 'voice';
    this.quickTextInput = `Can you see the details and features of ${prodName}?`;
    this.sendQuickText();
  }

  // ==========================================
  // 3. LEADS CRM & EXCEL / CSV IMPORTER
  // ==========================================
  loadLeads(): void {
    this.apiService.getLeads().subscribe({
      next: (res) => {
        this.leads = res.leads || [];
      },
      error: (err) => console.warn('Error loading leads:', err)
    });
  }

  onExcelFileSelected(event: any): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    this.excelFileName = file.name;

    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const bstr = e.target.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const firstSheetName = wb.SheetNames[0];
        const ws = wb.Sheets[firstSheetName];
        const rawJson: any[] = XLSX.utils.sheet_to_json(ws);

        this.excelPreviewRows = rawJson.map((row: any) => ({
          name: row['Name'] || row['name'] || row['Contact Name'] || row['Full Name'] || 'Prospect',
          company: row['Company'] || row['company'] || row['Company Name'] || 'Enterprise',
          email: row['Email'] || row['email'] || '',
          phone: row['Phone'] || row['phone'] || '',
          interest: row['Interest'] || row['interest'] || row['Product'] || 'ThriveWoo B2B Platform',
          budget: row['Budget'] || row['budget'] || '$15,000',
          notes: row['Notes'] || row['notes'] || ''
        }));

        this.showToast(`Parsed ${this.excelPreviewRows.length} leads from "${file.name}". Ready to import!`);
      } catch (err: any) {
        this.showToast(`Error reading spreadsheet: ${err.message}`);
      }
    };
    reader.readAsBinaryString(file);
  }

  confirmImportExcelLeads(): void {
    if (this.excelPreviewRows.length === 0) return;
    this.isImportingLeads = true;

    this.apiService.importLeadsBulk(this.excelPreviewRows).subscribe({
      next: (res) => {
        this.isImportingLeads = false;
        this.showToast(res.message);
        this.showExcelImportModal = false;
        this.excelFileName = '';
        this.excelPreviewRows = [];
        this.loadLeads();
      },
      error: (err) => {
        this.isImportingLeads = false;
        this.showToast(`Import failed: ${err.message}`);
      }
    });
  }

  qualifySingleLead(lead: any): void {
    this.apiService.qualifyLeadWithAi(lead.id).subscribe({
      next: (res) => {
        this.showToast(`Lead qualified! AI Score: ${res.lead?.ai_score}/100 (${res.lead?.ai_category})`);
        this.loadLeads();
      },
      error: (err) => this.showToast(`Qualify error: ${err.message}`)
    });
  }

  qualifyAllLeads(): void {
    this.isQualifyingAll = true;
    this.apiService.qualifyAllLeadsWithAi().subscribe({
      next: (res) => {
        this.isQualifyingAll = false;
        this.showToast(res.message);
        this.loadLeads();
      },
      error: (err) => {
        this.isQualifyingAll = false;
        this.showToast(`Error: ${err.message}`);
      }
    });
  }

  submitNewLead(): void {
    if (!this.newLead.name) return;
    this.apiService.trackLead(this.newLead).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showNewLeadModal = false;
        this.newLead = { name: '', phone: '', email: '', interest: 'ThriveWoo B2B Platform', company_name: '', estimated_budget: '$15,000', notes: '' };
        this.loadLeads();
      },
      error: (err) => this.showToast(`Error tracking lead: ${err.message}`)
    });
  }

  quickEmailLead(lead: any): void {
    this.composeEmail = {
      recipient_email: lead.email || 'lead@example.com',
      recipient_name: lead.name,
      subject: `Accelerate Wholesale Operations with ThriveWoo B2B`,
      body: `Hi ${lead.name},\n\nThank you for your interest in ThriveWoo. We help WooCommerce merchants automate field sales and customer wholesale pricing.\n\nWould you have 15 minutes this week for a live demonstration?\n\nBest regards,\nExecutive Team`,
      html_body: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 100%); padding: 28px; text-align: center; color: #ffffff;">
    <h1 style="margin: 0; font-size: 22px; font-weight: 700;">ThriveWoo B2B Wholesale Platform</h1>
    <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.95;">Wholesale Ordering & Mobile Field Sales for WooCommerce</p>
  </div>
  <div style="padding: 28px; color: #1e293b; line-height: 1.6;">
    <p style="font-size: 16px; margin-top: 0;">Hi ${lead.name},</p>
    <p style="font-size: 15px; color: #475569;">Managing wholesale orders manually creates costly fulfillment discrepancies.</p>
    <div style="background: #f8fafc; border-left: 4px solid #0ea5e9; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <strong style="color: #0f172a; font-size: 14px;">ThriveWoo Key Capabilities:</strong>
      <ul style="margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: #334155;">
        <li>Mobile field sales order booking app for sales reps</li>
        <li>Customer-tier wholesale pricing & bulk volume matrix</li>
        <li>Multi-warehouse live inventory sync & automated PDF invoice receipts</li>
      </ul>
    </div>
    <div style="text-align: center; margin: 28px 0;">
      <a href="https://thrivewoo.com" style="background: #0ea5e9; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">Schedule 15-Min Live Demo &rarr;</a>
    </div>
    <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">Best regards,<br><strong style="color: #0f172a;">Executive Team</strong><br>ThriveWoo Operations</p>
  </div>
</div>`,
      is_html: true
    };
    this.composeTab = 'visual';
    this.showComposeModal = true;
  }

  // ==========================================
  // 4. EMAIL COMMAND CENTER & VISUAL HTML DISPATCH
  // ==========================================
  loadEmails(): void {
    this.apiService.getEmails().subscribe({
      next: (res) => {
        this.emails = res.emails || [];
      },
      error: (err) => console.warn('Error loading emails:', err)
    });
  }

  onHtmlTemplateUpload(event: any): void {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const reader = new FileReader();
    reader.onload = (e: any) => {
      this.composeEmail.html_body = e.target.result;
      this.composeEmail.is_html = true;
      this.composeTab = 'visual';
      this.showToast(`HTML template loaded from "${file.name}". Rendering visual page layout!`);
    };
    reader.readAsText(file);
  }

  sendOutboundEmail(): void {
    if (!this.composeEmail.recipient_email || !this.composeEmail.subject) {
      this.showToast('Recipient email and subject are required');
      return;
    }

    if (this.composeEmail.is_html && this.composeEmail.html_body) {
      this.apiService.sendHtmlEmail({
        recipient_email: this.composeEmail.recipient_email,
        recipient_name: this.composeEmail.recipient_name,
        subject: this.composeEmail.subject,
        html_body: this.composeEmail.html_body,
        body_text: this.composeEmail.body
      }).subscribe({
        next: (res) => {
          this.showToast(res.message);
          this.showComposeModal = false;
          this.loadEmails();
        },
        error: (err) => this.showToast(`Error sending HTML email: ${err.message}`)
      });
    } else {
      this.apiService.sendEmail(this.composeEmail).subscribe({
        next: (res) => {
          this.showToast(res.message);
          this.showComposeModal = false;
          this.loadEmails();
        },
        error: (err) => this.showToast(`Error sending email: ${err.message}`)
      });
    }
  }

  analyzeEmail(email: any): void {
    this.isAnalyzingEmail = true;
    this.apiService.analyzeEmailWithAi(email.id).subscribe({
      next: (res) => {
        this.isAnalyzingEmail = false;
        this.showToast(`AI Analysis Complete! Priority: ${res.priority}`);
        this.loadEmails();
      },
      error: (err) => {
        this.isAnalyzingEmail = false;
        this.showToast(`Analysis error: ${err.message}`);
      }
    });
  }

  applySmartReply(reply: any, email: any): void {
    const toEmail = email.sender_email || email.recipient_email || 'client@example.com';
    const toName = email.sender || email.recipient_name || 'Client';

    this.composeEmail = {
      recipient_email: toEmail,
      recipient_name: toName,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: reply.text || reply,
      html_body: '',
      is_html: false
    };
    this.composeTab = 'visual';
    this.showComposeModal = true;
  }

  replyToEmail(email: any): void {
    const toEmail = email.sender_email || email.recipient_email || 'client@example.com';
    const toName = email.sender || email.recipient_name || 'Client';

    this.composeEmail = {
      recipient_email: toEmail,
      recipient_name: toName,
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: `Hi ${toName},\n\nThank you for reaching out regarding "${email.subject}". Our team has reviewed your requirements and confirmed we can support your deployment. Would tomorrow at 2:00 PM work for a live demonstration?\n\nBest regards,\nExecutive Team`,
      html_body: '',
      is_html: false
    };
    this.composeTab = 'visual';
    this.showComposeModal = true;
  }

  openVisualEmailModal(email: any): void {
    this.viewingEmailVisual = email;
  }

  // ==========================================
  // 5. MAIL DRAFTS & APPROVALS WORKFLOW
  // ==========================================
  loadDrafts(): void {
    this.apiService.getMailDrafts().subscribe({
      next: (res) => {
        this.drafts = res.drafts || [];
        if (this.drafts.length > 0 && !this.selectedDraft) {
          this.selectedDraft = this.drafts[0];
        }
      },
      error: (err) => console.warn('Error loading drafts:', err)
    });
  }

  generateNewDraft(): void {
    this.isGeneratingDraft = true;
    this.apiService.generateMailDraft(this.newDraftForm).subscribe({
      next: (res) => {
        this.isGeneratingDraft = false;
        this.showToast(res.message);
        this.loadDrafts();
        this.selectedDraft = res.draft;
      },
      error: (err) => {
        this.isGeneratingDraft = false;
        this.showToast(`Error generating draft: ${err.message}`);
      }
    });
  }

  rewriteDraft(draft: any, instruction: string): void {
    this.isRewritingDraft = true;
    this.apiService.rewriteMailDraft(draft.id, instruction).subscribe({
      next: (res) => {
        this.isRewritingDraft = false;
        this.showToast(res.message);
        this.selectedDraft = res.draft;
        this.loadDrafts();
      },
      error: (err) => {
        this.isRewritingDraft = false;
        this.showToast(`Rewrite error: ${err.message}`);
      }
    });
  }

  approveDraft(draft: any): void {
    this.apiService.approveMailDraft(draft.id).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.loadDrafts();
        if (this.selectedDraft?.id === draft.id) {
          this.selectedDraft.status = 'Approved';
        }
      },
      error: (err) => this.showToast(`Approval error: ${err.message}`)
    });
  }

  sendApprovedDraft(draft: any): void {
    if (draft.status !== 'Approved') {
      const confirmApprove = confirm(`Draft is currently in '${draft.status}' status. Do you approve sending this email to ${draft.recipient_email}?`);
      if (!confirmApprove) return;
    }
    this.apiService.sendMailDraft(draft.id).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.loadDrafts();
        this.loadEmails();
        if (this.selectedDraft?.id === draft.id) {
          this.selectedDraft.status = 'Sent';
        }
      },
      error: (err) => this.showToast(`Dispatch error: ${err.message}`)
    });
  }

  deleteDraft(draftId: number): void {
    if (!confirm('Are you sure you want to delete this email draft?')) return;
    this.apiService.deleteMailDraft(draftId).subscribe({
      next: () => {
        this.showToast('Draft deleted');
        this.loadDrafts();
        this.selectedDraft = null;
      },
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  // ==========================================
  // 6. CONNECTED BUSINESSES & DYNAMIC CAMPAIGNS
  // ==========================================
  loadConnectedBusinesses(): void {
    this.apiService.getConnectedBusinesses().subscribe({
      next: (res) => {
        this.connectedBusinesses = res.businesses || [];
        if (this.connectedBusinesses.length > 0 && !this.selectedBusiness) {
          this.selectBusiness(this.connectedBusinesses[0]);
        }
      },
      error: (err) => console.warn('Error loading connected businesses:', err)
    });
  }

  selectBusiness(biz: any): void {
    this.selectedBusiness = biz;
    this.generateIdeasForSelectedBusiness();
  }

  generateIdeasForSelectedBusiness(): void {
    if (!this.selectedBusiness) return;
    this.isGeneratingIdeas = true;
    this.apiService.generateMarketingIdeas(this.selectedBusiness.id, this.selectedBusiness.name).subscribe({
      next: (res) => {
        this.isGeneratingIdeas = false;
        this.generatedIdeas = res.ideas || [];
      },
      error: (err) => {
        this.isGeneratingIdeas = false;
        this.showToast(`Error generating ideas: ${err.message}`);
      }
    });
  }

  dispatchCampaignToLeads(idea: any): void {
    this.apiService.dispatchCampaign({
      businessId: this.selectedBusiness?.id,
      subject: idea.subject || `Exclusive Solution from ${this.selectedBusiness?.name}`,
      body: idea.summary + '\n\n' + idea.conversionTip
    }).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.loadEmails();
      },
      error: (err) => this.showToast(`Error dispatching campaign: ${err.message}`)
    });
  }

  submitNewBusiness(): void {
    if (!this.newBusiness.name || !this.newBusiness.industry) return;
    const products = this.newBusiness.productsText.split('\n').filter(p => p.trim());
    this.apiService.connectBusiness({
      ...this.newBusiness,
      products
    }).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showNewBusinessModal = false;
        this.newBusiness = { name: '', industry: '', website: '', description: '', productsText: '', target_audience: '', business_type: 'client' };
        this.loadConnectedBusinesses();
      },
      error: (err) => this.showToast(`Error connecting business: ${err.message}`)
    });
  }

  // ==========================================
  // 7. APPOINTMENTS
  // ==========================================
  loadAppointments(): void {
    this.apiService.getAppointments().subscribe({
      next: (res) => {
        this.appointments = res.appointments || [];
      },
      error: (err) => console.warn('Error loading appointments:', err)
    });
  }

  submitBooking(): void {
    if (!this.newBooking.customer_name || !this.newBooking.date || !this.newBooking.time) return;
    this.apiService.bookAppointment(this.newBooking).subscribe({
      next: (res) => {
        this.showToast(res.message);
        this.showBookingModal = false;
        this.loadAppointments();
      },
      error: (err) => this.showToast(`Booking error: ${err.message}`)
    });
  }

  // Desktop OS Controls
  triggerLaunchApp(appName: string): void {
    this.apiService.launchApp(appName).subscribe({
      next: (res) => this.showToast(res.message),
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  triggerSystemControl(action: string): void {
    this.apiService.systemControl(action).subscribe({
      next: (res) => this.showToast(res.message),
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  triggerSystemStats(): void {
    this.apiService.getSystemStats().subscribe({
      next: (res) => this.showToast('System statistics retrieved.'),
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  loadExecutiveBriefing(): void {
    this.apiService.getExecutiveBriefing().subscribe({
      next: (res) => {
        this.executiveBriefing = res.briefing;
        this.dialogueTranscript.unshift({
          sender: 'ROGER',
          text: res.briefing?.spokenSummary || 'Executive briefing compiled.',
          role: 'agent',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        this.showToast('Executive briefing delivered.');
      },
      error: (err) => this.showToast(`Error: ${err.message}`)
    });
  }

  // ==========================================
  // 8. SOCIAL MEDIA STUDIO & AI POST GENERATOR
  // ==========================================
  loadSocialPosts(): void {
    this.apiService.getContent(this.socialStatusFilter).subscribe({
      next: (res) => {
        this.socialPosts = res.contentItems || [];
      },
      error: (err) => console.warn('Error loading social posts:', err)
    });
  }

  generateSocialPost(platform?: 'LinkedIn' | 'Twitter' | 'Instagram' | 'Facebook'): void {
    const plat = platform || this.selectedSocialPlatform;
    this.isGeneratingSocialPost = true;
    this.apiService.generateSocialPost({
      productId: this.selectedSocialProductId || (this.selectedProduct ? this.selectedProduct.id : undefined),
      platform: plat,
      customTopic: this.socialCustomTopic,
      tone: this.socialTone
    }).subscribe({
      next: (res) => {
        this.isGeneratingSocialPost = false;
        this.socialCustomTopic = '';
        this.showToast(`AI generated new ${plat} post: "${res.post?.title || 'Post'}"`);
        this.loadSocialPosts();
      },
      error: (err) => {
        this.isGeneratingSocialPost = false;
        this.showToast(`Error generating post: ${err.message}`);
      }
    });
  }

  updateSocialPostStatus(id: number, status: string): void {
    this.apiService.updateContentStatus(id, status).subscribe({
      next: () => {
        this.showToast(`Post status updated to ${status}.`);
        this.loadSocialPosts();
      },
      error: (err) => this.showToast(`Error updating post status: ${err.message}`)
    });
  }

  deleteSocialPost(id: number): void {
    this.apiService.deleteContent(id).subscribe({
      next: () => {
        this.showToast('Post removed.');
        this.loadSocialPosts();
      },
      error: (err) => this.showToast(`Error deleting post: ${err.message}`)
    });
  }

  // ==========================================
  // 9. COMPANY MAIL AUTHORIZATION (SMTP & IMAP)
  // ==========================================
  loadMailConfig(): void {
    this.apiService.getMailConfig().subscribe({
      next: (res) => {
        if (res.config) {
          this.mailConfig = {
            ...this.mailConfig,
            ...res.config,
            smtp_secure: !!res.config.smtp_secure,
            imap_tls: !!res.config.imap_tls
          };
        }
      },
      error: (err) => console.warn('Error loading mail config:', err)
    });
  }

  saveMailConfig(): void {
    this.isSavingMailConfig = true;
    this.apiService.saveMailConfig({
      ...this.mailConfig,
      smtp_secure: this.mailConfig.smtp_secure ? 1 : 0,
      imap_tls: this.mailConfig.imap_tls ? 1 : 0
    }).subscribe({
      next: (res) => {
        this.isSavingMailConfig = false;
        this.mailConfig = {
          ...this.mailConfig,
          ...res.config,
          smtp_secure: !!res.config.smtp_secure,
          imap_tls: !!res.config.imap_tls
        };
        this.showToast('Company mail authorization saved successfully.');
      },
      error: (err) => {
        this.isSavingMailConfig = false;
        this.showToast(`Error saving mail config: ${err.message}`);
      }
    });
  }

  testSmtp(): void {
    this.isTestingSmtp = true;
    this.smtpTestResult = null;
    this.apiService.testSmtp({
      ...this.mailConfig,
      smtp_secure: this.mailConfig.smtp_secure ? 1 : 0
    }).subscribe({
      next: (res) => {
        this.isTestingSmtp = false;
        this.smtpTestResult = res;
        if (res.success) {
          this.showToast('SMTP handshake verified! Company email is ready to send.');
          this.mailConfig.status = 'Connected';
        } else {
          this.showToast(`SMTP test failed: ${res.error}`);
        }
      },
      error: (err) => {
        this.isTestingSmtp = false;
        this.smtpTestResult = { success: false, error: err.message };
        this.showToast(`SMTP connection error: ${err.message}`);
      }
    });
  }

  syncCompanyMail(): void {
    this.isSyncingMail = true;
    this.apiService.syncCompanyMail().subscribe({
      next: (res) => {
        this.isSyncingMail = false;
        if (res.success) {
          this.showToast(res.message || 'Mailbox synchronized successfully.');
          this.loadEmails();
          this.loadMailConfig();
        } else {
          this.showToast(res.error || 'IMAP sync is not configured.');
        }
      },
      error: (err) => {
        this.isSyncingMail = false;
        this.showToast(`Mailbox notice: ${err.message}`);
      }
    });
  }
}
