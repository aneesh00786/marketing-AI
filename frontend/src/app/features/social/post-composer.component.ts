import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SocialApiService } from './social-api.service';
import { MediaLibraryComponent } from './media-library.component';
import { AuthStateService } from '../../core/auth-state.service';
import { apiRoot } from '../../core/api-base';

interface Target { key: string; accountId: number | null; platformKey: string; label: string; accountType: string; status: string; }
interface Override { caption?: string; hashtagsText?: string; linkUrl?: string; title?: string; mediaAssetIds?: number[]; }

const LIMITS: Record<string, number> = { facebook: 63206, instagram: 2200, linkedin: 3000, youtube: 5000, x: 280 };
const ICONS: Record<string, string> = { facebook: '📘', instagram: '📸', linkedin: '💼', youtube: '▶️', x: '✖️' };

/**
 * Creates one draft per selected account from shared content plus optional per-platform
 * changes. Validation comes from the server (the same rules used before publishing); the
 * composer never trims or rewrites text to make it pass. Unsaved work is kept in this browser
 * for the signed-in user and workspace until the drafts are created.
 */
@Component({
  selector: 'app-post-composer',
  standalone: true,
  imports: [CommonModule, FormsModule, MediaLibraryComponent],
  templateUrl: './post-composer.component.html',
  styleUrls: ['./social-shared.css', './post-composer.component.css']
})
export class PostComposerComponent implements OnInit, OnDestroy {
  @Input() accounts: any[] = [];
  @Input() products: any[] = [];
  @Input() campaigns: any[] = [];
  @Output() created = new EventEmitter<any>();
  @Output() closed = new EventEmitter<void>();
  @Output() toast = new EventEmitter<string>();

  targets: Target[] = [];
  selectedKeys: string[] = [];
  base = { title: '', caption: '', hashtagsText: '', callToAction: '', linkUrl: '', mediaAssetIds: [] as number[] };
  overrides: Record<string, Override> = {};
  youtube: Record<string, { privacyStatus: string; madeForKids: boolean }> = {};
  campaignId: number | null = null;
  tab = 'shared';
  previewKey: string | null = null;
  showMedia = false;
  assets = new Map<number, any>();
  validation: Record<string, any> = {};
  validating = false;
  saving = false;
  templates: any[] = [];
  restoreOffer: { savedAt: string; state: any } | null = null;

  ai = { productId: null as number | null, instruction: '', tone: 'Professional', length: 'medium', busy: false, result: null as any, mode: '' };

  private validateTimer: any = null;
  private saveTimer: any = null;

  constructor(private api: SocialApiService, private auth: AuthStateService) {}

