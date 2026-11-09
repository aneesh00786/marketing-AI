import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Generation, StudioApiService, requestKey } from './studio-api.service';
import { SocialApiService } from './social-api.service';
import { ImageEditorComponent } from './image-editor.component';

type Mode = 'poster' | 'video' | 'post' | 'carousel';
const POLL_MS = 4000;

/**
 * AI Content Generator: posters, videos, platform posts and carousels, using the workspace's
 * Brand Kit. Before anything expensive starts, the credit estimate is shown and must be confirmed.
 * Images and videos are background jobs: their status is followed here (queued, processing,
 * completed, failed with Retry). Results land in the Content Library; nothing is ever published.
 */
@Component({
  selector: 'app-studio-generator',
  standalone: true,
  imports: [CommonModule, FormsModule, ImageEditorComponent],
  styleUrls: ['./social-shared.css', './studio.css'],
  template: `
<div class="st">
  <p class="st-note warn" *ngIf="!campaignId">Content is created inside a campaign for a selected product. Open Campaigns and choose a product first.</p>
  <div class="st-head" *ngIf="!embedded">
    <div>
      <h3>AI Content Generator</h3>
      <p class="st-muted">Describe what you want; Mark creates it with your brand. Everything is saved as a draft or in the Content Library — nothing is published without your approval.</p>
    </div>
    <div class="st-head-side">
      <label class="st-inline">Brand
        <select [(ngModel)]="brandKitId" name="brand"><option [ngValue]="null">{{ kits.length ? 'Default brand kit' : 'No brand kit yet' }}</option><option *ngFor="let k of kits" [ngValue]="k.id">{{ k.name }}</option></select>
      </label>
      <span class="st-pill" *ngIf="usage" [class.warn]="usage.creditLimit && usage.creditsLeft < 50" title="AI credits used this month">⚡ {{ usage.creditsUsed }}{{ usage.creditLimit ? ' / ' + usage.creditLimit : '' }} credits</span>
    </div>
  </div>

  <div class="st-modes" role="tablist" aria-label="What to create" *ngIf="!embedded">
    <button type="button" role="tab" *ngFor="let m of modes" class="st-mode" [class.on]="mode === m.key" [attr.aria-selected]="mode === m.key" (click)="setMode(m.key)">
      <span class="st-mode-icon" aria-hidden="true">{{ m.icon }}</span><b>{{ m.label }}</b><small>{{ m.hint }}</small>
      <em class="st-na" *ngIf="unavailable(m.key)">Not set up</em>
    </button>
  </div>

  <p class="st-note warn" *ngIf="unavailable(mode)" role="status">{{ unavailableReason(mode) }}</p>

  <form class="st-card st-form" (ngSubmit)="start()" *ngIf="!unavailable(mode)">
    <div class="st-presets" aria-label="Quick start">
      <span class="st-muted">Quick start:</span>
      <button type="button" class="st-chip" *ngFor="let p of presets[mode]" (click)="applyPreset(p)">{{ p.label }}</button>
    </div>
    <!-- Poster -->
    <ng-container *ngIf="mode === 'poster'">
      <div class="st-grid">
        <label>Campaign name<input name="p-camp" [(ngModel)]="poster.campaignName" maxlength="200" /></label>
        <label>Poster type<select name="p-purpose" [(ngModel)]="poster.purpose"><option *ngFor="let p of purposes" [value]="p.key">{{ p.label }}</option></select></label>
        <label>Style<select name="p-style" [(ngModel)]="poster.style"><option *ngFor="let s of styles" [value]="s">{{ s | titlecase }}</option></select></label>
        <label class="wide">Headline on the poster<input name="p-msg" [(ngModel)]="poster.message" maxlength="500" placeholder="e.g. Black Friday — 30% off all plans" /></label>
        <label class="wide">Description<textarea name="p-desc" rows="2" [(ngModel)]="poster.description" maxlength="3000" placeholder="What should the design show?"></textarea></label>
      </div>
      <details class="st-more"><summary>⚙️ Advanced options</summary>
        <div class="st-grid">
          <label>Marketing objective<input name="p-obj" [(ngModel)]="poster.objective" maxlength="300" /></label>
          <label>Target audience<input name="p-aud" [(ngModel)]="poster.audience" maxlength="500" /></label>
          <label>Size<select name="p-aspect" [(ngModel)]="poster.aspect"><option *ngFor="let a of imageAspects" [value]="a">{{ aspectLabel(a) }}</option></select></label>
          <label>Variations<select name="p-var" [(ngModel)]="poster.variations"><option *ngFor="let n of variationOptions" [ngValue]="n">{{ n }}</option></select></label>
          <label>Language<input name="p-lang" [(ngModel)]="poster.language" maxlength="30" /></label>
          <label>Offer badge<input name="p-offer" [(ngModel)]="poster.offer" maxlength="120" placeholder="e.g. 30% OFF" /></label>
          <label>Button text<input name="p-cta" [(ngModel)]="poster.cta" maxlength="80" placeholder="e.g. Book a demo" /></label>
          <label>Layout<select name="p-layout" [(ngModel)]="poster.layout"><option value="auto">Let AI decide</option><option value="centered">Centered</option><option value="split">Split (image + text)</option><option value="product_focus">Product focus</option><option value="text_heavy">Bold headline</option><option value="minimal_text">Minimal text</option></select></label>
          <label>Colour mood<select name="p-mood" [(ngModel)]="poster.mood"><option value="auto">Let AI decide</option><option value="bright">Bright</option><option value="dark">Dark</option><option value="warm">Warm</option><option value="cool">Cool</option><option value="pastel">Pastel</option><option value="vibrant">Vibrant</option></select></label>
          <label>Background<select name="p-bg" [(ngModel)]="poster.background"><option value="auto">Let AI decide</option><option value="solid">Solid colour</option><option value="gradient">Gradient</option><option value="photo">Photo</option><option value="pattern">Pattern</option><option value="scene">Illustrated scene</option></select></label>
          <label class="st-check"><input type="checkbox" name="p-bc" [(ngModel)]="poster.useBrandColors" /> Use brand colours</label>
          <label class="st-check"><input type="checkbox" name="p-ls" [(ngModel)]="poster.logoSpace" /> Leave space for my logo</label>
          <label class="wide">Avoid<input name="p-avoid" [(ngModel)]="poster.avoid" maxlength="300" placeholder="e.g. people, stock-photo look, red" /></label>
          <label class="wide">Your own prompt (optional, replaces the generated one)<textarea name="p-prompt" rows="2" [(ngModel)]="poster.prompt" maxlength="2000"></textarea></label>
          <div class="wide" *ngIf="caps?.image?.referenceImages">
            <span class="st-muted">Reference images (up to 4): your product photos, logo or a design to follow{{ poster.referenceAssetIds.length ? ' — ' + poster.referenceAssetIds.length + ' chosen' : '' }}</span>
            <div class="st-refs">
              <button type="button" *ngFor="let a of referenceChoices" class="st-ref" [class.on]="poster.referenceAssetIds.includes(a.id)" (click)="toggleRef(a.id)" [attr.aria-pressed]="poster.referenceAssetIds.includes(a.id)" [title]="a.title || ''"><img [src]="a.previewPath || a.url" [alt]="a.title || 'Image'" loading="lazy" /></button>
              <span class="st-muted" *ngIf="!referenceChoices.length">Upload images to the Content Library (or add product images to your Brand Kit) to use them here.</span>
            </div>
          </div>
        </div>
      </details>
    </ng-container>

    <!-- Video -->
    <ng-container *ngIf="mode === 'video'">
      <div class="st-grid">
        <label>Video title<input name="v-title" [(ngModel)]="video.title" maxlength="200" required /></label>
        <label>Type<select name="v-kind" [(ngModel)]="video.kind"><option value="promo">Promotional video</option><option value="reel">Marketing Reel</option><option value="short">YouTube Short</option><option value="ad">Advertisement</option><option value="animated_poster">Animated poster</option><option value="product">Product video</option></select></label>
        <label>Length<select name="v-dur" [(ngModel)]="video.durationSeconds"><option *ngFor="let d of videoDurations" [ngValue]="d">{{ d }} seconds</option></select></label>
        <label>Shape<select name="v-aspect" [(ngModel)]="video.aspect"><option *ngFor="let a of videoAspects" [value]="a">{{ aspectLabel(a) }}</option></select></label>
        <label class="wide">What happens in the video<textarea name="v-prompt" rows="3" [(ngModel)]="video.prompt" maxlength="2000" required placeholder="e.g. A dashboard comes to life as orders flow in, ending on the ThriveWoo logo"></textarea></label>
      </div>
      <details class="st-more"><summary>⚙️ Advanced options</summary>
        <div class="st-grid">
          <label>Target audience<input name="v-aud" [(ngModel)]="video.audience" maxlength="500" /></label>
          <label>Starting image (optional)<select name="v-img" [(ngModel)]="video.imageAssetId"><option [ngValue]="null">{{ caps?.video?.textToVideo ? 'None (text to video)' : 'Generate one from the description' }}</option><option *ngFor="let a of images" [ngValue]="a.id">{{ a.title || ('Image #' + a.id) }}</option></select></label>
          <label>Language<input name="v-lang" [(ngModel)]="video.language" maxlength="30" /></label>
          <label class="wide">Voice-over script (optional)<textarea name="v-vo" rows="2" [(ngModel)]="video.voiceOver" maxlength="2000" [disabled]="!caps?.voice?.available || !caps?.videoEditing?.available"></textarea>
            <small class="st-muted" *ngIf="!caps?.voice?.available || !caps?.videoEditing?.available">{{ !caps?.videoEditing?.available ? caps?.videoEditing?.reason : caps?.voice?.reason }}</small></label>
          <label>Camera<select name="v-cam" [(ngModel)]="video.camera"><option value="auto">Let AI decide</option><option value="static">Static</option><option value="slow_zoom">Slow zoom</option><option value="pan">Pan</option><option value="orbit">Orbit</option><option value="tracking">Tracking</option><option value="handheld">Handheld</option></select></label>
          <label>Mood<select name="v-mood" [(ngModel)]="video.mood"><option value="auto">Let AI decide</option><option value="energetic">Energetic</option><option value="calm">Calm</option><option value="luxury">Luxury</option><option value="playful">Playful</option><option value="cinematic">Cinematic</option><option value="corporate">Corporate</option></select></label>
          <label>Pace<select name="v-pace" [(ngModel)]="video.pace"><option value="auto">Let AI decide</option><option value="slow">Slow</option><option value="medium">Medium</option><option value="fast">Fast</option></select></label>
          <label>Avoid<input name="v-avoid" [(ngModel)]="video.avoid" maxlength="300" placeholder="e.g. text on screen, people" /></label>
          <label class="st-check"><input type="checkbox" name="v-subs" [(ngModel)]="video.subtitles" [disabled]="!caps?.videoEditing?.available" /> Add subtitles</label>
          <ng-container *ngIf="caps?.videoEditing?.available">
            <label>Intro card<select name="v-in" [(ngModel)]="video.introAssetId"><option [ngValue]="null">None</option><option *ngFor="let a of images" [ngValue]="a.id">{{ a.title || ('Image #' + a.id) }}</option></select></label>
            <label>Outro card<select name="v-out" [(ngModel)]="video.outroAssetId"><option [ngValue]="null">None</option><option *ngFor="let a of images" [ngValue]="a.id">{{ a.title || ('Image #' + a.id) }}</option></select></label>
            <label>Background music<select name="v-mu" [(ngModel)]="video.musicAssetId"><option [ngValue]="null">None</option><option *ngFor="let m of music" [ngValue]="m.id">{{ m.title || ('Track #' + m.id) }}</option></select></label>
          </ng-container>
        </div>
      </details>
    </ng-container>

    <!-- Social post -->
    <ng-container *ngIf="mode === 'post'">
      <fieldset class="st-platforms"><legend>Platforms</legend>
        <label *ngFor="let p of platforms" class="st-check"><input type="checkbox" [name]="'pl-' + p.key" [(ngModel)]="post.pick[p.key]" /> {{ p.icon }} {{ p.label }}</label>
      </fieldset>
      <div class="st-grid">
        <label>Objective<input name="s-obj" [(ngModel)]="post.objective" maxlength="300" placeholder="e.g. Book demos" /></label>
        <label class="wide">Message<textarea name="s-msg" rows="2" [(ngModel)]="post.message" maxlength="1000" placeholder="What should the post say?"></textarea></label>
      </div>
      <details class="st-more"><summary>⚙️ Advanced options</summary>
        <div class="st-grid">
          <label>Target audience<input name="s-aud" [(ngModel)]="post.audience" maxlength="500" /></label>
          <label>Tone<input name="s-tone" [(ngModel)]="post.tone" maxlength="100" placeholder="e.g. Friendly, expert" /></label>
          <label>Language<input name="s-lang" [(ngModel)]="post.language" maxlength="30" /></label>
          <label>Campaign<select name="s-camp" [(ngModel)]="post.campaignId"><option [ngValue]="null">None</option><option *ngFor="let c of campaigns" [ngValue]="c.id">{{ c.name }}</option></select></label>
          <label>Length<select name="s-len" [(ngModel)]="post.length"><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option></select></label>
          <label>Emojis<select name="s-emo" [(ngModel)]="post.emoji"><option value="none">None</option><option value="few">A few</option><option value="many">Many</option></select></label>
          <label>Hashtags per post<input type="number" name="s-ht" min="0" max="30" [(ngModel)]="post.hashtagCount" placeholder="Auto" /></label>
          <label>Call to action<input name="s-cta" [(ngModel)]="post.cta" maxlength="200" placeholder="e.g. Book a free demo" /></label>
          <label>Link<input name="s-link" [(ngModel)]="post.link" maxlength="500" placeholder="https://" /></label>
          <label>Keywords<input name="s-kw" [(ngModel)]="post.keywords" maxlength="300" /></label>
          <label class="wide">Avoid<input name="s-avoid" [(ngModel)]="post.avoid" maxlength="300" placeholder="e.g. jargon, competitor names" /></label>
          <label class="wide">Details<textarea name="s-desc" rows="2" [(ngModel)]="post.description" maxlength="3000"></textarea></label>
        </div>
      </details>
    </ng-container>

    <!-- Carousel -->
    <ng-container *ngIf="mode === 'carousel'">
      <div class="st-grid">
        <label class="wide">Topic<input name="c-topic" [(ngModel)]="carousel.topic" maxlength="500" required placeholder="e.g. 5 ways to speed up order processing" /></label>
        <label>Type<select name="c-kind" [(ngModel)]="carousel.kind"><option value="features">Product features</option><option value="steps">Step-by-step guide</option><option value="promotion">Promotion</option><option value="tips">Tips</option><option value="story">Story</option></select></label>
        <label>Slides<select name="c-n" [(ngModel)]="carousel.slideCount"><option *ngFor="let n of slideCounts" [ngValue]="n">{{ n }}</option></select></label>
        <label>Platform<select name="c-pl" [(ngModel)]="carousel.platform"><option value="instagram">Instagram</option><option value="linkedin">LinkedIn</option><option value="facebook">Facebook</option></select></label>
        <label>Style<select name="c-style" [(ngModel)]="carousel.style"><option *ngFor="let s of styles" [value]="s">{{ s | titlecase }}</option></select></label>
      </div>
      <details class="st-more"><summary>⚙️ Advanced options</summary>
        <div class="st-grid">
          <label>Target audience<input name="c-aud" [(ngModel)]="carousel.audience" maxlength="500" /></label>
          <label>Tone<input name="c-tone" [(ngModel)]="carousel.tone" maxlength="100" placeholder="e.g. Expert, friendly" /></label>
          <label>Words per slide<input type="number" name="c-wps" min="5" max="60" [(ngModel)]="carousel.wordsPerSlide" /></label>
          <label class="wide">Last-slide call to action<input name="c-cta" [(ngModel)]="carousel.cta" maxlength="120" placeholder="e.g. Follow for more tips" /></label>
        </div>
      </details>
      <div class="st-grid">
        <label class="st-check wide"><input type="checkbox" name="c-img" [(ngModel)]="carousel.withImages" [disabled]="!caps?.image?.available" /> Generate an image for every slide{{ caps?.image?.available ? '' : ' (needs an image provider)' }}</label>
      </div>
    </ng-container>

    <div class="st-actions">
      <button type="submit" class="btn btn-primary" [disabled]="busy || !canStart()">{{ busy ? 'Starting…' : '✨ Generate ' + modeLabel }}</button>
      <span class="st-muted" *ngIf="estimate">About {{ estimate.credits }} credits{{ estimate.costUsd !== null ? ' (≈ $' + estimate.costUsd + ')' : '' }}</span>
    </div>
  </form>

  <!-- Confirmation before expensive generations -->
  <div class="st-card st-confirm" *ngIf="confirmFor" role="alertdialog" aria-labelledby="st-confirm-title">
    <b id="st-confirm-title">Start this generation?</b>
    <p>It uses about <b>{{ confirmFor.estimate.credits }} AI credits</b>{{ confirmFor.estimate.costUsd !== null ? ' (about $' + confirmFor.estimate.costUsd + ' at your provider)' : '' }}{{ usage?.creditLimit ? '; ' + usage.creditsLeft + ' left this month' : '' }}. Failed generations are not charged.</p>
    <div class="st-actions"><button type="button" class="btn btn-primary" (click)="confirmStart()">Yes, generate</button><button type="button" class="btn btn-secondary" (click)="confirmFor = null">Cancel</button></div>
  </div>

  <p class="st-note bad" *ngIf="error" role="alert">{{ error }}</p>

  <!-- Current result -->
  <section class="st-card" *ngIf="current" aria-live="polite">
    <div class="st-result-head">
      <b>{{ kindLabel(current) }}</b>
      <span class="st-status" [attr.data-status]="current.status">{{ statusLabel(current) }}</span>
      <span class="st-muted" *ngIf="current.credits !== null">{{ current.credits }} credits</span>
      <button type="button" class="btn btn-secondary btn-sm" *ngIf="current.status === 'failed' && retryable(current)" (click)="retry(current)">↻ Retry</button>
    </div>
    <div class="st-progress" *ngIf="current.status === 'queued' || current.status === 'processing'"><i></i></div>
    <div class="st-skeletons" *ngIf="(current.status === 'queued' || current.status === 'processing') && current.kind !== 'text'" aria-hidden="true">
      <div class="st-skel" *ngFor="let n of skeletonCount(current)" [class.wide]="current.kind === 'video'"></div>
    </div>
    <p class="st-muted" *ngIf="current.status === 'processing' && current.kind === 'video'">Videos take a few minutes. You can leave this page: the video will be in the Content Library when it is ready.</p>
    <p class="st-note bad" *ngIf="current.status === 'failed'">{{ current.error }}</p>

    <!-- Images (posters, carousel slides, start frames) -->
    <div class="st-gallery" *ngIf="imageAssets(current).length">
      <figure *ngFor="let a of imageAssets(current)" class="st-shot">
        <img [src]="a.url" [alt]="'Generated design ' + a.id" loading="lazy" />
        <figcaption>
          <button type="button" class="btn btn-secondary btn-sm" (click)="editing = a">✏️ Edit</button>
          <a class="btn btn-secondary btn-sm" [href]="a.url" download>⬇ Download</a>
          <button type="button" class="btn btn-secondary btn-sm" *ngIf="current.kind === 'image'" (click)="regenerateOne()">↻ New design</button>
        </figcaption>
      </figure>
    </div>

    <!-- Video -->
    <div *ngIf="videoAsset(current) as v" class="st-video">
      <video [src]="v.url" controls playsinline preload="metadata"></video>
      <div class="st-actions"><a class="btn btn-secondary btn-sm" [href]="v.url" download>⬇ Download</a></div>
      <details class="st-more" open>
        <summary>Edit the video</summary>
        <p class="st-muted" *ngIf="!caps?.videoEditing?.available">{{ caps?.videoEditing?.reason }}</p>
        <div class="st-grid" *ngIf="caps?.videoEditing?.available">
          <label>Start at (seconds)<input type="number" name="t-s" min="0" step="0.5" [(ngModel)]="edit.start" /></label>
          <label>End at (seconds)<input type="number" name="t-e" min="0.5" step="0.5" [(ngModel)]="edit.end" /></label>
          <label>Intro card<select name="t-in" [(ngModel)]="edit.introAssetId"><option [ngValue]="null">None</option><option *ngFor="let a of images" [ngValue]="a.id">{{ a.title || ('Image #' + a.id) }}</option></select></label>
          <label>Intro length<select name="t-ins" [(ngModel)]="edit.introSeconds"><option *ngFor="let s of cardSeconds" [ngValue]="s">{{ s }} s</option></select></label>
          <label>Outro card<select name="t-out" [(ngModel)]="edit.outroAssetId"><option [ngValue]="null">None</option><option *ngFor="let a of images" [ngValue]="a.id">{{ a.title || ('Image #' + a.id) }}</option></select></label>
          <label>Outro length<select name="t-outs" [(ngModel)]="edit.outroSeconds"><option *ngFor="let s of cardSeconds" [ngValue]="s">{{ s }} s</option></select></label>
          <label>Background music<select name="t-mu" [(ngModel)]="edit.musicAssetId"><option [ngValue]="null">None</option><option *ngFor="let m of music" [ngValue]="m.id">{{ m.title || ('Track #' + m.id) }}</option></select></label>
          <label>Music volume<input type="range" name="t-mv" min="0" max="1" step="0.05" [(ngModel)]="edit.musicVolume" /></label>
          <label class="st-check"><input type="file" accept="audio/mpeg,.mp3" hidden #mp3 (change)="uploadMusic($event)" /><button type="button" class="st-chip" (click)="mp3.click()">⬆ Upload music (MP3)</button></label>
          <details class="wide st-more"><summary>Replace a scene</summary>
            <div class="st-grid">
              <label>From (seconds)<input type="number" name="t-rs" min="0" step="0.5" [(ngModel)]="edit.replaceStart" /></label>
              <label>To (seconds)<input type="number" name="t-re" min="0.5" step="0.5" [(ngModel)]="edit.replaceEnd" /></label>
              <label class="wide">With this clip<select name="t-rc" [(ngModel)]="edit.replaceAssetId"><option [ngValue]="null">Don't replace</option><option *ngFor="let v of videos" [ngValue]="v.id">{{ v.title || ('Video #' + v.id) }}{{ v.durationSeconds ? ' (' + v.durationSeconds + ' s)' : '' }}</option></select></label>
              <span class="st-muted wide">Tip: generate a new clip with “Video”, then choose it here. The original sound continues underneath.</span>
            </div>
          </details>
          <label class="wide">Subtitles (one line per caption)<textarea name="t-subs" rows="3" [(ngModel)]="edit.subtitles"></textarea></label>
          <label class="wide">New voice-over<textarea name="t-vo" rows="2" [(ngModel)]="edit.voiceOver" [disabled]="!caps?.voice?.available"></textarea><small class="st-muted" *ngIf="!caps?.voice?.available">{{ caps?.voice?.reason }}</small></label>
          <label *ngIf="edit.voiceOver">Original sound<select name="t-vm" [(ngModel)]="edit.voiceMode"><option value="mix">Keep it under the voice-over</option><option value="replace">Replace it with the voice-over</option></select></label>
          <div class="st-actions wide"><button type="button" class="btn btn-primary btn-sm" [disabled]="busy || !hasEdits()" (click)="editVideo(v.id)">Save edited copy</button><span class="st-muted">The original video is kept.</span></div>
        </div>
        <p class="st-muted" *ngIf="current.output?.srt">Subtitles {{ current.output.subtitlesMode === 'burned' ? 'are in the picture' : 'are a subtitle track (players show it; some platforms need a caption file)' }}. <button type="button" class="st-link" (click)="downloadSrt()">⬇ Download .srt</button></p>
      </details>
    </div>

    <!-- Platform posts -->
    <div class="st-posts" *ngIf="current.kind === 'text' && current.output?.posts">
      <article class="st-post" *ngFor="let p of current.output.posts; let i = index" [attr.data-platform]="p.platform">
        <header><b>{{ platformLabel(p.platform) }}</b><span class="st-muted">{{ p.suggested_format }} · best time {{ p.suggested_time || '—' }}</span></header>
        <ng-container *ngFor="let f of postFields">
          <label class="st-field">{{ f.label }}
            <span class="st-field-row">
              <textarea *ngIf="f.key !== 'hashtags'" [rows]="f.key === 'caption' || f.key === 'description' ? 4 : 1" [name]="'pf-' + i + f.key" [(ngModel)]="p[f.key]"></textarea>
              <input *ngIf="f.key === 'hashtags'" [name]="'pf-' + i + f.key" [ngModel]="tags(p)" (ngModelChange)="p.hashtags = splitTags($event)" />
              <button type="button" class="st-icon-btn" [disabled]="fieldBusy === i + f.key" (click)="regenField(p, f.key, i)" [title]="'Write a new ' + f.label.toLowerCase()" [attr.aria-label]="'Regenerate ' + f.label">↻</button>
            </span>
          </label>
        </ng-container>
        <div class="st-actions"><button type="button" class="btn btn-secondary btn-sm" [disabled]="saved[i]" (click)="saveDraft(p, i)">{{ saved[i] ? '✓ Saved as draft' : 'Save as draft post' }}</button></div>
      </article>
    </div>

    <!-- Carousel -->
    <div class="st-slides" *ngIf="current.kind === 'carousel' && current.output?.slides">
      <p class="st-muted">{{ current.output.caption }}</p>
      <ol>
        <li *ngFor="let s of current.output.slides; let i = index" class="st-slide">
          <img *ngIf="slideImage(s)" [src]="slideImage(s)" [alt]="s.title" />
          <div class="st-slide-text">
            <input [name]="'sl-t' + i" [(ngModel)]="s.title" maxlength="200" aria-label="Slide title" />
            <textarea [name]="'sl-b' + i" rows="2" [(ngModel)]="s.body" maxlength="1000" aria-label="Slide text"></textarea>
          </div>
          <span class="st-slide-move">
            <button type="button" class="st-icon-btn" [disabled]="i === 0" (click)="moveSlide(i, -1)" aria-label="Move up">↑</button>
            <button type="button" class="st-icon-btn" [disabled]="i === current.output.slides.length - 1" (click)="moveSlide(i, 1)" aria-label="Move down">↓</button>
          </span>
        </li>
      </ol>
      <div class="st-actions"><button type="button" class="btn btn-secondary btn-sm" (click)="saveSlides()" [disabled]="busy">Save slides</button><button type="button" class="btn btn-secondary btn-sm" (click)="openContent.emit(current.output.contentItemId)">Open the draft post</button></div>
    </div>
  </section>

  <!-- Recent generations -->
  <section class="st-card" *ngIf="recent.length">
    <div class="st-result-head"><b>Recent generations</b><button type="button" class="st-link" (click)="loadRecent()">Refresh</button></div>
    <ul class="st-recent">
      <li *ngFor="let g of recent">
        <button type="button" class="st-link" (click)="show(g)">{{ kindLabel(g) }} #{{ g.id }}</button>
        <span class="st-status" [attr.data-status]="g.status">{{ statusLabel(g) }}</span>
        <span class="st-muted">{{ g.createdAt | date:'MMM d, h:mm a' }}</span>
        <span class="st-muted" *ngIf="g.credits !== null">{{ g.credits }} cr</span>
        <button type="button" class="st-link" *ngIf="g.status === 'failed' && retryable(g)" (click)="retry(g)">Retry</button>
      </li>
    </ul>
  </section>

  <app-image-editor *ngIf="editing" [asset]="editing" [brandKit]="activeKit" (saved)="onEdited($event)" (closed)="editing = null"></app-image-editor>
</div>
`
})
export class StudioGeneratorComponent implements OnInit, OnDestroy {
  @Input() campaigns: any[] = [];
  @Input() startMode: Mode | null = null;
  /** In the campaign wizard: the campaign (its product is used on the server) and the planned post being made. */
  @Input() campaignId: number | null = null;
  @Input() contentItemId: number | null = null;
  /** Hides the page header and mode cards when the wizard shows its own tabs. */
  @Input() embedded = false;
  /** Fills the form from a planned idea (title, media prompt, platform); nothing starts until Generate. */
  @Input() set prefill(p: { mode: Mode; title?: string; prompt?: string; platform?: string; purpose?: string } | null) {
    if (!p) return;
    this.mode = p.mode;
    if (p.mode === 'poster') Object.assign(this.poster, { campaignName: p.title || this.poster.campaignName, prompt: p.prompt || '', purpose: p.purpose || this.poster.purpose, aspect: p.purpose === 'story' ? '9:16' : this.poster.aspect });
    if (p.mode === 'video') Object.assign(this.video, { title: p.title || this.video.title, prompt: p.prompt || this.video.prompt });
    if (p.mode === 'carousel') Object.assign(this.carousel, { topic: p.prompt || p.title || this.carousel.topic, platform: ['instagram', 'linkedin', 'facebook'].includes(p.platform || '') ? p.platform : this.carousel.platform });
    if (p.mode === 'post' && p.platform) this.post.pick = { [p.platform]: true };
  }
  @Output() toast = new EventEmitter<string>();
  @Output() openContent = new EventEmitter<number>();

