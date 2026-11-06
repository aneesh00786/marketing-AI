import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LeadsToListComponent } from './leads-to-list.component';

describe('LeadsToListComponent (Add to contact list): country filter', () => {
  let fixture: ComponentFixture<LeadsToListComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  afterEach(() => http.verify());

  it('lists countries with counts and searches the chosen one; each lead shows its country', () => {
    TestBed.configureTestingModule({ imports: [LeadsToListComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeadsToListComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: [] });
    const first = http.expectOne(r => r.url.endsWith('/lead-options'));
    expect(first.request.params.has('country')).toBeFalse();
    first.flush({ leads: [{ id: 1, name: 'Sam', email: 's@a.io', country: 'Australia', eligible: true }], total: 1, eligibleCount: 1,
      countries: [{ country: 'Australia', count: 4 }, { country: null, count: 2 }] });
    fixture.detectChanges();
    expect(el().querySelector('.ltz-lead')!.textContent).toContain('s@a.io · Australia');
    const sel = el().querySelector('app-country-filter select') as HTMLSelectElement;
    expect(Array.from(sel.options).map(o => o.textContent!.trim())).toEqual(['All countries', 'Australia (4)', 'No country (2)']);
    sel.value = 'none'; sel.dispatchEvent(new Event('change'));
    const req = http.expectOne(r => r.url.endsWith('/lead-options'));
    expect(req.request.params.get('country')).toBe('none');
    expect(req.request.params.get('eligibility')).toBe('eligible');
    req.flush({ leads: [], total: 0, eligibleCount: 0, countries: [] });
  });
});
