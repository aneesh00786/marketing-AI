import { of } from 'rxjs';
import { AppComponent } from './app.component';

/** Compose & Send: the purpose is required and sent with the email; the server re-checks it. */
describe('App shell: Compose email purpose', () => {
  let app: AppComponent;
  let api: any;
  beforeEach(() => {
    api = {
      sendEmail: jasmine.createSpy('sendEmail').and.returnValue(of({ message: 'sent' })),
      sendHtmlEmail: jasmine.createSpy('sendHtmlEmail').and.returnValue(of({ message: 'sent' })),
      getEmails: () => of({ emails: [] })
    };
    app = new AppComponent(api, {} as any, {} as any, {} as any);
    spyOn(app, 'showToast');
    spyOn(window, 'confirm').and.returnValue(true);
    app.composeEmail = { recipient_email: 'kim@client.io', recipient_name: 'Kim', subject: 'Hello', body: 'Hi', html_body: '', is_html: false };
  });

  it('nothing is sent until a purpose is chosen', () => {
    app.composePurpose = null;
    app.sendOutboundEmail();
    expect(api.sendEmail).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('Choose the email purpose: Transactional / Direct or Marketing.');
  });

  it('the chosen purpose and the template id are sent; the duplicate-send key changes with the purpose', () => {
    app.composePurpose = 'transactional';
    app.sendOutboundEmail();
    const [body, confirmed, key1] = api.sendEmail.calls.mostRecent().args;
    expect(body.purpose).toBe('transactional');
    expect(body.templateId).toBeNull();
    expect(confirmed).toBeTrue();
    app.composePurpose = 'marketing';
    app.sendOutboundEmail();
    expect(api.sendEmail.calls.mostRecent().args[0].purpose).toBe('marketing');
    expect(api.sendEmail.calls.mostRecent().args[2]).not.toBe(key1);
  });

  it('a marketing template forces Marketing; Custom and Transactional templates leave the choice to the sender', () => {
    app.composeFromTemplate({ id: 4, name: 'Spring', category: 'Promotion', html: '<p>Sale</p>' });
    expect(app.composeTemplateIsMarketing).toBeTrue();
    expect(app.composePurpose).toBe('marketing');
    app.composeFromTemplate({ id: 5, name: 'Receipt', category: 'Transactional', html: '<p>Receipt</p>' });
    expect(app.composeTemplateIsMarketing).toBeFalse();
    expect(app.composePurpose).toBeNull();
    app.composeFromTemplate({ id: 6, name: 'Mine', category: 'Custom', html: '<p>x</p>' });
    expect(app.composeTemplateIsMarketing).toBeFalse();
    app.composePurpose = 'transactional';
    app.composeEmail.recipient_email = 'kim@client.io';
    app.composeEmail.subject = 'Hi';
    app.sendOutboundEmail();
    const body = api.sendHtmlEmail.calls.mostRecent().args[0];
    expect(body.templateId).toBe(6);
    expect(body.purpose).toBe('transactional');
  });

  it('a reply to an inbound email starts as Transactional / Direct (changeable)', () => {
    app.replyToEmail({ sender_email: 'kim@client.io', sender: 'Kim', subject: 'Question' });
    expect(app.composePurpose).toBe('transactional');
    expect(app.composeTemplate).toBeNull();
  });

  it('without mail.send_transactional, replies do not preselect Transactional', () => {
    app.myCaps = new Set(['mail.view', 'mail.send']);
    expect(app.canSendTransactional).toBeFalse();
    app.replyToEmail({ sender_email: 'kim@client.io', sender: 'Kim', subject: 'Question' });
    expect(app.composePurpose).toBeNull();
    app.myCaps = null;
    expect(app.canSendTransactional).withContext('unknown: the server decides').toBeTrue();
  });
});