  readonly modes: { key: Mode; label: string; hint: string; icon: string }[] = [
    { key: 'poster', label: 'Poster', hint: 'Offers, launches, festivals, events', icon: '🖼️' },
    { key: 'video', label: 'Video', hint: 'Reels, Shorts, promos, animated posters', icon: '🎬' },
    { key: 'post', label: 'Social post', hint: 'Captions, hashtags, CTA per platform', icon: '✍️' },
    { key: 'carousel', label: 'Carousel', hint: 'Multi-slide posts with one design', icon: '🎠' }
  ];
  readonly platforms = [{ key: 'facebook', label: 'Facebook', icon: '📘' }, { key: 'instagram', label: 'Instagram', icon: '📸' }, { key: 'linkedin', label: 'LinkedIn', icon: '💼' }, { key: 'youtube', label: 'YouTube', icon: '▶️' }];
  readonly purposes = [{ key: 'offer', label: 'Promotional offer' }, { key: 'product_ad', label: 'Product advertisement' }, { key: 'feature', label: 'Product feature' }, { key: 'story', label: 'Story (vertical 9:16)' }, { key: 'launch', label: 'Product launch' }, { key: 'event', label: 'Event announcement' }, { key: 'festival', label: 'Festival greeting' }, { key: 'seasonal', label: 'Seasonal campaign' }, { key: 'general', label: 'General post' }];
  readonly styles = ['modern', 'minimal', 'bold', 'elegant', 'playful', 'corporate', 'festive', 'photographic', 'illustrated'];
  readonly postFields = [{ key: 'title', label: 'Title' }, { key: 'caption', label: 'Caption' }, { key: 'description', label: 'Description' }, { key: 'hashtags', label: 'Hashtags' }, { key: 'call_to_action', label: 'Call to action' }];
  readonly variationOptions = [1, 2, 3, 4];
  readonly slideCounts = [3, 4, 5, 6, 7, 8, 10];

