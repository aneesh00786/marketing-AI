import { Injectable } from '@angular/core';

export type Theme = 'light' | 'dark';
const KEY = 'tradesage_theme';

/** Light/dark theme. index.html applies the saved choice before Angular boots. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  theme: Theme = this.read();

  private read(): Theme {
    if (typeof document !== 'undefined') {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark' || attr === 'light') return attr;
    }
    return 'light';
  }

  get isDark(): boolean {
    return this.theme === 'dark';
  }

  set(theme: Theme): void {
    this.theme = theme;
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0c11' : '#f4f6fb');
    }
    try { localStorage.setItem(KEY, theme); } catch { /* storage unavailable: applies to this page only */ }
  }

  toggle(): void {
    this.set(this.isDark ? 'light' : 'dark');
  }
}
