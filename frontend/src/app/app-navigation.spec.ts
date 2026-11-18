import { AppComponent } from './app.component';

/** Shell navigation only: the component is built without rendering, so no services are called. */
describe('App shell: Mail Center navigation', () => {
  let app: AppComponent;
  beforeEach(() => {
    app = new AppComponent({} as any, {} as any, {} as any, {} as any);
    spyOn(window, 'scrollTo');
  });

  it('the sidebar has one Mail Center entry and no separate Mail Drafts entry', () => {
    const items = app.navGroups.flatMap(g => g.items);
    expect(items.filter(i => i.label === 'Mail Center').length).toBe(1);
    expect(items.some(i => i.label === 'Mail Drafts' || (i.route as string) === 'drafts')).toBeFalse();
  });

  it('the former Mail Drafts route opens Mail Center on Drafts', () => {
    app.navigate('drafts');
    expect(app.currentRoute).toBe('emails');
    expect(app.mailSection).toBe('drafts');
  });

  it('the sidebar opens Mail Center on its overview', () => {
    app.mailSection = 'campaigns';
    app.navigate('emails');
    expect(app.mailSection).toBe('overview');
  });

  it('dashboard links to drafts land on the Drafts section', () => {
    app.onDashboardNavigate({ route: 'drafts' } as any);
    expect(app.currentRoute).toBe('emails');
    expect(app.mailSection).toBe('drafts');
  });

  it('the "draft awaiting approval" notification opens Approvals and is marked read', () => {
    const api = { markNotificationRead: jasmine.createSpy().and.returnValue({ subscribe: () => null }), markAllNotificationsRead: jasmine.createSpy().and.returnValue({ subscribe: () => null }) };
    (app as any).apiService = api;
    app.notifications = [
      { id: 7, kind: 'draft_approval', title: 'Draft awaiting approval: Hi', detail: 'Kim', tone: 'warning', icon: 'drafts', link: { route: 'emails', mailSection: 'approvals' }, at: new Date().toISOString(), read: false },
      { id: 8, kind: 'transcript_failed', title: 'Call transcript failed', detail: 'Acme', tone: 'warning', icon: 'phone', link: { route: 'leads', leadId: 3 }, at: new Date(Date.now() - 2 * 3600000).toISOString(), read: false }
    ];
    app.notifUnread = 2;
    app.openNotification(app.notifications[0]);
    expect(app.currentRoute).toBe('emails');
    expect(app.mailSection).toBe('approvals');
    expect(api.markNotificationRead).toHaveBeenCalledWith(7);
    expect([app.notifications[0].read, app.notifUnread]).toEqual([true, 1]);
    app.openNotification(app.notifications[0]);
    expect(api.markNotificationRead).toHaveBeenCalledTimes(1);
    expect(app.notifWhen(app.notifications[1].at)).toBe('2 h ago');
    app.markAllNotificationsRead();
    expect(api.markAllNotificationsRead).toHaveBeenCalled();
    expect(app.notifUnread).toBe(0);
    expect(app.notifications.every(n => n.read)).toBeTrue();
    app.notifUnread = 150;
    expect(app.notifBadge).toBe('99+');
  });

  it('a social notification opens the publishing queue filtered to failed posts', () => {
    (app as any).apiService = { markNotificationRead: () => ({ subscribe: () => null }) };
    app.openNotification({ id: 9, read: false, link: { route: 'social', section: 'queue', status: 'failed' } });
    expect(app.currentRoute).toBe('social');
    expect(app.socialSection).toBe('queue');
    expect(app.socialLibraryStatus).toBe('failed');
  });

  it('"Create AI Email Draft" on a product opens Drafts with that product', () => {
    app.openDraftForProduct(7);
    expect(app.currentRoute).toBe('emails');
    expect(app.mailSection).toBe('drafts');
    expect(app.draftProduct).toEqual({ id: 7 });
  });

  it('Email Templates "Use in" switches to the Drafts or Campaigns section', () => {
    spyOn(app, 'showToast');
    app.onTemplateUse({ template: { id: 3, name: 'Promo' }, target: 'draft' });
    expect(app.mailSection).toBe('drafts');
    expect(app.draftTemplate).toEqual({ id: 3, name: 'Promo' });
    app.onTemplateUse({ template: { id: 3, name: 'Promo' }, target: 'campaign' });
    expect(app.mailSection).toBe('campaigns');
    expect(app.campaignStartTemplate).toEqual({ id: 3, name: 'Promo' });
  });

  it('?view=drafts (old Mail Drafts link) and Mail Center links open the right section, then the URL is cleaned', () => {
    const replace = spyOn(window.history, 'replaceState');
    const original = window.location.pathname + window.location.search;
    try {
      window.history.pushState({}, '', '/?view=drafts');
      (app as any).readDeepLink();
      expect(app.currentRoute).toBe('emails');
      expect(app.mailSection).toBe('drafts');
      window.history.pushState({}, '', '/?view=mail&section=campaigns');
      (app as any).readDeepLink();
      expect(app.mailSection).toBe('campaigns');
      expect(replace).toHaveBeenCalled();
    } finally {
      window.history.pushState({}, '', original);
    }
  });
});
