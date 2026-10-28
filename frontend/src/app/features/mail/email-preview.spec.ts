import { Component } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { EmailPreviewComponent } from './email-preview.component';
import { PREVIEW_CSP, prepareEmailPreview, textToPreviewHtml } from './email-preview';

const parse = (doc: string) => new DOMParser().parseFromString(doc, 'text/html');

describe('prepareEmailPreview (preview cleaning)', () => {
  it('keeps legitimate email markup: tables, inline styles, <style> blocks, media queries and images', () => {
    const html = '<style>.b{color:red}@media (max-width:600px){.b{padding:4px}}</style><table width="100%"><tr><td class="b" style="padding:24px;background:#eee">Hi <img src="https://cdn.example.com/x.png" alt="logo"></td></tr></table>';
    const d = parse(prepareEmailPreview(html).doc);
    expect(d.querySelector('td')!.getAttribute('style')).toBe('padding:24px;background:#eee');
    expect(Array.from(d.querySelectorAll('style')).some(s => s.textContent!.includes('@media (max-width:600px)'))).toBeTrue();
    expect(d.querySelector('img')!.getAttribute('src')).toBe('https://cdn.example.com/x.png');
    expect(d.querySelector('table')).toBeTruthy();
  });

  it('keeps a complete HTML document (head styles, viewport meta and body)', () => {
    const d = parse(prepareEmailPreview('<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>.x{color:blue}</style></head><body class="bd"><div class="x">Full</div></body></html>').doc);
    expect(d.querySelector('meta[name=viewport]')).toBeTruthy();
    expect(d.body.className).toBe('bd');
    expect(d.body.textContent).toContain('Full');
  });

  it('removes active content: scripts, frames, plugins, <base>, meta refresh, event handlers and javascript: URLs', () => {
    const html = '<script>alert(1)</script><iframe src="https://x"></iframe><object data="x"></object><embed src="x"><base href="https://evil.example/">'
      + '<meta http-equiv="refresh" content="0;url=https://evil.example"><img src="x.png" onerror="alert(2)"><div onclick="alert(3)" onmouseover="alert(4)">Text</div>'
      + '<a href="javascript:alert(5)">bad</a><img src="javascript:alert(6)"><svg><a xlink:href="javascript:alert(7)"><text>s</text></a></svg>';
    const d = parse(prepareEmailPreview(html).doc);
    expect(d.querySelector('script, iframe, object, embed, base, meta[http-equiv=refresh]')).toBeNull();
    const all = Array.from(d.querySelectorAll('*'));
    expect(all.some(e => Array.from(e.attributes).some(a => a.name.startsWith('on')))).toBeFalse();
    expect(d.documentElement.outerHTML).not.toContain('javascript:');
    expect(d.body.textContent).toContain('Text');
  });

  it('forms cannot submit and links cannot navigate; the unsubscribe placeholder stays visible but is never followed', () => {
    const d = parse(prepareEmailPreview('<form action="https://evil.example/x" method="post"><input name="a"><button>Go</button></form><a href="$[LI:UNSUBSCRIBE]$" target="_blank">Unsubscribe</a><a href="https://shop.example/">Shop</a>').doc);
    expect(d.querySelector('form')).toBeNull();
    expect(d.querySelector('button')).toBeTruthy('the form contents still show');
    expect(d.querySelector('a[href]')).toBeNull();
    expect(d.querySelector('[target]')).toBeNull();
    const unsub = Array.from(d.querySelectorAll('a')).find(a => a.textContent === 'Unsubscribe')!;
    expect(unsub.getAttribute('data-preview-href')).toBe('$[LI:UNSUBSCRIBE]$');
  });

  it('adds a Content-Security-Policy that blocks scripts, connections, frames and form submission', () => {
    const d = parse(prepareEmailPreview('<p>x</p>').doc);
    const csp = d.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    expect(csp).toBe(PREVIEW_CSP);
    for (const rule of ["script-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "object-src 'none'", "base-uri 'none'"]) expect(csp).toContain(rule);
    expect(d.querySelector('meta[name=referrer]')!.getAttribute('content')).toBe('no-referrer');
  });

  it('parsing never runs the email\'s scripts or handlers', () => {
    prepareEmailPreview('<script>window.__epS = 1</script><img src="nope.png" onerror="window.__epE = 1"><svg onload="window.__epL = 1"></svg>');
    expect((window as any).__epS).toBeUndefined();
    expect((window as any).__epE).toBeUndefined();
    expect((window as any).__epL).toBeUndefined();
  });

  it('reports HTML with nothing visible (broken or empty markup)', () => {
    expect(prepareEmailPreview('<div style="color:red').nothingVisible).toBeTrue();
    expect(prepareEmailPreview('<p></p><div>  </div>').nothingVisible).toBeTrue();
    expect(prepareEmailPreview('<img src="https://x/y.png">').nothingVisible).toBeFalse();
    expect(prepareEmailPreview('<p>Hello').nothingVisible).withContext('unclosed tags still render their text').toBeFalse();
  });

  it('plain text is escaped, never interpreted as HTML', () => {
    const html = textToPreviewHtml('Hi <b>there</b> & <script>x</script>');
    expect(html).toContain('&lt;b&gt;there&lt;/b&gt; &amp; &lt;script&gt;');
    expect(textToPreviewHtml('   ')).toBe('');
  });
});

@Component({
  standalone: true,
  imports: [EmailPreviewComponent],
  template: `<app-email-preview [html]="html" [contentKey]="key" [viewport]="viewport"></app-email-preview>`
})
class HostComponent { html: string | null = '<h1 id="h">Hello</h1>'; key: any = 1; viewport: 'desktop' | 'mobile' = 'desktop'; }

describe('EmailPreviewComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let preview: EmailPreviewComponent;
  let writes: string[];
  const el = () => fixture.nativeElement as HTMLElement;
  const frame = () => el().querySelector('iframe') as HTMLIFrameElement;

  beforeEach(() => {
    writes = [];
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc')!;
    spyOnProperty(HTMLIFrameElement.prototype, 'srcdoc', 'set').and.callFake(function (this: HTMLIFrameElement, v: any) { writes.push(String(v)); desc.set!.call(this, v); });
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    preview = fixture.debugElement.query(By.directive(EmailPreviewComponent)).componentInstance;
  });

  it('renders the HTML at once in a sandboxed iframe with no permissions', () => {
    expect(writes.length).toBe(1);
    expect(frame().getAttribute('sandbox')).toBe('');
    expect(frame().getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame().getAttribute('srcdoc')).toContain('<h1 id="h">Hello</h1>');
    expect(el().querySelector('#h')).toBeNull('the HTML is never placed in the app page');
    const box = frame().getBoundingClientRect();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(100);
  });

  it('repeated change detection never rewrites the iframe (the cause of the blank Campaigns preview)', () => {
    for (let i = 0; i < 5; i++) fixture.detectChanges();
    expect(writes.length).toBe(1);
  });

  it('edits re-render once, after typing pauses, and only after the previous render has loaded', fakeAsync(() => {
    host.html = '<p>A</p>'; fixture.detectChanges(); tick(100);
    host.html = '<p>AB</p>'; fixture.detectChanges(); tick(100);
    expect(writes.length).toBe(1, 'nothing written while typing');
    tick(200);
    expect(writes.length).toBe(1, 'first render still loading: the newer HTML waits');
    preview.onLoad();
    expect(writes.length).toBe(2);
    expect(writes[1]).toContain('<p>AB</p>');
    preview.onLoad();
    expect(preview.state).toBe('ready');
    flush();
  }));

  it('switching to another item (contentKey) renders it without the debounce, so no stale content stays', fakeAsync(() => {
    preview.onLoad();
    host.html = '<p>Second item</p>'; host.key = 2; fixture.detectChanges();
    expect(writes.length).toBe(2);
    expect(writes[1]).toContain('Second item');
    expect(writes[1]).not.toContain('Hello');
    flush();
  }));

  it('shows an empty state without HTML, and clears the old document', fakeAsync(() => {
    preview.onLoad();
    host.html = '   '; fixture.detectChanges(); tick(300);
    expect(el().textContent).toContain('No HTML content yet');
    expect((el().querySelector('.ep-frame-wrap') as HTMLElement).hidden).toBeTrue();
    expect(writes[writes.length - 1]).not.toContain('Hello');
    flush();
  }));

  it('says when the HTML has nothing visible (malformed markup)', fakeAsync(() => {
    preview.onLoad();
    host.html = '<div style="color:red'; fixture.detectChanges(); tick(300); fixture.detectChanges();
    expect(el().textContent).toContain('no visible content');
    flush();
  }));

  it('shows an error state with Try again when the preview does not load', fakeAsync(() => {
    const was = EmailPreviewComponent.loadTimeoutMs;
    EmailPreviewComponent.loadTimeoutMs = 500;
    try {
      host.html = '<p>never loads</p>'; host.key = 3; fixture.detectChanges();
      preview.onLoad(); // first document loaded
      host.html = '<p>stuck</p>'; host.key = 4; fixture.detectChanges();
      tick(600); fixture.detectChanges();
      expect(preview.state).toBe('error');
      expect(el().textContent).toContain('The preview could not be shown');
      (el().querySelector('.ep-link') as HTMLButtonElement).click();
      expect(writes[writes.length - 1]).toContain('stuck');
      preview.onLoad();
      expect(preview.state).toBe('ready');
      flush();
    } finally { EmailPreviewComponent.loadTimeoutMs = was; }
  }));

  it('long emails scroll inside the preview instead of stretching the page; mobile width is 375px', fakeAsync(() => {
    preview.onLoad();
    host.html = '<p>line</p>'.repeat(2000); host.key = 5; host.viewport = 'mobile'; fixture.detectChanges();
    const hostEl = el().querySelector('app-email-preview') as HTMLElement;
    expect(hostEl.getBoundingClientRect().height).toBeLessThanOrEqual(421);
    expect(frame().getBoundingClientRect().width).toBeLessThanOrEqual(376);
    flush();
  }));
});
