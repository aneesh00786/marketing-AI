import { ComponentFixture, TestBed, discardPeriodicTasks, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { StudioGeneratorComponent } from './studio-generator.component';
import { BrandKitComponent } from './brand-kit.component';
import { ImageEditorComponent } from './image-editor.component';

const CAPS = (over: any = {}) => ({
  image: { available: true, provider: 'openai', label: 'OpenAI Images', aspects: ['1:1', '4:5', '9:16', '16:9'], maxVariations: 4 },
  video: { available: true, provider: 'runway', label: 'Runway', durations: [5, 10], aspects: ['9:16', '16:9', '1:1'], textToVideo: false },
  voice: { available: false, reason: 'Add ELEVENLABS_API_KEY' }, videoEditing: { available: false, reason: 'Install FFmpeg' }, ...over
});
const GEN = (over: any = {}) => ({ id: 1, kind: 'text', purpose: 'post', status: 'completed', provider: 'groq', model: 'groq', input: {}, output: {}, assets: [], error: null, errorCode: null, estimatedCredits: 1, credits: 1, costUsd: null, attempts: 0, campaignId: null, contentItemId: null, createdAt: '2026-11-08T10:00:00Z', completedAt: null, ...over });

describe('AI Content Studio', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [StudioGeneratorComponent, BrandKitComponent, ImageEditorComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  describe('AI Content Generator', () => {
    let fixture: ComponentFixture<StudioGeneratorComponent>;
    let comp: StudioGeneratorComponent;
    const el = () => fixture.nativeElement as HTMLElement;
    const init = (caps = CAPS()) => {
      fixture = TestBed.createComponent(StudioGeneratorComponent);
      comp = fixture.componentInstance;
      fixture.detectChanges();
      http.expectOne(r => r.url.endsWith('/studio/capabilities')).flush({ capabilities: caps });
      http.expectOne(r => r.url.endsWith('/studio/brand-kits')).flush({ brandKits: [{ id: 3, name: 'Main', isDefault: true }] });
      http.expectOne(r => r.url.endsWith('/studio/usage')).flush({ usage: { creditsUsed: 40, creditLimit: 2000, creditsLeft: 1960 } });
      http.expectOne(r => r.url.includes('/studio/generations')).flush({ generations: [] });
      http.expectOne(r => r.url.includes('/social/media')).flush({ items: [] });
      fixture.detectChanges();
    };
    const refreshes = () => {
      http.match(r => r.url.endsWith('/studio/usage')).forEach(r => r.flush({ usage: { creditsUsed: 41, creditLimit: 2000, creditsLeft: 1959 } }));
      http.match(r => r.url.includes('/studio/generations') && !/generations\/\d/.test(r.url)).forEach(r => r.flush({ generations: [] }));
    };

    it('shows the four options and usage; an option without a provider says how to set it up', () => {
      init(CAPS({ image: { available: false, reason: 'Add OPENAI_API_KEY or FAL_KEY on the server to generate images.' } }));
      expect(Array.from(el().querySelectorAll('.st-mode b')).map(b => b.textContent)).toEqual(['Poster', 'Video', 'Social post', 'Carousel']);
      expect(el().textContent).toContain('40 / 2000 credits');
      expect(el().textContent).toContain('Add OPENAI_API_KEY or FAL_KEY');
      expect(el().querySelector('form')).withContext('no form for an unavailable option').toBeNull();
    });

    it('social posts: platform fields, one request key per click, a single field regenerated', () => {
      init();
      comp.setMode('post');
      comp.post.product = 'Spring range';
      comp.start();
      const est = http.expectOne(r => r.url.endsWith('/studio/estimate'));
      expect(est.request.body.kind).toBe('text');
      expect(est.request.body.input.platforms).toEqual(['instagram', 'linkedin']);
      est.flush({ estimate: { credits: 1, costUsd: null, needsConfirmation: false } });
      const g = http.expectOne(r => r.url.endsWith('/studio/ai/post'));
      expect(g.request.body.requestKey).toMatch(/^ui-/);
      expect(g.request.body.brandKitId).toBeNull();
      g.flush({ generation: GEN({ output: { posts: [{ platform: 'instagram', title: 'T', caption: 'Old caption', description: '', hashtags: ['a'], call_to_action: 'Go', suggested_time: 'Tue 10:00', suggested_format: 'carousel' }] } }) });
      refreshes();
      fixture.detectChanges();
      expect(el().querySelector('.st-post')!.textContent).toContain('Instagram');
      const p = comp.current!.output.posts[0];
      comp.regenField(p, 'caption', 0);
      const f = http.expectOne(r => r.url.endsWith('/studio/ai/post-field'));
      expect(f.request.body.field).toBe('caption');
      f.flush({ generation: GEN({ purpose: 'post_field', output: { field: 'caption', value: 'New caption' } }) });
      http.match(r => r.url.endsWith('/studio/usage')).forEach(r => r.flush({ usage: {} }));
      expect(p.caption).toBe('New caption');
      expect(p.title).withContext('other fields untouched').toBe('T');
    });

    it('a video waits for confirmation of the estimate, then is followed until it is done', fakeAsync(() => {
      init();
      comp.setMode('video');
      comp.video.title = 'Reel'; comp.video.prompt = 'A product reel';
      comp.start();
      http.expectOne(r => r.url.endsWith('/studio/estimate')).flush({ estimate: { credits: 55, costUsd: null, needsConfirmation: true } });
      fixture.detectChanges();
      http.expectNone(r => r.url.endsWith('/studio/ai/video'));
      expect(el().querySelector('.st-confirm')!.textContent).toContain('55 AI credits');
      comp.confirmStart();
      const v = http.expectOne(r => r.url.endsWith('/studio/ai/video'));
      expect(v.request.body.confirm).toBeTrue();
      v.flush({ generation: GEN({ id: 9, kind: 'video', status: 'queued', credits: null }) });
      refreshes();
      tick(4000);
      http.expectOne(r => r.url.endsWith('/studio/generations/9')).flush({ generation: GEN({ id: 9, kind: 'video', status: 'processing', output: { progress: 0.4 } }) });
      fixture.detectChanges();
      expect(el().textContent).toContain('Processing 40%');
      tick(4000);
      http.expectOne(r => r.url.endsWith('/studio/generations/9')).flush({ generation: GEN({ id: 9, kind: 'video', status: 'completed', credits: 55, assets: [{ id: 12, type: 'video', url: '/v.mp4' }] }) });
      refreshes();
      fixture.detectChanges();
      expect(el().querySelector('video')).toBeTruthy();
      expect(el().textContent).toContain('Install FFmpeg', 'editing explains what it needs');
      comp.ngOnDestroy(); discardPeriodicTasks(); flush();
    }));

    it('quick-start presets fill the form; advanced options are folded away', () => {
      init();
      comp.applyPreset(comp.presets.poster[0]);
      expect([comp.poster.purpose, comp.poster.offer, comp.poster.cta]).toEqual(['offer', '20% OFF', 'Shop now']);
      fixture.detectChanges();
      const adv = el().querySelector('details.st-more') as HTMLDetailsElement;
      expect(adv.open).toBeFalse();
      expect(adv.textContent).toContain('Advanced options');
    });

    it('a failed image generation can be retried', () => {
      init();
      comp.show(GEN({ id: 5, kind: 'image', status: 'failed', error: 'Fake Images is busy.' }) as any);
      fixture.detectChanges();
      expect(el().textContent).toContain('Fake Images is busy.');
      (Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Retry')) as HTMLButtonElement).click();
      http.expectOne(r => r.method === 'POST' && r.url.endsWith('/studio/generations/5/retry')).flush({ generation: GEN({ id: 5, kind: 'image', status: 'completed', assets: [{ id: 1, type: 'image', url: '/a.png' }] }) });
      refreshes();
      fixture.detectChanges();
      expect(el().querySelectorAll('.st-shot').length).toBe(1);
    });
  });

  it('video editing: intro/outro cards, music, scene replacement and voice mode are sent in one edit', () => {
    const fixture = TestBed.createComponent(StudioGeneratorComponent);
    const comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/studio/capabilities')).flush({ capabilities: CAPS({ videoEditing: { available: true }, voice: { available: true } }) });
    http.expectOne(r => r.url.endsWith('/studio/brand-kits')).flush({ brandKits: [] });
    http.expectOne(r => r.url.endsWith('/studio/usage')).flush({ usage: { creditsUsed: 0, creditLimit: 2000, creditsLeft: 2000 } });
    http.expectOne(r => r.url.includes('/studio/generations')).flush({ generations: [] });
    http.expectOne(r => r.urlWithParams.includes('type=image')).flush({ items: [{ id: 4, title: 'Card' }] });
    comp.show(GEN({ id: 20, kind: 'video', status: 'completed', input: { durationSeconds: 5 }, assets: [{ id: 30, type: 'video', url: '/v.mp4' }] }) as any);
    http.expectOne(r => r.urlWithParams.includes('type=video')).flush({ items: [{ id: 31, title: 'New scene', durationSeconds: 5 }] });
    http.expectOne(r => r.urlWithParams.includes('type=audio')).flush({ items: [{ id: 40, title: 'Theme' }] });
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('Intro card');
    expect(text).toContain('Replace a scene');
    Object.assign(comp.edit, { introAssetId: 4, outroAssetId: 4, introSeconds: 1.5, musicAssetId: 40, musicVolume: 0.2, replaceStart: 1, replaceEnd: 2, replaceAssetId: 31, voiceOver: 'Hi', voiceMode: 'replace' });
    comp.editVideo(30);
    const req = http.expectOne(r => r.url.endsWith('/studio/ai/video-edit'));
    expect(req.request.body).toEqual(jasmine.objectContaining({ assetId: 30, introAssetId: 4, outroAssetId: 4, introSeconds: 1.5, musicAssetId: 40, musicVolume: 0.2, voiceMode: 'replace', replace: { start: 1, end: 2, assetId: 31 }, confirm: true }));
    req.flush({ generation: GEN({ id: 21, kind: 'video_edit', status: 'queued' }) });
    http.match(r => r.url.endsWith('/studio/usage') || r.url.includes('/studio/generations')).forEach(r => r.flush({ usage: {}, generations: [] }));
    comp.ngOnDestroy();
  });

  it('Brand Kit: saves the brand without the display-only image objects', () => {
    const fixture = TestBed.createComponent(BrandKitComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/studio/brand-kits')).flush({ brandKits: [{ id: 3, name: 'Main', isDefault: true, primaryColor: '#111111', productAssetIds: [7], referenceAssetIds: [], logo: { id: 2, url: '/l.png' }, productImages: [{ id: 7 }] }] });
    http.expectOne(r => r.url.includes('/social/media')).flush({ items: [{ id: 7, previewPath: '/p.png' }] });
    const comp = fixture.componentInstance;
    expect(comp.form.name).toBe('Main');
    comp.form.tone = 'Friendly';
    comp.save();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/studio/brand-kits/3'));
    expect(put.request.body.tone).toBe('Friendly');
    expect(put.request.body.productAssetIds).toEqual([7]);
    expect('logo' in put.request.body || 'productImages' in put.request.body || 'id' in put.request.body).toBeFalse();
    put.flush({ brandKit: { id: 3, name: 'Main' } });
    http.expectOne(r => r.url.endsWith('/studio/brand-kits')).flush({ brandKits: [] });
  });

  it('Image editor: platform sizes and layouts; the export is saved as a copy of the original', async () => {
    const fixture = TestBed.createComponent(ImageEditorComponent);
    const comp = fixture.componentInstance;
    comp.asset = { id: 11, url: null, width: 1080, height: 1920, title: 'Poster' };
    comp.brandKit = { primaryColor: '#1e40af' };
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/studio/capabilities')).flush({ capabilities: { image: { available: true, referenceImages: true } } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Replace background with AI');
    comp.brightness = 120; comp.draw();
    expect(comp.size.label).toContain('1080×1920', 'closest size to the image');
    comp.applyTemplate('banner');
    expect(comp.texts.length).toBe(1);
    comp.applyTemplate('offer');
    expect(comp.texts[1].text).toBe('20% OFF');
    comp.loadError = '';
    let saved: any = null;
    comp.saved.subscribe(a => saved = a);
    await comp.save();
    const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/studio/media/11/edited'));
    expect(req.request.body instanceof Blob).toBeTrue();
    expect((req.request.body as Blob).type).toBe('image/png');
    req.flush({ asset: { id: 12 } });
    expect(saved).toEqual({ id: 12 });
  });
});
