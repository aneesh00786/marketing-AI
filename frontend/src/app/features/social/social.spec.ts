import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MediaLibraryComponent } from './media-library.component';
import { PostComposerComponent } from './post-composer.component';
import { SocialHubComponent } from './social-hub.component';
import { AuthStateService } from '../../core/auth-state.service';
import { apiRoot } from '../../core/api-base';

const BASE = `${apiRoot()}/api/v1/social`;
const IMG = { id: 11, assetType: 'image', source: 'upload', verified: true, previewPath: '/api/v1/social/media-files/abc', mimeType: 'image/jpeg', width: 1080, height: 1080, sizeBytes: 2048, usedBy: [], activeUseCount: 0 };
const VID = { id: 12, assetType: 'video', source: 'upload', verified: true, previewPath: '/api/v1/social/media-files/def', mimeType: 'video/mp4', width: 1080, height: 1920, durationSeconds: 12, videoCodec: 'h264', frameRate: 30, hasAudio: true, audioCodec: 'aac', sizeBytes: 900000, usedBy: [{ id: 3, status: 'scheduled' }], activeUseCount: 1 };

function mediaList(http: HttpTestingController, items: any[] = [IMG, VID]): void {
  http.expectOne(r => r.url === `${BASE}/media`).flush({ items, storage: { usedBytes: 1, quotaBytes: 100 }, limits: { imageBytes: 8388608, videoBytes: 524288000 }, publicFetchProblem: null });
}

describe('MediaLibraryComponent', () => {
  let fixture: ComponentFixture<MediaLibraryComponent>;
  let comp: MediaLibraryComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MediaLibraryComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MediaLibraryComponent);
    comp = fixture.componentInstance;
  });
  afterEach(() => http.verify());

  it('uploads the file as the raw body with its name, shows progress, and reports server rejections', () => {
    fixture.detectChanges();
    mediaList(http);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input[type=file]') as HTMLInputElement;
    expect(getComputedStyle(input).display).not.toBe('none');
    expect(input.accept).toContain('.mp4');
    expect(input.multiple).toBeTrue();

    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0])], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    const req = http.expectOne(r => r.url === `${BASE}/media/upload`);
    expect(req.request.params.get('filename')).toBe('photo.jpg');
    expect(req.request.body).toBe(file);
    req.event({ type: 1, loaded: 2, total: 4 } as any);
    expect(comp.uploads[0].progress).toBe(50);
    req.flush({ success: false, error: 'This file cannot be used: content is not a valid JPEG.', code: 'INVALID_MEDIA' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('content is not a valid JPEG');
  });

  it('refuses oversized files before uploading', () => {
    fixture.detectChanges();
    mediaList(http);
    const big = new File([new Uint8Array(10)], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 9 * 1048576 });
    comp.onFiles({ target: { files: [big], value: '' } } as any);
    http.expectNone(`${BASE}/media/upload`);
    expect(comp.uploads[0].status).toBe('error');
  });

  it('in pick mode, selection order is the attachment order', () => {
    comp.mode = 'pick';
    const picked: number[][] = [];
    comp.selectedChange.subscribe(v => picked.push(v));
    fixture.detectChanges();
    mediaList(http);
    fixture.detectChanges();
    const tiles = fixture.nativeElement.querySelectorAll('.tile');
    (tiles[1] as HTMLElement).click();
    (tiles[0] as HTMLElement).click();
    expect(picked[picked.length - 1]).toEqual([12, 11]);
    fixture.detectChanges();
    expect(tiles[1].querySelector('.order').textContent.trim()).toBe('1');
  });

  it('shows probed video facts and blocks deleting a file used by unpublished posts', () => {
    fixture.detectChanges();
    mediaList(http);
    comp.open(VID);
    http.expectOne(`${BASE}/media/12`).flush({ asset: VID, thumbnail: null });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('1080×1920');
    expect(text).toContain('0:12');
    expect(text).toContain('H264');
    const del = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b => b.textContent!.trim() === 'Delete')!;
    expect(del.disabled).toBeTrue();
  });
});

