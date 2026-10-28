import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TemplatePickerComponent } from './template-picker.component';

const LIST = (r: any) => r.method === 'GET' && /\/api\/v1\/mail\/templates$/.test(r.url);
const ONE = (id: number) => (r: any) => r.method === 'GET' && r.url.endsWith(`/api/v1/mail/templates/${id}`);
const tpl = (o: any = {}) => ({ id: 1, name: 'Spring Promo', category: 'Promotion', description: 'Seasonal offer', source: 'zip', updatedAt: '2026-10-20T10:00:00Z', ...o });

describe('TemplatePickerComponent (modal)', () => {
  let fixture: ComponentFixture<TemplatePickerComponent>;
  let comp: TemplatePickerComponent;
  let http: HttpTestingController;
  let picked: any[];
  let closed: number;
  const el = () => fixture.nativeElement as HTMLElement;
  const useBtn = () => Array.from(el().querySelectorAll('.tp-foot button')).find(b => b.textContent!.includes('Use This Template')) as HTMLButtonElement;
  const cards = () => Array.from(el().querySelectorAll('.tp-card')) as HTMLButtonElement[];

  function init(templates: any[] = [tpl(), tpl({ id: 2, name: 'Newsletter', category: 'News', description: null, source: 'html' })]): void {
    fixture = TestBed.createComponent(TemplatePickerComponent);
    comp = fixture.componentInstance;
    picked = [];
    closed = 0;
    comp.picked.subscribe(t => picked.push(t));
    comp.closed.subscribe(() => closed++);
    fixture.detectChanges();
    http.expectOne(LIST).flush({ templates });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [TemplatePickerComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('opens as a dialog titled "Choose an Email Template" with search, close, Cancel and a disabled Use This Template', () => {
    init();
    const dialog = el().querySelector('[role=dialog]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(el().querySelector('#tp-title')!.textContent).toBe('Choose an Email Template');
    expect(el().querySelector('input[type=search]')).toBeTruthy();
    expect(el().querySelector('.tp-x[aria-label=Close]')).toBeTruthy();
    expect(Array.from(el().querySelectorAll('.tp-foot button')).map(b => b.textContent!.trim())).toEqual(['Cancel', 'Use This Template']);
    expect(useBtn().disabled).toBeTrue();
    expect(el().textContent).toContain('Select a template');
  });

  it('cards show the name and the metadata the API provides', () => {
    init();
    expect(cards().length).toBe(2);
    const first = cards()[0].textContent!;
    expect(first).toContain('Spring Promo');
    expect(first).toContain('Seasonal offer');
    expect(first).toContain('Promotion');
    expect(first).toContain('ZIP import');
    expect(first).toContain('Updated Oct 20, 2026');
  });

  it('searching asks the template API with the typed text (debounced) and shows a no-match state', fakeAsync(() => {
    init();
    comp.q = 'zzz';
    comp.search();
    tick(100);
    http.expectNone(LIST);
    tick(200);
    const req = http.expectOne(LIST);
    expect(req.request.params.get('q')).toBe('zzz');
    req.flush({ templates: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('No templates match “zzz”');
  }));

  it('selecting a card highlights it, loads its HTML and previews it in a fully sandboxed iframe', () => {
    init();
    cards()[1].click();
    fixture.detectChanges();
    expect(cards()[1].classList).toContain('on');
    expect(cards()[1].getAttribute('aria-selected')).toBe('true');
    expect(useBtn().disabled).withContext('not usable until the template has loaded').toBeTrue();
    expect(el().textContent).toContain('Loading preview');
    http.expectOne(ONE(2)).flush({ template: { id: 2, name: 'Newsletter', html: '<h1 id="tp-inner">News</h1><script>window.__tpX = 1</script>', placeholders: ['{{first_name}}'] } });
    fixture.detectChanges();
    const frame = el().querySelector('.tp-frame iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('', 'no scripts, forms, popups or same-origin access');
    expect(frame.getAttribute('srcdoc')).toContain('tp-inner');
    expect(el().querySelector('#tp-inner')).toBeNull('the HTML is never put into the page itself');
    expect((window as any).__tpX).toBeUndefined();
    expect(el().textContent).toContain('Placeholders: {{first_name}}');
    expect(useBtn().disabled).toBeFalse();
  });

  it('a slow earlier preview cannot replace the template chosen later', () => {
    init();
    cards()[0].click();
    cards()[1].click();
    const first = http.expectOne(ONE(1));
    http.expectOne(ONE(2)).flush({ template: { id: 2, name: 'Newsletter', html: '<p>2</p>' } });
    first.flush({ template: { id: 1, name: 'Spring Promo', html: '<p>1</p>' } });
    expect(comp.selected.id).toBe(2);
    fixture.detectChanges();
    useBtn().click();
    expect(picked.map(t => t.id)).toEqual([2]);
  });

  it('Use This Template emits the full template once; nothing is emitted before', () => {
    init();
    cards()[0].click();
    http.expectOne(ONE(1)).flush({ template: { id: 1, name: 'Spring Promo', html: '<p>Promo</p>' } });
    expect(picked.length).toBe(0);
    fixture.detectChanges();
    useBtn().click();
    expect(picked).toEqual([{ id: 1, name: 'Spring Promo', html: '<p>Promo</p>' }]);
    expect(closed).toBe(0);
  });

  it('Cancel, the close button, the backdrop and Escape close without choosing anything', () => {
    init();
    cards()[0].click();
    http.expectOne(ONE(1)).flush({ template: { id: 1, name: 'Spring Promo', html: '<p>x</p>' } });
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('.tp-foot button')).find(b => b.textContent!.trim() === 'Cancel') as HTMLButtonElement).click();
    (el().querySelector('.tp-x') as HTMLButtonElement).click();
    (el().querySelector('.tp-backdrop') as HTMLElement).click();
    (el().querySelector('.tp') as HTMLElement).click(); // clicks inside the dialog do not close it
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(4);
    expect(picked.length).toBe(0);
  });

  it('shows load errors for the list and for a preview', () => {
    fixture = TestBed.createComponent(TemplatePickerComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(LIST).flush({ error: 'x' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('Your role cannot view email templates');
    comp.load();
    http.expectOne(LIST).flush({ templates: [tpl()] });
    fixture.detectChanges();
    cards()[0].click();
    http.expectOne(ONE(1)).flush({ error: 'Template not found.' }, { status: 404, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('Template not found.');
    expect(useBtn().disabled).toBeTrue();
  });

  it('arrow keys move between cards', () => {
    init();
    cards()[0].focus();
    cards()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(cards()[1]);
  });
});
