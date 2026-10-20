import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiRoot } from '../../core/api-base';

/** Client for /api/v1/command (Campaign Command Center). Authorization is attached by the auth interceptor. */
@Injectable({ providedIn: 'root' })
export class CommandApiService {
  private base = `${apiRoot()}/api/v1/command`;

  constructor(private http: HttpClient) {}

  meta(): Observable<any> { return this.http.get(`${this.base}/meta`); }
  programs(): Observable<any> { return this.http.get(`${this.base}/programs`); }
  program(id: number): Observable<any> { return this.http.get(`${this.base}/programs/${id}`); }
  create(body: any): Observable<any> { return this.http.post(`${this.base}/programs`, body); }
  update(id: number, body: any): Observable<any> { return this.http.patch(`${this.base}/programs/${id}`, body); }
  remove(id: number): Observable<any> { return this.http.delete(`${this.base}/programs/${id}`); }
  archive(id: number): Observable<any> { return this.http.post(`${this.base}/programs/${id}/archive`, {}); }

  generateBrief(id: number): Observable<any> { return this.http.post(`${this.base}/programs/${id}/brief`, {}); }
  saveBrief(id: number, brief: any): Observable<any> { return this.http.put(`${this.base}/programs/${id}/brief`, { brief }); }
  approveBrief(id: number, acknowledgeFlags: boolean): Observable<any> { return this.http.post(`${this.base}/programs/${id}/brief/approve`, { confirm: true, acknowledgeFlags }); }

  previewAudience(id: number, filter: any): Observable<any> { return this.http.post(`${this.base}/programs/${id}/audience/preview`, { filter }); }
  saveAudience(id: number, leadIds: number[], filter: any): Observable<any> { return this.http.put(`${this.base}/programs/${id}/audience`, { leadIds, filter }); }

  build(id: number): Observable<any> { return this.http.post(`${this.base}/programs/${id}/build`, { confirm: true }); }
  overview(id: number): Observable<any> { return this.http.get(`${this.base}/programs/${id}/overview`); }

  products(): Observable<any> { return this.http.get(`${apiRoot()}/api/v1/products`); }
  leadStatuses(): Observable<any> { return this.http.get(`${apiRoot()}/api/v1/leads`, { params: { limit: '1' } }); }
}
