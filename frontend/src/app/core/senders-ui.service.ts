import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** Opens the "My sender email" window from anywhere (Compose, campaigns, Mail Center), and says when it changed. */
@Injectable({ providedIn: 'root' })
export class SendersUiService {
  readonly open$ = new Subject<void>();
  readonly changed$ = new Subject<void>();
  open(): void { this.open$.next(); }
}
