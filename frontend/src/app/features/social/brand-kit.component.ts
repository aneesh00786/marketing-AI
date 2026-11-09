import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { StudioApiService } from './studio-api.service';
import { SocialApiService } from './social-api.service';

/**
 * Brand Kit: the workspace's logo, colours, fonts, voice, guidelines, product and reference
 * images. The default kit is applied to every AI generation automatically. Images come from this
 * workspace's media library (or are uploaded into it here).
 */
@Component({
  selector: 'app-brand-kit',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./social-shared.css', './studio.css'],
  template: `
<div class="st">
  <div class="st-head">
    <div><h3>Brand Kit</h3><p class="st-muted">Mark uses your brand in every poster, video, post and carousel it creates. Set it up once.</p></div>
    <div class="st-head-side"><button type="button" class="btn btn-secondary btn-sm" (click)="newKit()">+ New brand</button></div>
  </div>
  <p class="st-note bad" *ngIf="error" role="alert">{{ error }}</p>
  <div class="bk">
    <div class="bk-side">
      <div class="bk-preview" aria-label="Brand preview">
        <div class="bk-preview-band" [style.background]="'linear-gradient(135deg, ' + (form.primaryColor || '#1e40af') + ', ' + (form.secondaryColor || '#f59e0b') + ')'">
          <img *ngIf="url(form.logoAssetId)" [src]="url(form.logoAssetId)" alt="Logo" />
        </div>
        <div class="bk-preview-body">
          <b [style.font-family]="form.fonts || null">{{ form.companyName || form.name || 'Your brand' }}</b>
          <span class="st-muted">{{ form.tone || 'Set your tone of voice' }}</span>
          <div class="bk-preview-swatches"><span [style.background]="form.primaryColor"></span><span [style.background]="form.secondaryColor"></span></div>
        </div>
      </div>
      <nav class="bk-list" *ngIf="kits.length" aria-label="Brands">
        <button type="button" *ngFor="let k of kits" class="bk-item" [class.on]="form.id === k.id" (click)="open(k)">
          <span class="bk-swatch" [style.background]="k.primaryColor || '#e5e7eb'"></span>{{ k.name }}<em *ngIf="k.isDefault">Default</em>
        </button>
      </nav>
    </div>
    <form class="st-card st-form bk-form" (ngSubmit)="save()">
      <div class="st-grid">
        <label>Brand name *<input name="name" [(ngModel)]="form.name" required maxlength="120" placeholder="e.g. ThriveWoo" /></label>
        <label>Company name<input name="company" [(ngModel)]="form.companyName" maxlength="200" /></label>
        <label>Website<input name="web" [(ngModel)]="form.website" maxlength="500" placeholder="https://" /></label>
        <label>Contact information<input name="contact" [(ngModel)]="form.contactInfo" maxlength="500" placeholder="Phone, email, address" /></label>
        <label>Primary colour<span class="bk-color"><input type="color" name="pc" [(ngModel)]="form.primaryColor" /><code>{{ form.primaryColor }}</code></span></label>
        <label>Secondary colour<span class="bk-color"><input type="color" name="sc" [(ngModel)]="form.secondaryColor" /><code>{{ form.secondaryColor }}</code></span></label>
        <label>Fonts<input name="fonts" [(ngModel)]="form.fonts" maxlength="200" placeholder="e.g. Poppins, Inter" /></label>
        <label>Tone of voice<input name="tone" [(ngModel)]="form.tone" maxlength="200" placeholder="e.g. Confident, friendly, expert" /></label>
        <label class="wide">About the brand<textarea name="desc" rows="2" [(ngModel)]="form.description" maxlength="3000" placeholder="What you sell, to whom, what makes you different"></textarea></label>
        <label class="wide">Brand guidelines<textarea name="guide" rows="3" [(ngModel)]="form.guidelines" maxlength="5000" placeholder="Do's and don'ts: words to use or avoid, imagery, claims you never make"></textarea></label>
      </div>

      <div class="bk-images">
        <div>
          <h4>Logo</h4>
          <div class="bk-thumbs">
            <img *ngIf="url(form.logoAssetId)" [src]="url(form.logoAssetId)" alt="Logo" class="bk-logo" />
            <label class="st-chip bk-upload">⬆ Upload<input type="file" accept="image/png,image/jpeg,image/webp" (change)="upload($event, 'logo')" hidden /></label>
            <button type="button" class="st-chip" (click)="picking = picking === 'logo' ? null : 'logo'">Choose from library</button>
            <button type="button" class="st-link" *ngIf="form.logoAssetId" (click)="form.logoAssetId = null">Remove</button>
          </div>
        </div>
        <div *ngFor="let g of groups">
          <h4>{{ g.label }}</h4>
          <div class="bk-thumbs">
            <span class="bk-thumb" *ngFor="let id of form[g.key]"><img [src]="url(id)" [alt]="g.label" /><button type="button" (click)="removeImg(g.key, id)" aria-label="Remove">✕</button></span>
            <label class="st-chip bk-upload">⬆ Upload<input type="file" accept="image/png,image/jpeg,image/webp" (change)="upload($event, g.key)" hidden /></label>
            <button type="button" class="st-chip" (click)="picking = picking === g.key ? null : g.key">Choose from library</button>
          </div>
        </div>
        <div class="bk-picker" *ngIf="picking">
          <p class="st-muted" *ngIf="!library.length">No images in the Content Library yet.</p>
          <button type="button" *ngFor="let a of library" class="bk-pick" (click)="pick(a)"><img [src]="a.previewPath || a.url" [alt]="a.title || 'Image'" loading="lazy" /></button>
        </div>
      </div>

      <div class="st-actions">
        <label class="st-check"><input type="checkbox" name="def" [(ngModel)]="form.isDefault" /> Use this brand by default</label>
        <button type="submit" class="btn btn-primary" [disabled]="busy || !form.name?.trim()">{{ busy ? 'Saving…' : 'Save brand kit' }}</button>
        <button type="button" class="btn btn-secondary" *ngIf="form.id" (click)="remove()">Delete</button>
      </div>
    </form>
  </div>
</div>
`
})
export class BrandKitComponent implements OnInit {
  @Output() toast = new EventEmitter<string>();
  readonly groups = [{ key: 'productAssetIds', label: 'Product images' }, { key: 'referenceAssetIds', label: 'Reference designs' }];
  kits: any[] = [];
  library: any[] = [];
  form: any = this.blank();
  picking: string | null = null;
  busy = false;
  error = '';