  mode: Mode = 'poster';
  caps: any = null;
  kits: any[] = [];
  brandKitId: number | null = null;
  usage: any = null;
  images: any[] = [];
  busy = false;
  error = '';
  estimate: any = null;
  confirmFor: { path: string; body: any; estimate: any } | null = null;
  current: Generation | null = null;
  recent: Generation[] = [];
  editing: any = null;
  fieldBusy = '';
  saved: Record<number, boolean> = {};
  edit: any = this.blankEdit();
  videos: any[] = [];
  music: any[] = [];
  readonly cardSeconds = [1, 1.5, 2, 3, 4, 5];
  private poll: any = null;
  private lastKey: Record<string, string> = {};

  poster: any = { campaignName: '', purpose: 'offer', style: 'modern', message: '', description: '', objective: '', audience: '', aspect: '1:1', variations: 2, language: 'English', prompt: '', referenceAssetIds: [] as number[], offer: '', cta: '', layout: 'auto', mood: 'auto', background: 'auto', useBrandColors: true, logoSpace: true, avoid: '' };
  video: any = { title: '', kind: 'reel', durationSeconds: 5, aspect: '9:16', prompt: '', audience: '', imageAssetId: null, language: 'English', voiceOver: '', subtitles: false, introAssetId: null, outroAssetId: null, musicAssetId: null, camera: 'auto', mood: 'auto', pace: 'auto', avoid: '' };
  post: any = { pick: { instagram: true, linkedin: true } as Record<string, boolean>, objective: '', message: '', audience: '', tone: '', language: 'English', campaignId: null, description: '', length: 'medium', emoji: 'few', hashtagCount: null, cta: '', link: '', keywords: '', avoid: '' };
  carousel: any = { topic: '', kind: 'features', slideCount: 5, platform: 'instagram', style: 'modern', withImages: false, audience: '', tone: '', wordsPerSlide: 30, cta: '' };

