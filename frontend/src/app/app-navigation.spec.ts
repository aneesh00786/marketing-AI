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

  it('the "drafts awaiting approval" notification opens Approvals', () => {
    app.drafts = [{ id: 1, status: 'Draft', subject: 'Hi' }];
    const n = app.notifications.find(x => x.icon === 'drafts')!;
    app.navigate(n.route, n.mailSection);
    expect(app.currentRoute).toBe('emails');
    expect(app.mailSection).toBe('approvals');
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
