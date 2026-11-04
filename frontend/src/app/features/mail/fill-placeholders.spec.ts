import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describePlaceholder, fillPlaceholders, findPlaceholders, findSampleLinks } from './fill-placeholders';
import { sampleCampaignHtml } from './sample-email';
import { EmailContentEditorComponent } from './email-content-editor.component';

describe('Fill in the template (placeholders)', () => {
  const sample = sampleCampaignHtml('ThriveWoo');

  it('finds every [bracketed] part of the sample once, including the hidden preview text, and its sample link', () => {
    const found = findPlaceholders(sample);
    expect(found[0]).toContain('[Preview text');
    expect(found).toContain('[Your name]');
    expect(found).toContain('[Benefit 1, e.g. next-day delivery]');
    expect(found.length).toBe(new Set(found).size);
    expect(found.some(p => p.includes('FNAME') || p.includes('UNSUBSCRIBE'))).toBeFalse();
    expect(findSampleLinks(sample)).toEqual(['https://example.com']);
  });

  it('labels a placeholder with its example as the hint', () => {
    expect(describePlaceholder('[Benefit 1, e.g. next-day delivery]')).toEqual({ label: 'Benefit 1', hint: 'e.g. next-day delivery' });
    expect(describePlaceholder('[Preview text: one line people see]')).toEqual({ label: 'Preview text', hint: 'one line people see' });
    expect(describePlaceholder('[Your name]')).toEqual({ label: 'Your name', hint: '' });
  });

  it('fills typed values (escaped) and links; leaves empty ones and Zoho merge tags alone', () => {
    const out = fillPlaceholders(sample, { '[Your name]': 'Aneesh <CEO>', '[Benefit 1, e.g. next-day delivery]': 'Next-day delivery', '[Your role]': '  ' },
      { 'https://example.com': 'https://thrivewoo.com/book' });
    expect(out).toContain('Aneesh &lt;CEO&gt;');
    expect(out).not.toContain('[Your name]');
    expect(out).toContain('<li style="margin-bottom:6px;">Next-day delivery</li>');
    expect(out).toContain('[Your role]');
    expect(out).toContain('href="https://thrivewoo.com/book"');
    expect(out).toContain('$[FNAME|there]$');
    expect(out).toContain('$[LI:UNSUBSCRIBE]$');
    expect(fillPlaceholders('<a href="https://example.com">x</a>', {}, { 'https://example.com': 'javascript:alert(1)' })).toContain('https://example.com');
    expect(fillPlaceholders('<p>&#91;Your name&#93;</p>', { '[Your name]': 'Sam' })).toBe('<p>Sam</p>');
  });
});

describe('EmailContentEditorComponent: Fill in the template box', () => {
  let fixture: ComponentFixture<EmailContentEditorComponent>;
  let comp: EmailContentEditorComponent;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EmailContentEditorComponent] });
    fixture = TestBed.createComponent(EmailContentEditorComponent);
    comp = fixture.componentInstance;
    comp.editable = true;
    comp.purpose = 'campaign';
    comp.html = '<p>Hi $[FNAME|there]$, [Your offer, e.g. a free sample]</p><p>[Your name]</p><a href="https://example.com">Book</a>';
    fixture.detectChanges();
  });

  it('shows a box per placeholder and link; Fill in puts the values into the email', () => {
    const box = el().querySelector('.ec-fill') as HTMLElement;
    expect(box.textContent).toContain('3 to fill');
    expect(Array.from(box.querySelectorAll('.ec-fill-field > span')).map(s => s.textContent!.trim())).toEqual(['Your offer', 'Your name', 'Button / link address (now https://example.com)']);
    let html = '';
    comp.htmlChange.subscribe((v: string) => html = v);
    const fill = box.querySelector('button[type=submit]') as HTMLButtonElement;
    expect(fill.disabled).toBeTrue();
    comp.fills['[Your name]'] = 'Aneesh';
    comp.linkFills['https://example.com'] = 'example';
    fixture.detectChanges();
    expect(box.textContent).toContain('Use a full https:// address');
    expect(comp.filledCount).toBe(1);
    fill.click(); fixture.detectChanges();
    expect(html).toContain('<p>Aneesh</p>');
    expect(html).toContain('https://example.com');
    expect(el().querySelector('.ec-fill')!.textContent).toContain('2 to fill');
  });

  it('is not shown for templates, read-only content or content with nothing to fill', () => {
    comp.purpose = 'template'; fixture.detectChanges();
    expect(el().querySelector('.ec-fill')).toBeNull();
    comp.purpose = 'campaign'; comp.html = '<p>Hi $[FNAME|there]$</p>'; fixture.detectChanges();
    expect(el().querySelector('.ec-fill')).toBeNull();
  });
});