  /** One-click starting points: they fill the form; nothing starts until Generate. */
  readonly presets: Record<Mode, { label: string; values: any }[]> = {
    poster: [
      { label: '🏷️ Sale / offer', values: { purpose: 'offer', style: 'bold', mood: 'vibrant', layout: 'text_heavy', message: 'Limited-time offer', offer: '20% OFF', cta: 'Shop now' } },
      { label: '🚀 Product launch', values: { purpose: 'launch', style: 'modern', layout: 'product_focus', message: 'Introducing something new', cta: 'Learn more' } },
      { label: '🎉 Festival greeting', values: { purpose: 'festival', style: 'festive', mood: 'warm', layout: 'centered', message: 'Season\'s greetings', offer: '', cta: '' } },
      { label: '📅 Event / webinar', values: { purpose: 'event', style: 'corporate', layout: 'split', message: 'Join our live webinar', cta: 'Register free' } }
    ],
    video: [
      { label: '📱 Instagram Reel', values: { kind: 'reel', aspect: '9:16', camera: 'tracking', mood: 'energetic', pace: 'fast' } },
      { label: '▶️ YouTube Short', values: { kind: 'short', aspect: '9:16', mood: 'playful', pace: 'fast' } },
      { label: '🎞️ Product promo', values: { kind: 'product', aspect: '16:9', camera: 'orbit', mood: 'cinematic', pace: 'medium' } },
      { label: '✨ Animated poster', values: { kind: 'animated_poster', aspect: '1:1', camera: 'slow_zoom', mood: 'calm', pace: 'slow' } }
    ],
    post: [
      { label: '📣 Announcement', values: { objective: 'Awareness', length: 'short', emoji: 'few', cta: 'Learn more' } },
      { label: '💡 Helpful tip', values: { objective: 'Engagement', length: 'medium', emoji: 'few', tone: 'Helpful, expert' } },
      { label: '🏆 Customer success', values: { objective: 'Trust', length: 'long', emoji: 'none', tone: 'Professional' } },
      { label: '🛒 Promotion', values: { objective: 'Sales', length: 'short', emoji: 'many', cta: 'Shop now' } }
    ],
    carousel: [
      { label: '💡 5 quick tips', values: { kind: 'tips', slideCount: 5, cta: 'Follow for more tips' } },
      { label: '🧭 How it works', values: { kind: 'steps', slideCount: 5, cta: 'Book a demo' } },
      { label: '⭐ Feature tour', values: { kind: 'features', slideCount: 6, cta: 'Try it free' } },
      { label: '🏷️ Offer', values: { kind: 'promotion', slideCount: 4, cta: 'Claim the offer' } }
    ]
  };