  ngOnInit(): void {
    this.targets = [
      ...this.accounts.filter(a => a.status !== 'disconnected').map(a => ({
        key: `a${a.id}`, accountId: a.id, platformKey: a.platformKey, label: a.displayName, accountType: a.accountType, status: a.status
      })),
      { key: 'px', accountId: null, platformKey: 'x', label: 'X (copy and post manually)', accountType: 'x', status: 'manual' }
    ];
    this.api.templates().subscribe({ next: r => this.templates = r.templates, error: () => this.templates = [] });
    this.api.media({ limit: 200 }).subscribe({ next: r => this.onAssets(r.items), error: () => { /* previews fall back to icons */ } });
    try {
      const raw = localStorage.getItem(this.storageKey());
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.state && (saved.state.base?.caption || saved.state.base?.mediaAssetIds?.length || saved.state.selectedKeys?.length)) this.restoreOffer = saved;
      }
    } catch { /* storage unavailable */ }
  }

  ngOnDestroy(): void {
    clearTimeout(this.validateTimer);
    clearTimeout(this.saveTimer);
  }

  // ---------- helpers ----------
  icon(p: string): string { return ICONS[p] || '📝'; }
  limit(p: string): number { return LIMITS[p] || 0; }
  target(key: string): Target | undefined { return this.targets.find(t => t.key === key); }
  selectedTargets(): Target[] { return this.selectedKeys.map(k => this.target(k)!).filter(Boolean); }
  isSelected(t: Target): boolean { return this.selectedKeys.includes(t.key); }
  hasOverride(key: string, field: keyof Override): boolean { return this.overrides[key]?.[field] !== undefined; }

  private storageKey(): string {
    return `mkt_social_composer_${this.auth.workspace?.id ?? 'w'}_${this.auth.user?.id ?? 'u'}`;
  }

  splitTags(text: string): string[] {
    return String(text || '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean).map(t => (t.startsWith('#') ? t : `#${t}`));
  }

  eff(key: string): any {
    const o = this.overrides[key] || {};
    return {
      title: o.title ?? this.base.title,
      caption: o.caption ?? this.base.caption,
      hashtagsText: o.hashtagsText ?? this.base.hashtagsText,
      callToAction: this.base.callToAction,
      linkUrl: o.linkUrl ?? this.base.linkUrl,
      mediaAssetIds: o.mediaAssetIds ?? this.base.mediaAssetIds
    };
  }

  /** The text a platform receives: caption, then call to action (if not already in it), then hashtags. */
  fullText(key: string): string {
    const e = this.eff(key);
    const tags = this.splitTags(e.hashtagsText).join(' ');
    return [e.caption, e.callToAction && !e.caption.includes(e.callToAction) ? e.callToAction : '', tags].filter(Boolean).join('\n\n').trim();
  }

  chars(key: string): number { return [...this.fullText(key)].length; }

  mediaFor(key: string): any[] { return this.eff(key).mediaAssetIds.map((id: number) => this.assets.get(id)).filter(Boolean); }

  src(a: any): string | null { return a?.previewPath ? `${apiRoot()}${a.previewPath}` : a?.url || null; }
  thumb(a: any): string | null {
    if (!a) return null;
    if (a.assetType === 'image') return this.src(a);
    return a.thumbnailPreviewPath ? `${apiRoot()}${a.thumbnailPreviewPath}` : null;
  }

  onAssets(list: any[]): void {
    for (const a of list) this.assets.set(a.id, a);
  }

  // ---------- target selection and overrides ----------
  toggleTarget(t: Target): void {
    this.selectedKeys = this.isSelected(t) ? this.selectedKeys.filter(k => k !== t.key) : [...this.selectedKeys, t.key];
    if (t.platformKey === 'youtube' && !this.youtube[t.key]) this.youtube[t.key] = { privacyStatus: 'public', madeForKids: false };
    if (!this.selectedKeys.includes(this.tab) && this.tab !== 'shared') this.tab = 'shared';
    if (!this.previewKey || !this.selectedKeys.includes(this.previewKey)) this.previewKey = this.selectedKeys[0] || null;
    this.changed();
  }

  customize(key: string, field: keyof Override): void {
    const o = this.overrides[key] = this.overrides[key] || {};
    const b: any = this.base;
    (o as any)[field] = Array.isArray(b[field]) ? [...b[field]] : b[field];
    this.changed();
  }

  resetField(key: string, field: keyof Override): void {
    if (this.overrides[key]) delete this.overrides[key][field];
    this.changed();
  }

  setMedia(scope: string, ids: number[]): void {
    if (scope === 'shared') this.base.mediaAssetIds = ids;
    else (this.overrides[scope] = this.overrides[scope] || {}).mediaAssetIds = ids;
    this.changed();
  }

  // ---------- validation & local draft ----------
  changed(): void {
    clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => this.validate(), 500);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveLocal(), 800);
  }

  payload(): any {
    return {
      campaignId: this.campaignId ? Number(this.campaignId) : null,
      base: {
        title: this.base.title || null,
        caption: this.base.caption,
        hashtags: this.base.hashtagsText,
        callToAction: this.base.callToAction || null,
        linkUrl: this.base.linkUrl || null,
        mediaAssetIds: this.base.mediaAssetIds
      },
      targets: this.selectedTargets().map(t => {
        const o = this.overrides[t.key] || {};
        const out: any = t.accountId ? { accountId: t.accountId } : { platformKey: t.platformKey };
        if (o.caption !== undefined) out.caption = o.caption;
        if (o.hashtagsText !== undefined) out.hashtags = o.hashtagsText;
        if (o.linkUrl !== undefined) out.linkUrl = o.linkUrl || null;
        if (o.title !== undefined) out.title = o.title || null;
        if (o.mediaAssetIds !== undefined) out.mediaAssetIds = o.mediaAssetIds;
        if (t.platformKey === 'youtube' && this.youtube[t.key]) out.platformOptions = { youtube: { ...this.youtube[t.key] } };
        return out;
      })
    };
  }

  validate(): void {
    if (!this.selectedKeys.length) { this.validation = {}; return; }
    const keys = [...this.selectedKeys];
    this.validating = true;
    this.api.validateTargets(this.payload()).subscribe({
      next: r => {
        this.validating = false;
        const v: Record<string, any> = {};
        r.results.forEach((res: any, i: number) => v[keys[i]] = res);
        this.validation = v;
      },
      error: e => { this.validating = false; this.validation = {}; this.toast.emit(`⚠️ ${e?.error?.error || 'Validation failed.'}`); }
    });
  }

  problemCount(): number {
    return Object.values(this.validation).reduce((n: number, v: any) => n + (v?.problems?.length || 0), 0);
  }

  private saveLocal(): void {
    try {
      const state = { base: this.base, overrides: this.overrides, youtube: this.youtube, selectedKeys: this.selectedKeys, campaignId: this.campaignId };
      localStorage.setItem(this.storageKey(), JSON.stringify({ savedAt: new Date().toISOString(), state }));
    } catch { /* storage unavailable: nothing to recover later */ }
  }

  restore(): void {
    const s = this.restoreOffer?.state;
    this.restoreOffer = null;
    if (!s) return;
    this.base = { ...this.base, ...s.base };
    this.overrides = s.overrides || {};
    this.youtube = s.youtube || {};
    this.campaignId = s.campaignId || null;
    this.selectedKeys = (s.selectedKeys || []).filter((k: string) => this.target(k));
    this.previewKey = this.selectedKeys[0] || null;
    this.changed();
  }

  discardRestore(): void {
    this.restoreOffer = null;
    try { localStorage.removeItem(this.storageKey()); } catch { /* ignore */ }
  }

  close(): void {
    const dirty = !!(this.base.caption || this.base.mediaAssetIds.length || Object.keys(this.overrides).length);
    if (dirty && !confirm('Close the composer? Your unsaved post stays in this browser and can be restored next time.')) return;
    this.closed.emit();
  }

  // ---------- create ----------
  create(): void {
    if (!this.selectedKeys.length) { this.toast.emit('Choose at least one account.'); return; }
    if (!this.base.caption.trim() && !this.base.mediaAssetIds.length && !Object.values(this.overrides).some(o => o.caption || o.mediaAssetIds?.length)) {
      this.toast.emit('Write something or attach media first.');
      return;
    }
    this.saving = true;
    this.api.compose(this.payload()).subscribe({
      next: r => {
        this.saving = false;
        try { localStorage.removeItem(this.storageKey()); } catch { /* ignore */ }
        const blocked = r.items.filter((i: any) => i.validation?.problems?.length).length;
        this.toast.emit(`Created ${r.items.length} draft(s).${blocked ? ` ${blocked} need changes before they can be scheduled.` : ''} Submit them for approval from the Content Library.`);
        this.created.emit(r);
      },
      error: e => { this.saving = false; this.toast.emit(`⚠️ ${e?.error?.error || 'Could not create the drafts.'}`); }
    });
  }

  // ---------- templates ----------
  applyTemplate(id: any): void {
    const t = this.templates.find(x => x.id === Number(id));
    if (!t) return;
    if (this.base.caption && !confirm(`Replace the shared caption with the template "${t.name}"?`)) return;
    this.base.caption = t.caption;
    this.base.hashtagsText = (t.hashtags || []).join(' ');
    this.base.callToAction = t.callToAction || '';
    if (t.linkUrl) this.base.linkUrl = t.linkUrl;
    this.changed();
  }

  saveTemplate(): void {
    const name = prompt('Template name');
    if (!name?.trim()) return;
    this.api.createTemplate({ name: name.trim(), caption: this.base.caption, hashtags: this.base.hashtagsText, callToAction: this.base.callToAction || null, linkUrl: this.base.linkUrl || null }).subscribe({
      next: r => { this.templates = [...this.templates, r.template].sort((a, b) => a.name.localeCompare(b.name)); this.toast.emit('Template saved.'); },
      error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Could not save the template.'}`)
    });
  }

  deleteTemplate(id: any): void {
    const t = this.templates.find(x => x.id === Number(id));
    if (!t || !confirm(`Delete the template "${t.name}"?`)) return;
    this.api.deleteTemplate(t.id).subscribe({ next: () => this.templates = this.templates.filter(x => x.id !== t.id), error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Delete failed.'}`) });
  }

  // ---------- AI help (suggestions only; the user applies them) ----------
  private scopeText(): string {
    return this.tab === 'shared' ? this.base.caption : this.eff(this.tab).caption;
  }

  runAi(mode: string): void {
    const platforms = [...new Set(this.selectedTargets().map(t => t.platformKey))];
    const body: any = { mode, productId: this.ai.productId ? Number(this.ai.productId) : null, tone: this.ai.tone };
    if (mode === 'caption') {
      if (!platforms.length) { this.toast.emit('Choose accounts first, so captions fit each platform.'); return; }
      Object.assign(body, { platforms, instruction: this.ai.instruction, length: this.ai.length });
    } else if (mode === 'rewrite') {
      Object.assign(body, { text: this.scopeText(), length: this.ai.length === 'medium' ? 'same' : (this.ai.length === 'short' ? 'shorter' : 'longer'), platform: this.target(this.tab)?.platformKey || null });
    } else if (mode === 'repurpose') {
      const t = this.target(this.tab);
      if (!t) { this.toast.emit('Open a platform tab to adapt the shared post for it.'); return; }
      Object.assign(body, { text: this.base.caption, platform: t.platformKey });
    } else if (mode === 'hashtags' || mode === 'cta') {
      Object.assign(body, { text: this.scopeText(), platform: this.target(this.tab)?.platformKey || null });
    } else if (mode === 'alt_text') {
      const img = this.mediaFor(this.tab === 'shared' ? (this.selectedKeys[0] || '') : this.tab).find(a => a.assetType === 'image')
        || this.base.mediaAssetIds.map(id => this.assets.get(id)).find(a => a?.assetType === 'image');
      if (!img) { this.toast.emit('Attach an image first.'); return; }
      Object.assign(body, { assetId: img.id, text: this.scopeText() });
      this.ai.result = { ...(this.ai.result || {}), assetId: img.id };
    }
    this.ai.busy = true;
    this.ai.mode = mode;
    const assetId = body.assetId;
    this.api.aiAssist(body).subscribe({
      next: r => { this.ai.busy = false; this.ai.result = { ...r, assetId }; },
      error: e => { this.ai.busy = false; this.ai.result = null; this.toast.emit(`⚠️ ${e?.error?.error || 'AI request failed.'}`); }
    });
  }

  applyCaptionVariant(v: any): void {
    const keys = this.selectedTargets().filter(t => t.platformKey === v.platform).map(t => t.key);
    const onlyPlatform = new Set(this.selectedTargets().map(t => t.platformKey)).size === 1;
    if (onlyPlatform) {
      this.base.caption = v.caption;
      this.base.hashtagsText = v.hashtags.join(' ');
      if (v.callToAction) this.base.callToAction = v.callToAction;
    } else {
      for (const k of keys) {
        const o = this.overrides[k] = this.overrides[k] || {};
        o.caption = [v.caption, v.callToAction && !v.caption.includes(v.callToAction) ? v.callToAction : ''].filter(Boolean).join('\n\n');
        o.hashtagsText = v.hashtags.join(' ');
      }
    }
    this.changed();
  }

  applyText(text: string): void {
    if (this.tab === 'shared') this.base.caption = text;
    else (this.overrides[this.tab] = this.overrides[this.tab] || {}).caption = text;
    this.changed();
  }

  applyRepurpose(s: any): void {
    const o = this.overrides[this.tab] = this.overrides[this.tab] || {};
    o.caption = s.caption;
    o.hashtagsText = s.hashtags.join(' ');
    this.changed();
  }

  addHashtags(tags: string[]): void {
    const scopeTags = this.tab === 'shared' ? this.base.hashtagsText : this.eff(this.tab).hashtagsText;
    const merged = [...new Set([...this.splitTags(scopeTags), ...tags])].join(' ');
    if (this.tab === 'shared') this.base.hashtagsText = merged;
    else (this.overrides[this.tab] = this.overrides[this.tab] || {}).hashtagsText = merged;
    this.changed();
  }

  useCta(text: string): void {
    this.base.callToAction = text;
    this.changed();
  }

  saveAltText(): void {
    const id = this.ai.result?.assetId;
    const alt = this.ai.result?.suggestions?.altText;
    if (!id || !alt) return;
    this.api.updateMedia(id, { altText: alt }).subscribe({
      next: () => { this.toast.emit('Alt text saved to the image.'); this.ai.result = null; },
      error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Could not save alt text.'}`)
    });
  }
}
