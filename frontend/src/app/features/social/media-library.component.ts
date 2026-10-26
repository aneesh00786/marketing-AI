import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpEventType } from '@angular/common/http';
import { SocialApiService } from './social-api.service';
import { apiRoot } from '../../core/api-base';

interface UploadRow { name: string; size: number; progress: number; status: 'uploading' | 'thumbnail' | 'done' | 'error'; error?: string; }

/**
 * Social media library. "manage" mode is the Media Library section; "pick" mode is used inside
 * the composer and post editor to attach files (selection order = attachment order).
 * Files are validated on the server by content; this component only reports what it says.
 */
@Component({
  selector: 'app-media-library',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './media-library.component.html',
  styleUrls: ['./social-shared.css', './media-library.component.css']
})
export class MediaLibraryComponent implements OnInit {
  @Input() mode: 'manage' | 'pick' = 'manage';
  @Input() selected: number[] = [];
  @Input() canEdit = true;
  @Output() selectedChange = new EventEmitter<number[]>();
  @Output() assetsLoaded = new EventEmitter<any[]>();
  @Output() toast = new EventEmitter<string>();

  items: any[] = [];
  storage: any = null;
  limits: any = null;
  publicFetchProblem: string | null = null;
  filter: 'all' | 'image' | 'video' | 'unused' = 'all';
  q = '';
  loading = false;
  uploads: UploadRow[] = [];
  active: any = null;
  activeThumb: any = null;
  altDraft = '';
  titleDraft = '';
  error: string | null = null;

