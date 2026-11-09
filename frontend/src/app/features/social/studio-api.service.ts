import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiRoot } from '../../core/api-base';

/** One key per click: a repeated click or retry returns the same generation (never a second charge). */
export function requestKey(): string {
  const r = (globalThis.crypto as any)?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ui-${String(r).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 80);
}

export interface Generation {
  id: number; kind: string; purpose: string | null; status: 'queued' | 'processing' | 'completed' | 'failed';
  provider: string | null; model: string | null; input: any; output: any;
  assets: { id: number; url: string | null; type: string; width?: number; height?: number; edited?: boolean; slide?: number }[];
  error: string | null; errorCode: string | null; estimatedCredits: number | null; credits: number | null; costUsd: number | null;
  attempts: number; campaignId: number | null; contentItemId: number | null; createdAt: string; completedAt: string | null;
}

/** Client for /api/v1/social/studio (AI Content Studio). */
@Injectable({ providedIn: 'root' })
export class StudioApiService {
  readonly base = `${apiRoot()}/api/v1/social/studio`;
  constructor(private http: HttpClient) {}

  capabilities(): Observable<any> { return this.http.get(`${this.base}/capabilities`); }
  brandKits(): Observable<any> { return this.http.get(`${this.base}/brand-kits`); }
  saveBrandKit(id: number | null, body: any): Observable<any> { return id ? this.http.put(`${this.base}/brand-kits/${id}`, body) : this.http.post(`${this.base}/brand-kits`, body); }
  deleteBrandKit(id: number): Observable<any> { return this.http.delete(`${this.base}/brand-kits/${id}`); }
  estimate(kind: string, input: any): Observable<any> { return this.http.post(`${this.base}/estimate`, { kind, input }); }
  generate(path: 'post' | 'post-field' | 'poster' | 'carousel' | 'video' | 'video-edit', body: any): Observable<any> { return this.http.post(`${this.base}/ai/${path}`, body); }
  plan(body: any): Observable<any> { return this.http.post(`${this.base}/planner`, body); }
  generations(filters: { kind?: string; status?: string; campaignId?: number } = {}): Observable<any> {
    const q = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
    return this.http.get(`${this.base}/generations${q ? `?${q}` : ''}`);
  }
  generation(id: number): Observable<any> { return this.http.get(`${this.base}/generations/${id}`); }
  retry(id: number): Observable<any> { return this.http.post(`${this.base}/generations/${id}/retry`, {}); }
  saveEdited(assetId: number, png: Blob, title: string): Observable<any> {
    return this.http.post(`${this.base}/media/${assetId}/edited?title=${encodeURIComponent(title)}`, png, { headers: { 'Content-Type': 'image/png' } });
  }
  usage(): Observable<any> { return this.http.get(`${this.base}/usage`); }
  // Product campaign workflow
  campaignOverview(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}/overview`); }
  strategy(id: number, body: { requestKey: string; instruction?: string }): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/strategy`, body); }
  saveStrategy(id: number, body: any): Observable<any> { return this.http.put(`${this.base}/campaigns/${id}/strategy`, body); }
  acceptStrategy(id: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/strategy/accept`, {}); }
  regenerateIdea(id: number, ideaId: string, body: { requestKey: string; instruction?: string }): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/strategy/items/${encodeURIComponent(ideaId)}/regenerate`, body); }
  // Generate All Content
  bulkEstimate(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}/bulk/estimate`); }
  bulkStart(id: number, confirm: boolean): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/bulk`, { confirm }); }
  bulkStatus(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}/bulk`); }
  bulkCancel(id: number, itemId: number | null = null): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/bulk/cancel`, itemId ? { itemId } : {}); }
  bulkRetry(id: number, itemId: number): Observable<any> { return this.http.post(`${this.base}/campaigns/${id}/bulk/items/${itemId}/retry`, {}); }
  history(contentId: number): Observable<any> { return this.http.get(`${this.base}/content/${contentId}/generations`); }
  campaignAnalytics(id: number): Observable<any> { return this.http.get(`${this.base}/campaigns/${id}/analytics`); }
  replaceBackground(body: { assetId: number; background: string; requestKey: string; confirm?: boolean }): Observable<any> { return this.http.post(`${this.base}/ai/background`, body); }
  uploadMusic(file: Blob, filename: string): Observable<any> {
    return this.http.post(`${this.base}/music?filename=${encodeURIComponent(filename)}`, file, { headers: { 'Content-Type': 'audio/mpeg' } });
  }
}