  constructor(private studio: StudioApiService, private social: SocialApiService) {}

  ngOnInit(): void { this.load(); this.loadLibrary(); }
  blank(): any { return { id: null, name: '', isDefault: false, companyName: '', website: '', contactInfo: '', primaryColor: '#1e40af', secondaryColor: '#f59e0b', fonts: '', tone: '', description: '', guidelines: '', logoAssetId: null, productAssetIds: [], referenceAssetIds: [] }; }
  load(): void {
    this.studio.brandKits().subscribe({ next: r => { this.kits = r.brandKits || []; if (!this.form.id && this.kits.length) this.open(this.kits.find(k => k.isDefault) || this.kits[0]); }, error: e => this.error = this.err(e) });
  }
  loadLibrary(): void { this.social.media({ type: 'image', limit: 200 }).subscribe({ next: r => this.library = r.items || [], error: () => {} }); }
  open(k: any): void { this.form = { ...this.blank(), ...k, primaryColor: k.primaryColor || '#1e40af', secondaryColor: k.secondaryColor || '#f59e0b', productAssetIds: [...(k.productAssetIds || [])], referenceAssetIds: [...(k.referenceAssetIds || [])] }; this.picking = null; }
  newKit(): void { this.form = this.blank(); if (!this.kits.length) this.form.isDefault = true; }
  url(id: number | null): string | null { const a = this.library.find(x => x.id === id); return a ? (a.previewPath || a.url) : null; }
  pick(a: any): void {
    if (this.picking === 'logo') this.form.logoAssetId = a.id;
    else if (this.picking && !this.form[this.picking].includes(a.id)) this.form[this.picking].push(a.id);
    this.picking = null;
  }
  removeImg(key: string, id: number): void { this.form[key] = this.form[key].filter((x: number) => x !== id); }

  upload(ev: Event, target: string): void {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.busy = true;
    this.social.uploadMedia(file, file.name).subscribe({
      next: e => {
        if (e.type !== HttpEventType.Response) return;
        this.busy = false;
        const asset = (e.body as any)?.asset;
        if (!asset) return;
        this.library = [asset, ...this.library];
        if (target === 'logo') this.form.logoAssetId = asset.id; else this.form[target].push(asset.id);
      },
      error: err => { this.busy = false; this.error = this.err(err); }
    });
  }

  save(): void {
    this.busy = true; this.error = '';
    const { id, logo, productImages, referenceImages, updatedAt, ...body } = this.form;
    this.studio.saveBrandKit(id, body).subscribe({
      next: r => { this.busy = false; this.form = { ...this.form, ...r.brandKit }; this.toast.emit('Brand kit saved. New content will use it.'); this.load(); },
      error: e => { this.busy = false; this.error = this.err(e); }
    });
  }
  remove(): void {
    if (!this.form.id || !confirm(`Delete the brand kit "${this.form.name}"?`)) return;
    this.studio.deleteBrandKit(this.form.id).subscribe({ next: () => { this.form = this.blank(); this.load(); this.toast.emit('Brand kit deleted.'); }, error: e => this.error = this.err(e) });
  }
  private err(e: any): string { return e?.error?.error || e?.message || 'Something went wrong.'; }
}