describe('PostComposerComponent', () => {
  let fixture: ComponentFixture<PostComposerComponent>;
  let comp: PostComposerComponent;
  let http: HttpTestingController;
  const KEY = 'mkt_social_composer_5_9';
  const accounts = [
    { id: 1, platformKey: 'linkedin', displayName: 'Acme LinkedIn', accountType: 'linkedin_organization', status: 'connected' },
    { id: 2, platformKey: 'instagram', displayName: 'Acme IG', accountType: 'instagram_business', status: 'connected' }
  ];

  beforeEach(() => {
    localStorage.removeItem(KEY);
    TestBed.configureTestingModule({
      imports: [PostComposerComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AuthStateService, useValue: { workspace: { id: 5 }, user: { id: 9 } } }]
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PostComposerComponent);
    comp = fixture.componentInstance;
    comp.accounts = accounts;
  });
  afterEach(() => { http.verify(); localStorage.removeItem(KEY); });

  function start(): void {
    fixture.detectChanges();
    http.expectOne(`${BASE}/templates`).flush({ templates: [] });
    mediaList(http);
  }

  it('sends shared content once plus only the fields customised per account, never shortening text', () => {
    start();
    comp.toggleTarget(comp.targets[0]);
    comp.toggleTarget(comp.targets[1]);
    const long = 'x'.repeat(2500);
    comp.base.caption = long;
    comp.base.linkUrl = 'https://acme.test';
    comp.customize('a2', 'linkUrl');
    comp.overrides['a2'].linkUrl = '';
    const p = comp.payload();
    expect(p.base.caption).toBe(long);
    expect(p.targets).toEqual([{ accountId: 1 }, { accountId: 2, linkUrl: null }]);
  });

  it('shows the server validation for each account', () => {
    start();
    comp.toggleTarget(comp.targets[1]);
    comp.validate();
    http.expectOne(`${BASE}/content/validate`).flush({ results: [{ problems: ['Instagram Professional account requires at least one image or video.'], warnings: [], characters: 0 }] });
    fixture.detectChanges();
    expect(comp.problemCount()).toBe(1);
    expect(fixture.nativeElement.textContent).toContain('requires at least one image or video');
  });

  it('creates the drafts, then forgets the locally saved copy', () => {
    start();
    comp.toggleTarget(comp.targets[0]);
    comp.base.caption = 'Hello';
    (comp as any).saveLocal();
    expect(localStorage.getItem(KEY)).toContain('Hello');
    const created: any[] = [];
    comp.created.subscribe(r => created.push(r));
    comp.create();
    const req = http.expectOne(`${BASE}/content/compose`);
    expect(req.request.body.targets).toEqual([{ accountId: 1 }]);
    req.flush({ postGroupId: 'g', items: [{ content: { id: 5 }, validation: { problems: [] } }] });
    expect(created.length).toBe(1);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('offers to restore an unsaved post for the same user and workspace only', () => {
    localStorage.setItem(KEY, JSON.stringify({ savedAt: '2026-10-20T10:00:00Z', state: { base: { caption: 'Draft text', mediaAssetIds: [] }, selectedKeys: ['a1'], overrides: {} } }));
    localStorage.setItem('mkt_social_composer_6_9', JSON.stringify({ savedAt: 'x', state: { base: { caption: 'Other workspace' } } }));
    start();
    expect(comp.restoreOffer).toBeTruthy();
    comp.restore();
    expect(comp.base.caption).toBe('Draft text');
    expect(comp.selectedKeys).toEqual(['a1']);
    localStorage.removeItem('mkt_social_composer_6_9');
  });

  it('AI suggestions are only applied on request and are flagged, not trimmed, when too long', () => {
    start();
    comp.toggleTarget(comp.targets[0]);
    comp.runAi('caption');
    const req = http.expectOne(`${BASE}/ai/assist`);
    expect(req.request.body.platforms).toEqual(['linkedin']);
    const tooLong = 'y'.repeat(3100);
    req.flush({ mode: 'caption', provider: 'groq', notes: [], suggestions: [{ platform: 'linkedin', caption: tooLong, hashtags: ['#a'], callToAction: '', characters: 3103, overLimit: true, unverified: ['50%'] }] });
    fixture.detectChanges();
    expect(comp.base.caption).toBe('', 'nothing applied automatically');
    expect(fixture.nativeElement.textContent).toContain('too long, edit before use');
    expect(fixture.nativeElement.textContent).toContain('not in your product facts: 50%');
    comp.applyCaptionVariant(comp.ai.result.suggestions[0]);
    expect(comp.base.caption).toBe(tooLong);
  });
});

describe('SocialHubComponent', () => {
  let fixture: ComponentFixture<SocialHubComponent>;
  let comp: SocialHubComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SocialHubComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(SocialHubComponent);
    comp = fixture.componentInstance;
    comp.initialSection = 'queue';
    fixture.detectChanges();
    for (const p of ['settings', 'accounts', 'campaigns', 'products', 'members', 'capabilities']) http.expectOne(`${BASE}/${p}`).flush({ settings: { timezone: 'Asia/Kolkata', requireApproval: true }, accounts: [], campaigns: [], products: [], members: [], registry: null });
    http.expectOne(r => r.url === `${BASE}/queue`).flush({ jobs: [] });
  });
  afterEach(() => http.verify());

  it('opening a post by id fills the edit form from the server (no blank save)', () => {
    comp.openContentById(42);
    http.expectOne(r => r.url === `${BASE}/content`).flush({ items: [] });
    http.match(r => r.url === `${BASE}/assets`).forEach(r => r.flush({ assets: [] }));
    http.expectOne(`${BASE}/content/42`).flush({ content: { id: 42, caption: 'Real caption', hashtags: ['#a'], platformKey: 'facebook', status: 'approved', mediaAssetIds: [], version: 3 }, versions: [], approvals: [], publishingJobs: [], assets: [], siblings: [], validation: { problems: [], warnings: [] } });
    expect(comp.editorDraft.caption).toBe('Real caption');
    expect(comp.editorDraft.hashtagsText).toBe('#a');
    fixture.detectChanges();
    http.match(r => r.url === `${BASE}/media`).forEach(r => r.flush({ items: [], storage: null, limits: null }));
  });

  it('dragging a scheduled post to another day reschedules it at the same local time', () => {
    spyOn(window, 'confirm').and.returnValue(true);
    comp.settings = { timezone: 'Asia/Kolkata' };
    const item = { id: 7, status: 'scheduled', socialAccountId: 3, platformKey: 'facebook', scheduledAt: '2026-11-03T04:30:00Z', scheduleTimezone: 'Asia/Kolkata', title: 'Launch' };
    comp.onDragStart({ dataTransfer: { setData: () => {} }, preventDefault: () => {} } as any, item);
    comp.onDrop({ preventDefault: () => {} } as any, new Date(2026, 10, 5));
    const req = http.expectOne(`${BASE}/content/7/schedule`);
    expect(req.request.body).toEqual({ accountId: 3, localDateTime: '2026-11-05T10:00', timezone: 'Asia/Kolkata' });
    req.flush({ job: { scheduledFor: '2026-11-05T04:30:00Z', scheduleTimezone: 'Asia/Kolkata' } });
    http.expectOne(r => r.url === `${BASE}/calendar`).flush({ items: [] });
  });

  it('shows platform processing as its own state, with the platform note, not as published', () => {
    comp.loadQueue();
    http.expectOne(r => r.url === `${BASE}/queue`).flush({ jobs: [{ id: 1, contentItemId: 2, contentTitle: 'Promo', status: 'processing', attemptCount: 1, maxAttempts: 3, note: 'YouTube set this video to private (you asked for public).' }] });
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('processing on platform');
    expect(text).toContain('YouTube set this video to private');
    const retry = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).filter(b => ['Retry', 'Cancel'].includes(b.textContent!.trim()));
    expect(retry.length).toBe(0, 'a processing upload cannot be retried or cancelled from here');
  });

  it('drafts cannot be dragged on the calendar', () => {
    expect(comp.canDrag({ status: 'draft', socialAccountId: 3, platformKey: 'facebook' })).toBeFalse();
    expect(comp.canDrag({ status: 'approved', socialAccountId: 3, platformKey: 'facebook' })).toBeTrue();
  });

  it('shows watch time with units and unavailable metrics as text, never as zero', () => {
    expect(comp.metricDisplay('avg_watch_time', { value: 12.5, availability: 'available' })).toBe('12.5 s');
    expect(comp.metricDisplay('likes', { value: null, availability: 'unavailable' })).toBe('Unavailable');
    expect(comp.metricDisplay('likes', { value: 0, availability: 'available' })).toBe('0');
  });
});
