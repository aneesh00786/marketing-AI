import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Dependency-free line icons (24px grid, stroke based). Decorative by default. */
@Component({
  selector: 'app-icon',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size" [attr.height]="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" [ngSwitch]="name">
      <g *ngSwitchCase="'products'"><path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="m3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></g>
      <g *ngSwitchCase="'leads'"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6 6 0 0 1 3.5 5.5"/></g>
      <g *ngSwitchCase="'mail'"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></g>
      <g *ngSwitchCase="'drafts'"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="m9 15 2 2 4-4"/></g>
      <g *ngSwitchCase="'social'"><path d="M4 12v-1a8 8 0 0 1 16 0v1"/><path d="M4 12a2 2 0 0 0 2 2h1v-4H6a2 2 0 0 0-2 2Z"/><path d="M20 12a2 2 0 0 1-2 2h-1v-4h1a2 2 0 0 1 2 2Z"/><path d="M17 14v1a5 5 0 0 1-5 5"/></g>
      <g *ngSwitchCase="'campaigns'"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></g>
      <g *ngSwitchCase="'voice'"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></g>
      <g *ngSwitchCase="'calendar'"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></g>
      <g *ngSwitchCase="'bell'"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/></g>
      <g *ngSwitchCase="'menu'"><path d="M4 6h16M4 12h16M4 18h16"/></g>
      <g *ngSwitchCase="'collapse'"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/><path d="m15 10-2 2 2 2"/></g>
      <g *ngSwitchCase="'expand'"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/><path d="m13 10 2 2-2 2"/></g>
      <g *ngSwitchCase="'chevron-down'"><path d="m6 9 6 6 6-6"/></g>
      <g *ngSwitchCase="'check'"><path d="m5 12 5 5 9-10"/></g>
      <g *ngSwitchCase="'logout'"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></g>
      <g *ngSwitchCase="'building'"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-4h6v4M8 7h2M14 7h2M8 11h2M14 11h2"/></g>
      <g *ngSwitchCase="'x'"><path d="M18 6 6 18M6 6l12 12"/></g>
      <g *ngSwitchCase="'phone'"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></g>
      <g *ngSwitchCase="'sparkles'"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></g>
      <g *ngSwitchCase="'dashboard'"><rect x="3" y="3" width="7.5" height="9" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="5" rx="1.8"/><rect x="13.5" y="11" width="7.5" height="10" rx="1.8"/><rect x="3" y="15" width="7.5" height="6" rx="1.8"/></g>
      <g *ngSwitchCase="'sun'"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g>
      <g *ngSwitchCase="'moon'"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></g>
      <g *ngSwitchDefault><circle cx="12" cy="12" r="8"/></g>
    </svg>
  `,
  styles: [':host { display: inline-flex; line-height: 0; flex-shrink: 0; }']
})
export class IconComponent {
  @Input() name = '';
  @Input() size = 18;
}
