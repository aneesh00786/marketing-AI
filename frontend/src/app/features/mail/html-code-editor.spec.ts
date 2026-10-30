import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HtmlCodeEditorComponent, highlightHtml } from './html-code-editor.component';

describe('HtmlCodeEditorComponent', () => {
  it('colouring escapes everything: markup in the source is never rendered', () => {
    const out = highlightHtml('<img src="x" onerror="window.__hcPwn=1"><script>window.__hcPwn2=1</script><p>Hi {{first_name}} <a href="$[LI:UNSUBSCRIBE]$">u</a></p><!-- c -->');
    const box = document.createElement('div');
    box.innerHTML = out;
    expect(box.querySelectorAll('img, script, p, a').length).withContext('only spans').toBe(0);
    expect(Array.from(box.querySelectorAll('*')).every(e => e.tagName === 'SPAN')).toBeTrue();
    expect(box.textContent).toContain('<img src="x" onerror="window.__hcPwn=1">');
    expect(box.querySelector('.hc-tag')!.textContent).toBe('img');
    expect(Array.from(box.querySelectorAll('.hc-merge')).map(e => e.textContent)).toEqual(['{{first_name}}', '$[LI:UNSUBSCRIBE]$']);
    expect(box.querySelector('.hc-comment')!.textContent).toBe('<!-- c -->');
    expect((window as any).__hcPwn).toBeUndefined();
  });

  it('very large sources are shown plain (escaped) so typing stays fast', () => {
    const big = '<p>' + 'x'.repeat(160000) + '</p>';
    expect(highlightHtml(big)).not.toContain('<span');
    expect(highlightHtml(big).startsWith('&lt;p&gt;')).toBeTrue();
  });

  describe('component', () => {
    let fixture: ComponentFixture<HtmlCodeEditorComponent>;
    let comp: HtmlCodeEditorComponent;
    beforeEach(() => {
      TestBed.configureTestingModule({ imports: [HtmlCodeEditorComponent] });
      fixture = TestBed.createComponent(HtmlCodeEditorComponent);
      comp = fixture.componentInstance;
      comp.value = '<p>One</p>\n<p>Two</p>\n<p>Three</p>';
      fixture.detectChanges();
    });

    it('numbers the lines and reports edits', () => {
      const el = fixture.nativeElement as HTMLElement;
      expect(Array.from(el.querySelectorAll('.hc-gutter span')).map(s => s.textContent)).toEqual(['1', '2', '3']);
      const out: string[] = [];
      comp.valueChange.subscribe(v => out.push(v));
      const ta = el.querySelector('textarea')!;
      ta.value = '<p>Only</p>';
      ta.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(out).toEqual(['<p>Only</p>']);
      expect(el.querySelectorAll('.hc-gutter span').length).toBe(1);
    });

    it('expands and shrinks; disabled stops editing', () => {
      const el = fixture.nativeElement as HTMLElement;
      (el.querySelector('.hc-expand') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(el.querySelector('.hc')!.classList).toContain('expanded');
      comp.disabled = true;
      fixture.detectChanges();
      expect((el.querySelector('textarea') as HTMLTextAreaElement).disabled).toBeTrue();
    });
  });
});