  constructor(private api: SocialApiService) {}

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading = true;
    const f = this.filter;
    this.api.media({ type: f === 'image' || f === 'video' ? f : null, unused: f === 'unused' ? 1 : null, q: this.q || null, limit: 200 }).subscribe({
      next: r => {
        this.items = r.items;
        this.storage = r.storage;
        this.limits = r.limits;
        this.publicFetchProblem = r.publicFetchProblem;
        this.loading = false;
        this.assetsLoaded.emit(this.items);
      },
      error: e => { this.loading = false; this.error = e?.error?.error || 'Could not load media.'; }
    });
  }

  src(a: any): string | null {
    if (!a) return null;
    return a.previewPath ? `${apiRoot()}${a.previewPath}` : a.url;
  }

  thumbSrc(a: any): string | null {
    if (a.assetType === 'image') return this.src(a);
    return a.thumbnailPreviewPath ? `${apiRoot()}${a.thumbnailPreviewPath}` : null;
  }

  size(bytes: number | null): string {
    if (bytes === null || bytes === undefined) return 'size unknown';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  duration(s: number | null): string {
    if (s === null || s === undefined) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  }

  facts(a: any): string {
    const parts = [String(a.format || a.mimeType || '').toUpperCase().replace(/^(IMAGE|VIDEO)\//, '')];
    if (a.width && a.height) parts.push(`${a.width}×${a.height}`);
    if (a.assetType === 'video') {
      if (a.durationSeconds !== null) parts.push(this.duration(a.durationSeconds));
      if (a.videoCodec) parts.push(a.videoCodec.toUpperCase());
      if (a.frameRate) parts.push(`${a.frameRate} fps`);
      parts.push(a.hasAudio === false ? 'no audio' : (a.audioCodec ? `${a.audioCodec.toUpperCase()} audio` : ''));
    }
    parts.push(this.size(a.sizeBytes));
    return parts.filter(Boolean).join(' · ');
  }

  isSelected(a: any): boolean { return this.selected.includes(a.id); }
  order(a: any): number { return this.selected.indexOf(a.id) + 1; }

  toggle(a: any): void {
    if (this.mode !== 'pick' || !this.canEdit) { this.open(a); return; }
    const next = this.isSelected(a) ? this.selected.filter(id => id !== a.id) : [...this.selected, a.id];
    this.selected = next;
    this.selectedChange.emit(next);
  }

  // ---------- Upload ----------
  onFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    for (const file of files) this.uploadOne(file);
  }

  private uploadOne(file: File): void {
    const row: UploadRow = { name: file.name, size: file.size, progress: 0, status: 'uploading' };
    this.uploads = [row, ...this.uploads].slice(0, 12);
    const max = file.type.startsWith('video/') ? this.limits?.videoBytes : this.limits?.imageBytes;
    if (max && file.size > max) {
      row.status = 'error';
      row.error = `Larger than the ${Math.round(max / 1048576)} MB limit.`;
      return;
    }
    this.api.uploadMedia(file, file.name).subscribe({
      next: ev => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) row.progress = Math.round((ev.loaded / ev.total) * 100);
        if (ev.type === HttpEventType.Response) {
          const asset = (ev.body as any).asset;
          row.progress = 100;
          if (asset.assetType === 'video' && file.type.startsWith('video/')) {
            row.status = 'thumbnail';
            this.makeThumbnail(file).then(blob => {
              if (!blob) { row.status = 'done'; this.afterUpload(asset); return; }
              this.api.uploadMedia(blob, `${file.name}.thumbnail.jpg`, { thumbnailFor: asset.id }).subscribe({
                next: e2 => { if (e2.type === HttpEventType.Response) { row.status = 'done'; this.afterUpload(asset); } },
                error: () => { row.status = 'done'; this.afterUpload(asset); }
              });
            });
          } else {
            row.status = 'done';
            this.afterUpload(asset);
          }
        }
      },
      error: e => { row.status = 'error'; row.error = e?.error?.error || 'Upload failed.'; }
    });
  }

  private afterUpload(asset: any): void {
    this.load();
    if (this.mode === 'pick' && this.canEdit) {
      this.selected = [...this.selected, asset.id];
      this.selectedChange.emit(this.selected);
    }
  }

  /** Captures a frame about one second in (or the first frame) as a JPEG, in the browser. */
  makeThumbnail(file: File): Promise<Blob | null> {
    return new Promise(resolve => {
      let done = false;
      const finish = (b: Blob | null) => { if (!done) { done = true; URL.revokeObjectURL(url); resolve(b); } };
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = url;
      const timer = setTimeout(() => finish(null), 15000);
      video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 0) / 2); };
      video.onseeked = () => {
        try {
          const scale = Math.min(1, 1080 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(b => { clearTimeout(timer); finish(b); }, 'image/jpeg', 0.85);
        } catch {
          clearTimeout(timer);
          finish(null);
        }
      };
      video.onerror = () => { clearTimeout(timer); finish(null); };
    });
  }

  // ---------- Details ----------
  open(a: any): void {
    this.api.mediaDetail(a.id).subscribe({
      next: r => { this.active = r.asset; this.activeThumb = r.thumbnail; this.altDraft = r.asset.altText || ''; this.titleDraft = r.asset.title || ''; },
      error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Could not open the file.'}`)
    });
  }

  saveDetails(): void {
    const altChanged = this.altDraft !== (this.active.altText || '');
    if (altChanged && this.active.usedBy?.some((u: any) => ['review', 'approved', 'scheduled'].includes(u.status))
      && !confirm('This file is in posts that are approved or waiting for approval. Changing its alt text creates a new version of those posts and they need approval again. Continue?')) return;
    this.api.updateMedia(this.active.id, { title: this.titleDraft, altText: this.altDraft }).subscribe({
      next: r => {
        this.active = r.asset;
        this.toast.emit(r.approvalsReopened?.length ? `Saved. ${r.approvalsReopened.length} post(s) need approval again.` : 'Saved.');
        this.load();
      },
      error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Save failed.'}`)
    });
  }

  replace(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.active) return;
    const pending = this.active.usedBy?.filter((u: any) => !['published', 'cancelled'].includes(u.status)).length || 0;
    if (!confirm(`Replace "${this.active.originalName || this.active.title || 'this file'}"?${pending ? ` ${pending} unpublished post(s) will use the new file and need approval again.` : ''} Published posts are not changed.`)) return;
    this.api.uploadMedia(file, file.name, { replaceId: this.active.id }).subscribe({
      next: ev2 => {
        if (ev2.type === HttpEventType.Response) {
          const r: any = ev2.body;
          this.toast.emit(`Replaced. ${r.revisedPosts?.length || 0} post(s) updated.`);
          this.active = r.asset;
          this.load();
        }
      },
      error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Replace failed.'}`)
    });
  }

  remove(): void {
    if (!confirm('Delete this file from the media library? This cannot be undone.')) return;
    this.api.deleteMedia(this.active.id).subscribe({
      next: () => {
        this.toast.emit('Deleted.');
        this.selected = this.selected.filter(id => id !== this.active.id);
        this.selectedChange.emit(this.selected);
        this.active = null;
        this.load();
      },
      error: e => this.toast.emit(`⚠️ ${e?.error?.error || 'Delete failed.'}`)
    });
  }

  usagePercent(): number {
    if (!this.storage?.quotaBytes) return 0;
    return Math.min(100, Math.round((this.storage.usedBytes / this.storage.quotaBytes) * 100));
  }
}
