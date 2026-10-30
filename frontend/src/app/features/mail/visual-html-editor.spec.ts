import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { VisualHtmlEditorComponent, prepareVisualDoc, serializeVisualDoc } from './visual-html-editor.component';

@Component({
  standalone: true,
  imports: [VisualHtmlEditorComponent],
  template: `<app-visual-html-editor [html]="html" [disabled]="disabled" (htmlChange)="html = $event; changes = changes + 1"></app-visual-html-editor>`
})
class HostComponent { html = '<p>Hello <b>Kim</b></p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>'; disabled = false; changes = 0; }

const parse = (doc: string) => new DOMParser().parseFromString(doc, 'text/html');

describe('VisualHtmlEditorComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  const frame = () => fixture.nativeElement.querySelector('iframe') as HTMLIFrameElement;
  /** Waits until the iframe has loaded the current srcdoc and the editor attached to it. */
  async function loaded(): Promise<Document> {
    for (let i = 0; i < 100; i++) {
      const d = frame().contentDocument;
      if (d && d.body && d.designMode === (host.disabled ? 'off' : 'on') && d.body.innerHTML.length) return d;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('the visual editor did not load');
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is sandboxed without scripts: no allow-scripts, and a script-src none policy inside', () => {
    const sb = frame().getAttribute('sandbox') || '';
    expect(sb).toBe('allow-same-origin');
    expect(sb).not.toContain('allow-scripts');
    const doc = parse(frame().getAttribute('srcdoc') || frame().srcdoc);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toContain("script-src 'none'");
  });

  it('active content is removed before editing; merge-tag links and styles are kept', () => {
    const doc = parse(prepareVisualDoc('<style>.x{color:red}</style><p class="x" onclick="steal()">Hi</p><script>window.__vePwn=1</script><img src="x" onerror="window.__vePwn2=1"><a href="javascript:alert(1)">bad</a><a href="$[LI:UNSUBSCRIBE]$">u</a><iframe src="https://evil.example"></iframe>'));
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('iframe')).toBeNull();
    expect(doc.querySelector('[onclick]')).toBeNull();
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(doc.querySelectorAll('a')[0].hasAttribute('href')).withContext('javascript: removed').toBeFalse();
    expect(doc.querySelectorAll('a')[1].getAttribute('href')).toBe('$[LI:UNSUBSCRIBE]$');
    expect(doc.body.querySelector('style, .x') || doc.head.querySelector('style:not([data-ve])')).toBeTruthy();
  });

  it('serializing drops the editor helpers; a fragment stays a fragment and a full document stays a document', () => {
    const fragment = parse(prepareVisualDoc('<p>Hi</p>'));
    expect(serializeVisualDoc(fragment, false)).toBe('<p>Hi</p>');
    const full = parse(prepareVisualDoc('<!DOCTYPE html><html><head><title>T</title><style>p{margin:0}</style></head><body><p>Hi</p></body></html>'));
    const out = serializeVisualDoc(full, true);
    expect(out.startsWith('<!DOCTYPE html>')).toBeTrue();
    expect(out).toContain('<title>T</title>');
    expect(out).toContain('p{margin:0}');
    expect(out).not.toContain('data-ve');
    expect(out).not.toContain('Content-Security-Policy');
  });

  it('shows the email as it looks and writes edits back as HTML', async () => {
    const d = await loaded();
    expect(d.body.textContent).toContain('Hello Kim');
    expect((window as any).__vePwn).toBeUndefined();
    d.body.querySelector('b')!.textContent = 'Kim Lee';
    d.dispatchEvent(new Event('input'));
    expect(host.changes).toBe(1);
    expect(host.html).toBe('<p>Hello <b>Kim Lee</b></p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>');
  });

  it('formatting commands change the email (bold on the selection)', async () => {
    const d = await loaded();
    const p = d.body.querySelector('p')!;
    const range = d.createRange();
    range.selectNodeContents(p.firstChild!); // "Hello "
    const sel = d.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    const editor = fixture.debugElement.children[0].componentInstance as VisualHtmlEditorComponent;
    editor.exec('bold');
    expect(host.html).toMatch(/<(b|strong)>Hello /);
  });

  it('new content from outside (a template, the HTML editor) replaces what is shown', async () => {
    await loaded();
    host.html = '<h1>Template content</h1>';
    fixture.detectChanges();
    for (let i = 0; i < 100 && !(frame().contentDocument?.body?.textContent || '').includes('Template content'); i++) await new Promise(r => setTimeout(r, 20));
    expect(frame().contentDocument!.body.textContent).toContain('Template content');
    expect(host.changes).withContext('loading is not an edit').toBe(0);
  });

  it('read-only campaigns cannot be edited', async () => {
    host.disabled = true;
    fixture.detectChanges();
    const d = await loaded();
    expect(d.designMode).toBe('off');
    const editor = fixture.debugElement.children[0].componentInstance as VisualHtmlEditorComponent;
    expect(editor.exec('bold')).toBeFalse();
  });
});
