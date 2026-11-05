import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/** A request to open Compose with the recipient (and optionally subject and text) filled in. */
export interface ComposeRequest { email: string; name?: string | null; subject?: string; body?: string; }

/**
 * Lets any screen open the app's Compose window prefilled (e.g. following up a campaign
 * recipient from the results popup). The app shell listens and opens Compose; nothing is sent
 * until the person clicks Send there.
 */
@Injectable({ providedIn: 'root' })
export class ComposeRequestService {
  readonly requests$ = new Subject<ComposeRequest>();
  open(req: ComposeRequest): void { this.requests$.next(req); }
}
