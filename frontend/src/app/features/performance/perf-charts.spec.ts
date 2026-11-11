import { TestBed } from '@angular/core/testing';
import { PerfDonutComponent, PerfRingComponent, PerfFunnelComponent } from './perf-charts';

describe('Performance charts', () => {
  it('donut: one arc per non-empty part, the total in the middle, number and share in the legend; a part can be clicked', () => {
    const f = TestBed.createComponent(PerfDonutComponent);
    f.componentInstance.slices = [
      { key: 'onTime', label: 'On time', value: 6, color: '--good' }, { key: 'late', label: 'Late', value: 2, color: '--warn' },
      { key: 'overdue', label: 'Overdue now', value: 2, color: '--crit' }, { key: 'cancelled', label: 'Cancelled', value: 0, color: '--neutral' }];
    f.componentInstance.centerLabel = 'follow-ups';
    f.componentInstance.ngOnChanges();
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelectorAll('circle.seg').length).toBe(3, 'no arc for an empty part');
    expect(el.querySelector('svg')!.textContent).toContain('10');
    expect(el.querySelector('.donut-list')!.textContent).toContain('On time660%');
    let picked = '';
    f.componentInstance.select.subscribe(k => (picked = k));
    (el.querySelectorAll('.donut-list li')[2] as HTMLElement).click();
    expect(picked).toBe('overdue');
  });

  it('donut: says so when there is nothing', () => {
    const f = TestBed.createComponent(PerfDonutComponent);
    f.componentInstance.slices = [{ key: 'a', label: 'A', value: 0, color: '--s1' }];
    f.componentInstance.empty = 'No follow-ups in this period.';
    f.componentInstance.ngOnChanges();
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('No follow-ups in this period.');
  });

  it('ring: the colour follows the thresholds and the number is written in it', () => {
    const f = TestBed.createComponent(PerfRingComponent);
    f.componentInstance.value = 45;
    f.componentInstance.label = 'Follow-ups on time';
    f.detectChanges();
    expect(f.componentInstance.tone).toBe('--crit');
    expect((f.nativeElement as HTMLElement).textContent).toContain('45%');
    f.componentInstance.value = 85;
    expect(f.componentInstance.tone).toBe('--good');
  });

  it('funnel: each step with its share of the first', () => {
    const f = TestBed.createComponent(PerfFunnelComponent);
    f.componentInstance.steps = [{ label: 'Recipients', value: 200 }, { label: 'Delivered', value: 190 }, { label: 'Opened', value: 50 }, { label: 'Clicked', value: 10 }];
    f.detectChanges();
    const t = (f.nativeElement as HTMLElement).textContent!;
    expect(t).toContain('Opened50' + '25%');
    expect(t).toContain('Clicked10' + '5%');
  });
});