  constructor(private studio: StudioApiService, private social: SocialApiService) {}

  ngOnInit(): void {
    if (this.startMode) this.mode = this.startMode;
    this.studio.capabilities().subscribe({ next: r => this.caps = r.capabilities, error: () => this.caps = {} });
    this.studio.brandKits().subscribe({ next: r => this.kits = r.brandKits || [], error: () => {} });
    this.loadUsage();
    this.loadRecent();
    this.social.media({ type: 'image', limit: 100 }).subscribe({ next: r => this.images = r.assets || r.items || [], error: () => {} });
  }
  ngOnDestroy(): void { clearTimeout(this.poll); }

  get activeKit(): any { return this.kits.find(k => k.id === this.brandKitId) || this.kits.find(k => k.isDefault) || null; }
  get modeLabel(): string { return { poster: 'poster', video: 'video', post: 'posts', carousel: 'carousel' }[this.mode]; }
  get imageAspects(): string[] { return this.caps?.image?.aspects || ['1:1', '4:5', '9:16', '16:9']; }
  get videoAspects(): string[] { return this.caps?.video?.aspects || ['9:16', '16:9', '1:1']; }
  get videoDurations(): number[] { return this.caps?.video?.durations || [5, 10]; }

  setMode(m: Mode): void {
    this.mode = m; this.error = ''; this.estimate = null;
    if (m === 'video' && this.caps?.videoEditing?.available && !this.music.length) this.loadVideoLibrary();
  }
  /** Brand product images first, then the rest of the library's images. */
  get referenceChoices(): any[] {
    const productIds: number[] = this.activeKit?.productAssetIds || [];
    return [...this.images].sort((a, b) => Number(productIds.includes(b.id)) - Number(productIds.includes(a.id))).slice(0, 40);
  }
  toggleRef(id: number): void {
    const list: number[] = this.poster.referenceAssetIds;
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else if (list.length < 4) list.push(id);
  }
  applyPreset(p: { label: string; values: any }): void {
    const target = ({ poster: this.poster, video: this.video, post: this.post, carousel: this.carousel } as any)[this.mode];
    Object.assign(target, p.values);
    this.toast.emit(`${p.label.replace(/^\S+\s/, '')}: settings filled in. Add your details, then Generate.`);
  }
  unavailable(m: Mode): boolean {
    if (!this.caps) return false;
    if (m === 'poster') return !this.caps.image?.available;
    if (m === 'video') return !this.caps.video?.available;
    return false;
  }
  unavailableReason(m: Mode): string { return (m === 'poster' ? this.caps?.image?.reason : this.caps?.video?.reason) || 'Not available.'; }
  aspectLabel(a: string): string { return ({ '1:1': 'Square 1:1 (feed)', '4:5': 'Portrait 4:5 (Instagram)', '9:16': 'Vertical 9:16 (Reels, Stories, Shorts)', '16:9': 'Landscape 16:9 (YouTube, LinkedIn)', '4:3': 'Landscape 4:3', '3:4': 'Portrait 3:4' } as any)[a] || a; }
  platformLabel(k: string): string { return this.platforms.find(p => p.key === k)?.label || k; }
  tags(p: any): string { return (p.hashtags || []).map((t: string) => `#${String(t).replace(/^#/, '')}`).join(' '); }
  splitTags(v: string): string[] { return String(v || '').split(/[\s,]+/).map(t => t.replace(/^#/, '')).filter(Boolean).slice(0, 30); }

  canStart(): boolean {
    if (this.mode === 'video') return !!this.video.title.trim() && this.video.prompt.trim().length >= 3;
    if (this.mode === 'post') return this.platforms.some(p => this.post.pick[p.key]);
    if (this.mode === 'carousel') return this.carousel.topic.trim().length >= 2;
    return true;
  }

  private request(): { path: string; body: any; kind: string } {
    const brandKitId = this.brandKitId;
    if (this.mode === 'poster') return { path: 'poster', kind: 'image', body: { ...this.poster, brandKitId } };
    if (this.mode === 'video') return { path: 'video', kind: 'video', body: { ...this.video, brandKitId } };
    if (this.mode === 'carousel') return { path: 'carousel', kind: 'carousel', body: { ...this.carousel, brandKitId } };
    const { pick, ...rest } = this.post;
    return { path: 'post', kind: 'text', body: { ...rest, platforms: this.platforms.filter(p => pick[p.key]).map(p => p.key), brandKitId } };
  }

  /** Estimate first; expensive generations wait for confirmation. */
  start(): void {
    if (!this.canStart() || this.busy) return;
    const r = this.request();
    this.error = '';
    this.busy = true;
    this.studio.estimate(r.kind, r.body).subscribe({
      next: e => {
        this.busy = false;
        this.estimate = e.estimate;
        if (e.estimate.needsConfirmation) this.confirmFor = { path: r.path, body: r.body, estimate: e.estimate };
        else this.send(r.path, r.body);
      },
      error: err => { this.busy = false; this.error = this.err(err); }
    });
  }
  confirmStart(): void {
    if (!this.confirmFor) return;
    const { path, body } = this.confirmFor;
    this.confirmFor = null;
    this.send(path, { ...body, confirm: true });
  }

  private send(path: string, body: any, sameKeyAs?: string): void {
    // A new click is a new request key; a confirmation of the same click reuses it.
    const key = sameKeyAs || requestKey();
    if (this.campaignId && !['video-edit', 'post-field'].includes(path)) body = { ...body, campaignId: this.campaignId, ...(this.contentItemId && path !== 'post' ? { contentItemId: this.contentItemId } : {}) };
    this.lastKey[path] = key;
    this.busy = true;
    this.studio.generate(path as any, { ...body, requestKey: key }).subscribe({
      next: r => { this.busy = false; this.saved = {}; this.show(r.generation); this.loadUsage(); this.loadRecent(); },
      error: err => {
        this.busy = false;
        if (err?.error?.code === 'CONFIRMATION_REQUIRED') { this.confirmFor = { path, body, estimate: err.error.details?.estimate || { credits: '?', costUsd: null } }; return; }
        this.error = this.err(err);
      }
    });
  }

  regenerateOne(): void {
    if (!this.current) return;
    this.send('poster', { ...this.current.input, finalPrompt: undefined, variations: 1, confirm: true });
  }

  show(g: Generation): void {
    this.current = g;
    this.edit = { ...this.blankEdit(), subtitles: (g.output?.subtitles || []).map((c: any) => c.text).join('\n') };
    if ((g.kind === 'video' || g.kind === 'video_edit') && g.status === 'completed' && this.caps?.videoEditing?.available && !this.videos.length) this.loadVideoLibrary();
    clearTimeout(this.poll);
    if (g.status === 'queued' || g.status === 'processing') this.follow(g.id, 0);
  }

  /** Follows a background generation until it is done (images: seconds; videos: minutes). */
  private follow(id: number, step: number): void {
    if (step > 400) return;
    this.poll = setTimeout(() => {
      this.studio.generation(id).subscribe({
        next: r => {
          if (this.current?.id !== id) return;
          this.current = r.generation;
          if (r.generation.status === 'queued' || r.generation.status === 'processing') this.follow(id, step + 1);
          else {
            if (r.generation.status === 'completed' && (r.generation.kind === 'video' || r.generation.kind === 'video_edit') && this.caps?.videoEditing?.available && !this.videos.length) this.loadVideoLibrary();
            this.loadUsage(); this.loadRecent();
            this.toast.emit(r.generation.status === 'completed' ? `${this.kindLabel(r.generation)} ready.` : `${this.kindLabel(r.generation)} failed.`);
          }
        },
        error: () => this.follow(id, step + 1)
      });
    }, POLL_MS);
  }

  retryable(g: Generation): boolean { return ['image', 'video', 'carousel', 'video_edit'].includes(g.kind); }
  retry(g: Generation): void {
    this.studio.retry(g.id).subscribe({ next: r => { this.show(r.generation); this.loadRecent(); }, error: err => this.error = this.err(err) });
  }

  skeletonCount(g: Generation): number[] {
    const n = g.kind === 'image' ? (g.input?.variations || 1) : g.kind === 'carousel' ? (g.input?.slideCount || 3) : 1;
    return Array.from({ length: Math.min(6, n) }, (_, i) => i);
  }
  imageAssets(g: Generation): any[] { return (g.assets || []).filter(a => a.type === 'image' && a.url); }
  videoAsset(g: Generation): any { const v = (g.assets || []).filter(a => a.type === 'video' && a.url); return v[v.length - 1] || null; }
  slideImage(s: any): string | null { return this.current?.assets?.find(a => a.id === s.assetId)?.url || null; }
  kindLabel(g: Generation): string { return ({ image: 'Poster', video: 'Video', text: g.purpose === 'post_field' ? 'Post field' : 'Social posts', carousel: 'Carousel', plan: 'Campaign plan', video_edit: 'Video edit' } as any)[g.kind] || g.kind; }
  statusLabel(g: Generation): string {
    if (g.status === 'processing' && g.output?.progress) return `Processing ${Math.round(g.output.progress * 100)}%`;
    return ({ queued: 'Queued', processing: 'Processing', completed: 'Completed', failed: 'Failed' } as any)[g.status] || g.status;
  }

  regenField(p: any, field: string, i: number): void {
    this.fieldBusy = i + field;
    this.studio.generate('post-field', { requestKey: requestKey(), field, post: p, brandKitId: this.brandKitId }).subscribe({
      next: r => { this.fieldBusy = ''; if (r.generation.status === 'completed') p[field] = r.generation.output.value; this.saved[i] = false; this.loadUsage(); },
      error: err => { this.fieldBusy = ''; this.error = this.err(err); }
    });
  }

  saveDraft(p: any, i: number): void {
    this.social.createContent({
      platformKey: p.platform, title: p.title || null, caption: p.platform === 'youtube' && p.description ? p.description : p.caption, hashtags: p.hashtags || [],
      callToAction: p.call_to_action || null, campaignId: this.current?.input?.campaignId || null, format: 'post'
    }).subscribe({ next: () => { this.saved[i] = true; this.toast.emit('Saved as a draft post.'); }, error: err => this.error = this.err(err) });
  }

  moveSlide(i: number, d: number): void {
    const s = this.current!.output.slides;
    [s[i], s[i + d]] = [s[i + d], s[i]];
  }
  saveSlides(): void {
    const id = this.current?.output?.contentItemId;
    if (!id) return;
    this.busy = true;
    const slides = this.current!.output.slides.map((s: any) => ({ title: s.title, body: s.body, imagePrompt: s.imagePrompt || null, assetId: s.assetId || null }));
    this.social.updateContent(id, { slides, mediaAssetIds: slides.map((s: any) => s.assetId).filter(Boolean), title: slides[0]?.title || null, changeNote: 'Carousel slides edited' }).subscribe({
      next: () => { this.busy = false; this.toast.emit('Slides saved.'); },
      error: err => { this.busy = false; this.error = this.err(err); }
    });
  }

  blankEdit(): any { return { start: null, end: null, subtitles: '', voiceOver: '', voiceMode: 'mix', introAssetId: null, introSeconds: 2, outroAssetId: null, outroSeconds: 2, musicAssetId: null, musicVolume: 0.3, replaceStart: null, replaceEnd: null, replaceAssetId: null }; }
  hasEdits(): boolean { const e = this.edit; return e.start != null || e.end != null || !!String(e.subtitles || '').trim() || !!e.voiceOver || !!e.introAssetId || !!e.outroAssetId || !!e.musicAssetId || !!e.replaceAssetId; }

  editVideo(assetId: number): void {
    const e = this.edit;
    const lines = String(e.subtitles || '').split('\n').map((s: string) => s.trim()).filter(Boolean);
    const dur = Math.max(1, (e.end ?? this.current?.input?.durationSeconds ?? 5) - (e.start ?? 0));
    const subtitles = lines.map((text: string, i: number) => ({ start: Math.round((i * dur / lines.length) * 100) / 100, end: Math.round(((i + 1) * dur / lines.length) * 100) / 100, text }));
    const replace = e.replaceAssetId ? { start: Number(e.replaceStart) || 0, end: Number(e.replaceEnd) || dur, assetId: e.replaceAssetId } : null;
    this.send('video-edit', { assetId, start: e.start, end: e.end, subtitles, voiceOver: e.voiceOver || '', voiceMode: e.voiceMode,
      introAssetId: e.introAssetId, introSeconds: e.introSeconds, outroAssetId: e.outroAssetId, outroSeconds: e.outroSeconds,
      musicAssetId: e.musicAssetId, musicVolume: Number(e.musicVolume), replace, confirm: true });
  }

  loadVideoLibrary(): void {
    this.social.media({ type: 'video', limit: 100 }).subscribe({ next: r => this.videos = r.items || [], error: () => {} });
    this.social.media({ type: 'audio', limit: 100 }).subscribe({ next: r => this.music = r.items || [], error: () => {} });
  }
  uploadMusic(ev: Event): void {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.studio.uploadMusic(file, file.name).subscribe({
      next: r => { this.music = [r.asset, ...this.music]; this.edit.musicAssetId = r.asset.id; this.toast.emit('Music added.'); },
      error: err => this.error = this.err(err)
    });
  }
  downloadSrt(): void {
    const srt = this.current?.output?.srt;
    if (!srt) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip' })); a.download = 'subtitles.srt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  onEdited(asset: any): void { this.editing = null; this.toast.emit('Edited copy saved to the Content Library (the original is kept).'); this.images = [asset, ...this.images]; }

  loadUsage(): void { this.studio.usage().subscribe({ next: r => this.usage = r.usage, error: () => {} }); }
  loadRecent(): void { this.studio.generations({}).subscribe({ next: r => this.recent = (r.generations || []).slice(0, 10), error: () => {} }); }
  private err(e: any): string { return e?.error?.error || e?.message || 'Something went wrong.'; }
}
