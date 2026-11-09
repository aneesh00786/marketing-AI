import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StudioApiService, requestKey } from './studio-api.service';

interface TextLayer { text: string; x: number; y: number; size: number; color: string; weight: 400 | 700 | 900; align: 'left' | 'center' | 'right'; shadow: boolean; box: string | null }

/**
 * Image editor for generated or uploaded images (canvas, in the browser): crop and resize to a
 * platform size, move the picture inside the frame, background colour, text layers (drag to
 * position), the brand logo, and ready-made layouts. "Save copy" uploads a new PNG linked to the
 * original, which is never changed.
 */
@Component({
  selector: 'app-image-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./social-shared.css', './studio.css'],
  template: `
<div class="ie-backdrop" (click)="closed.emit()">
  <div class="ie" role="dialog" aria-modal="true" aria-labelledby="ie-title" (click)="$event.stopPropagation()">
    <header class="ie-head">
      <b id="ie-title">Edit image</b>
      <span class="st-muted">{{ size.w }} × {{ size.h }}</span>
      <button type="button" class="st-icon-btn" (click)="closed.emit()" aria-label="Close">✕</button>
    </header>
    <div class="ie-body">
      <div class="ie-stage">
        <canvas #canvas [width]="size.w" [height]="size.h" (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up()" (pointerleave)="up()" [attr.aria-label]="'Preview, ' + size.label"></canvas>
        <p class="st-muted" *ngIf="loadError">{{ loadError }}</p>
      </div>
      <aside class="ie-panel">
        <section>
          <h4>Size</h4>
          <div class="ie-sizes">
            <button type="button" class="st-chip" *ngFor="let s of sizes" [class.on]="s === size" (click)="setSize(s)">{{ s.label }}</button>
          </div>
          <label>Zoom<input type="range" min="1" max="3" step="0.05" [(ngModel)]="zoom" (input)="draw()" name="zoom" /></label>
          <label>Move picture ↔<input type="range" min="-1" max="1" step="0.01" [(ngModel)]="panX" (input)="draw()" name="panx" /></label>
          <label>Move picture ↕<input type="range" min="-1" max="1" step="0.01" [(ngModel)]="panY" (input)="draw()" name="pany" /></label>
          <label>Background<input type="color" [(ngModel)]="background" (input)="draw()" name="bg" /></label>
        </section>
        <section>
          <h4>Colours</h4>
          <label>Brightness<input type="range" min="50" max="150" step="1" [(ngModel)]="brightness" (input)="draw()" name="br" /></label>
          <label>Contrast<input type="range" min="50" max="150" step="1" [(ngModel)]="contrast" (input)="draw()" name="ct" /></label>
          <label>Saturation<input type="range" min="0" max="200" step="1" [(ngModel)]="saturation" (input)="draw()" name="sa" /></label>
          <button type="button" class="st-link" (click)="brightness = 100; contrast = 100; saturation = 100; draw()">Reset colours</button>
        </section>
        <section>
          <h4>AI background</h4>
          <p class="st-muted" *ngIf="!caps?.image?.referenceImages">Needs an image provider that can edit images (OpenAI Images).</p>
          <ng-container *ngIf="caps?.image?.referenceImages">
            <label>New background<input [(ngModel)]="newBackground" name="nbg" maxlength="500" placeholder="e.g. a clean white studio, a cosy cafe" /></label>
            <button type="button" class="btn btn-secondary btn-sm" [disabled]="bgBusy || newBackground.trim().length < 3" (click)="replaceBackground()">{{ bgBusy ? 'Replacing...' : 'Replace background with AI' }}</button>
            <small class="st-muted">Uses AI credits; the result is saved as a new copy and opens here.</small>
          </ng-container>
        </section>
        <section>
          <h4>Layouts</h4>
          <div class="ie-sizes"><button type="button" class="st-chip" *ngFor="let t of templates" (click)="applyTemplate(t.key)">{{ t.label }}</button></div>
        </section>
        <section>
          <h4>Text <button type="button" class="st-link" (click)="addText()">+ Add text</button></h4>
          <div class="ie-layer" *ngFor="let t of texts; let i = index" [class.on]="i === active" (click)="active = i">
            <input [(ngModel)]="t.text" (input)="draw()" [name]="'tx' + i" aria-label="Text" />
            <div class="ie-row">
              <label>Size<input type="number" min="10" max="300" [(ngModel)]="t.size" (input)="draw()" [name]="'ts' + i" /></label>
              <label>Colour<input type="color" [(ngModel)]="t.color" (input)="draw()" [name]="'tc' + i" /></label>
              <label>Weight<select [(ngModel)]="t.weight" (change)="draw()" [name]="'tw' + i"><option [ngValue]="400">Regular</option><option [ngValue]="700">Bold</option><option [ngValue]="900">Heavy</option></select></label>
              <label>Align<select [(ngModel)]="t.align" (change)="draw()" [name]="'ta' + i"><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option></select></label>
              <label class="st-check"><input type="checkbox" [(ngModel)]="t.shadow" (change)="draw()" [name]="'tsh' + i" /> Shadow</label>
              <button type="button" class="st-link" (click)="removeText(i)">Remove</button>
            </div>
          </div>
          <p class="st-muted" *ngIf="texts.length">Drag text on the picture to move it.</p>
        </section>
        <section>
          <h4>Logo</h4>
          <p class="st-muted" *ngIf="!brandKit?.logo">Add a logo to your Brand Kit to place it here.</p>
          <ng-container *ngIf="brandKit?.logo">
            <label class="st-check"><input type="checkbox" [(ngModel)]="logoOn" (change)="draw()" name="logo" /> Show logo</label>
            <label>Corner<select [(ngModel)]="logoCorner" (change)="draw()" name="lc"><option value="tl">Top left</option><option value="tr">Top right</option><option value="bl">Bottom left</option><option value="br">Bottom right</option></select></label>
            <label>Logo size<input type="range" min="0.06" max="0.35" step="0.01" [(ngModel)]="logoScale" (input)="draw()" name="ls" /></label>
          </ng-container>
        </section>
      </aside>
    </div>
    <footer class="ie-foot">
      <span class="st-note bad" *ngIf="error">{{ error }}</span>
      <span class="st-muted">The original image is kept.</span>
      <button type="button" class="btn btn-secondary" (click)="download()">⬇ Download PNG</button>
      <button type="button" class="btn btn-primary" [disabled]="saving || !!loadError" (click)="save()">{{ saving ? 'Saving…' : 'Save copy to library' }}</button>
    </footer>
  </div>
</div>
`
})
export class ImageEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() asset!: { id: number; url: string | null; width?: number; height?: number; title?: string };
  @Input() brandKit: any = null;
  @Output() saved = new EventEmitter<any>();
  @Output() closed = new EventEmitter<void>();
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly sizes = [
    { label: 'Square 1080×1080', w: 1080, h: 1080 }, { label: 'Portrait 1080×1350', w: 1080, h: 1350 },
    { label: 'Story / Reel 1080×1920', w: 1080, h: 1920 }, { label: 'Landscape 1200×628', w: 1200, h: 628 },
    { label: 'YouTube 1280×720', w: 1280, h: 720 }, { label: 'LinkedIn 1200×1200', w: 1200, h: 1200 }
  ];
  readonly templates = [{ key: 'banner', label: 'Bottom banner' }, { key: 'headline', label: 'Big headline' }, { key: 'offer', label: 'Offer badge' }, { key: 'clean', label: 'Clear all' }];
  size = this.sizes[0];
  zoom = 1; panX = 0; panY = 0;
  background = '#ffffff';
  texts: TextLayer[] = [];
  bars: { y: number; h: number; color: string }[] = [];
  active = -1;
  logoOn = true; logoCorner: 'tl' | 'tr' | 'bl' | 'br' = 'br'; logoScale = 0.16;
  saving = false; error = ''; loadError = '';
  brightness = 100; contrast = 100; saturation = 100;
  caps: any = null; newBackground = ''; bgBusy = false;
  private img: HTMLImageElement | null = null;
  private logo: HTMLImageElement | null = null;
  private drag: { i: number; dx: number; dy: number } | null = null;

  constructor(private studio: StudioApiService) {}

  /** Starts at the platform size closest to the image's own shape. */
  ngOnInit(): void {
    this.studio.capabilities().subscribe({ next: r => this.caps = r.capabilities, error: () => this.caps = null });
    if (this.asset?.width && this.asset?.height) {
      const r = this.asset.width / this.asset.height;
      this.size = this.sizes.reduce((best, s) => (Math.abs(s.w / s.h - r) < Math.abs(best.w / best.h - r) ? s : best), this.sizes[0]);
    }
    this.load(this.asset?.url, i => { this.img = i; this.draw(); }, () => this.loadError = 'The image could not be loaded.');
    if (this.brandKit?.logo?.url) this.load(this.brandKit.logo.url, i => { this.logo = i; this.draw(); }, () => {});
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.draw());
  }
  ngOnDestroy(): void { this.img = null; this.logo = null; }

  private load(url: string | null | undefined, ok: (i: HTMLImageElement) => void, fail: () => void): void {
    if (!url) { fail(); return; }
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => ok(i);
    i.onerror = fail;
    // Library files are loaded from this site (same origin), so the canvas can be exported.
    try { const u = new URL(url, location.href); i.src = u.pathname.startsWith('/api/v1/social/media-files/') ? u.pathname : url; } catch { i.src = url; }
  }

  setSize(s: any): void { this.size = s; setTimeout(() => this.draw()); }
  addText(): void { this.texts.push({ text: 'Your text', x: this.size.w / 2, y: this.size.h / 2, size: Math.round(this.size.w / 14), color: '#ffffff', weight: 700, align: 'center', shadow: true, box: null }); this.active = this.texts.length - 1; this.draw(); }
  removeText(i: number): void { this.texts.splice(i, 1); this.active = -1; this.draw(); }

  applyTemplate(key: string): void {
    const { w, h } = this.size;
    const brand = this.brandKit?.primaryColor || '#111827';
    if (key === 'clean') { this.texts = []; this.bars = []; }
    if (key === 'banner') { this.bars = [{ y: h * 0.78, h: h * 0.22, color: this.alpha(brand, 0.85) }]; this.texts = [{ text: 'Your headline here', x: w / 2, y: h * 0.89, size: Math.round(w / 16), color: '#ffffff', weight: 700, align: 'center', shadow: false, box: null }]; }
    if (key === 'headline') { this.bars = []; this.texts = [{ text: 'BIG HEADLINE', x: w / 2, y: h * 0.18, size: Math.round(w / 9), color: '#ffffff', weight: 900, align: 'center', shadow: true, box: null }, { text: 'Supporting line', x: w / 2, y: h * 0.28, size: Math.round(w / 24), color: '#ffffff', weight: 400, align: 'center', shadow: true, box: null }]; }
    if (key === 'offer') { this.texts.push({ text: '20% OFF', x: w * 0.82, y: h * 0.14, size: Math.round(w / 15), color: '#ffffff', weight: 900, align: 'center', shadow: false, box: this.brandKit?.secondaryColor || '#dc2626' }); }
    this.active = this.texts.length - 1;
    this.draw();
  }

  private alpha(hex: string, a: number): string {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : hex;
  }

  draw(): void {
    const c = this.canvasRef?.nativeElement;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const { w, h } = this.size;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, w, h);
    if (this.img) {
      // Cover the frame, then zoom and move inside it.
      const s = Math.max(w / this.img.width, h / this.img.height) * Number(this.zoom);
      const iw = this.img.width * s; const ih = this.img.height * s;
      const x = (w - iw) / 2 + Number(this.panX) * (iw - w) / 2;
      const y = (h - ih) / 2 + Number(this.panY) * (ih - h) / 2;
      ctx.filter = `brightness(${this.brightness}%) contrast(${this.contrast}%) saturate(${this.saturation}%)`;
      ctx.drawImage(this.img, x, y, iw, ih);
      ctx.filter = 'none';
    }
    for (const b of this.bars) { ctx.fillStyle = b.color; ctx.fillRect(0, b.y, w, b.h); }
    if (this.logo && this.logoOn) {
      const lw = w * Number(this.logoScale); const lh = lw * (this.logo.height / this.logo.width); const m = w * 0.04;
      const lx = this.logoCorner.endsWith('l') ? m : w - lw - m; const ly = this.logoCorner.startsWith('t') ? m : h - lh - m;
      ctx.drawImage(this.logo, lx, ly, lw, lh);
    }
    const font = this.brandKit?.fonts ? `${String(this.brandKit.fonts).split(',')[0]}, Inter, Arial, sans-serif` : 'Inter, Arial, sans-serif';
    for (const [i, t] of this.texts.entries()) {
      ctx.font = `${t.weight} ${t.size}px ${font}`;
      ctx.textAlign = t.align;
      ctx.textBaseline = 'middle';
      const lines = String(t.text || '').split('\n');
      const lineH = t.size * 1.15;
      if (t.box) {
        const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + t.size;
        const bx = t.align === 'left' ? t.x - t.size / 2 : t.align === 'right' ? t.x - tw + t.size / 2 : t.x - tw / 2;
        ctx.fillStyle = t.box;
        ctx.fillRect(bx, t.y - lineH / 2 - t.size * 0.3, tw, lineH * lines.length + t.size * 0.6);
      }
      ctx.shadowColor = t.shadow ? 'rgba(0,0,0,0.55)' : 'transparent';
      ctx.shadowBlur = t.shadow ? t.size / 6 : 0;
      ctx.fillStyle = t.color;
      lines.forEach((l, k) => ctx.fillText(l, t.x, t.y + k * lineH));
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      if (i === this.active) { ctx.strokeStyle = 'rgba(79,70,229,0.9)'; ctx.lineWidth = 3; const tw = Math.max(...lines.map(l => ctx.measureText(l).width)); const bx = t.align === 'left' ? t.x : t.align === 'right' ? t.x - tw : t.x - tw / 2; ctx.strokeRect(bx - 8, t.y - lineH / 2 - 8, tw + 16, lineH * lines.length + 16); }
    }
  }

  private point(e: PointerEvent): { x: number; y: number } {
    const c = this.canvasRef.nativeElement; const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  }
  down(e: PointerEvent): void {
    const p = this.point(e);
    const i = this.texts.map((t, k) => ({ t, k })).reverse().find(({ t }) => Math.abs(p.y - t.y) < t.size && Math.abs(p.x - t.x) < this.size.w / 2)?.k;
    if (i === undefined) return;
    this.active = i;
    this.drag = { i, dx: p.x - this.texts[i].x, dy: p.y - this.texts[i].y };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.draw();
  }
  move(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.point(e); const t = this.texts[this.drag.i];
    t.x = Math.round(p.x - this.drag.dx); t.y = Math.round(p.y - this.drag.dy);
    this.draw();
  }
  up(): void { this.drag = null; }

  private png(): Promise<Blob> {
    const prev = this.active; this.active = -1; this.draw();
    return new Promise((resolve, reject) => this.canvasRef.nativeElement.toBlob(b => { this.active = prev; this.draw(); b ? resolve(b) : reject(new Error('Export failed')); }, 'image/png'));
  }
  async download(): Promise<void> {
    try {
      const b = await this.png();
      const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${(this.asset.title || 'design').replace(/[^\w-]+/g, '-')}.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch { this.error = 'This image cannot be exported in your browser.'; }
  }
  /**
   * AI background replacement: estimate, confirm, start; follows the job, then loads the new copy here
   * (the original stays in the library).
   */
  replaceBackground(): void {
    this.studio.estimate('image', { variations: 1 }).subscribe({
      next: e => {
        if (!confirm(`Replace the background with AI? About ${e.estimate.credits} credits${e.estimate.costUsd !== null ? ` (about $${e.estimate.costUsd})` : ''}.`)) return;
        this.bgBusy = true; this.error = '';
        this.studio.replaceBackground({ assetId: this.asset.id, background: this.newBackground.trim(), requestKey: requestKey(), confirm: true }).subscribe({
          next: r => this.followBackground(r.generation.id, 0),
          error: err => { this.bgBusy = false; this.error = err?.error?.error || 'Background replacement failed.'; }
        });
      },
      error: err => this.error = err?.error?.error || 'Could not estimate the cost.'
    });
  }
  private followBackground(id: number, step: number): void {
    if (step > 90) { this.bgBusy = false; this.error = 'Still working: find the result in the Content Library.'; return; }
    setTimeout(() => this.studio.generation(id).subscribe({
      next: r => {
        const g = r.generation;
        if (g.status === 'completed' && g.assets?.[0]) {
          this.bgBusy = false;
          this.asset = { ...this.asset, id: g.assets[0].id, url: g.assets[0].url };
          this.load(g.assets[0].url, i => { this.img = i; this.draw(); }, () => this.loadError = 'The new image could not be loaded.');
        } else if (g.status === 'failed') { this.bgBusy = false; this.error = g.error || 'Background replacement failed.'; }
        else this.followBackground(id, step + 1);
      },
      error: () => this.followBackground(id, step + 1)
    }), 3000);
  }

  async save(): Promise<void> {
    this.saving = true; this.error = '';
    try {
      const b = await this.png();
      this.studio.saveEdited(this.asset.id, b, `${this.asset.title || 'Image'} (edited)`).subscribe({
        next: r => { this.saving = false; this.saved.emit(r.asset); },
        error: e => { this.saving = false; this.error = e?.error?.error || 'Saving failed.'; }
      });
    } catch { this.saving = false; this.error = 'This image cannot be exported in your browser.'; }
  }
}
