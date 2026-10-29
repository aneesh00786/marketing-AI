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

  it('a reply quotes the original and invents no text; forward and send again open Compose without sending', () => {
    app.replyToEmail({ sender_email: 'kim@client.io', sender: 'Kim', subject: 'Question', body: 'What does it cost?', received_at: '2026-10-28 10:00' });
    expect(app.composeEmail.recipient_email).toBe('kim@client.io');
    expect(app.composeEmail.subject).toBe('Re: Question');
    expect(app.composeEmail.body).toContain('> What does it cost?');
    expect(app.composeEmail.body).not.toContain('demonstration');

    app.forwardEmail({ sender_email: 'kim@client.io', subject: 'Question', body: 'What does it cost?', html_body: '' });
    expect([app.composeEmail.recipient_email, app.composeEmail.subject, app.composePurpose]).toEqual(['', 'Fwd: Question', null]);
    expect(app.composeEmail.body).toContain('Forwarded message');

    app.sendEmailAgain({ recipient_email: 'max@client.io', subject: 'Setup', body: 'x', html_body: '<p>x</p>', purpose: 'marketing' });
    expect([app.composeEmail.recipient_email, app.composeEmail.html_body, app.composePurpose, app.showComposeModal]).toEqual(['max@client.io', '<p>x</p>', 'marketing', true]);
    expect(api.sendHtmlEmail).not.toHaveBeenCalled();
    expect(api.sendEmail).not.toHaveBeenCalled();
  });

  it('Compose points out what is missing and sends nothing until the email is complete', () => {
    app.openCompose();
    expect(app.composeTab).toBe('write');
    app.trySendCompose();
    expect(app.composeTouched).toBeTrue();
    expect(app.composeProblems).toEqual(['a valid recipient email', 'a subject', 'the email purpose', 'a message']);
    expect(api.sendEmail).not.toHaveBeenCalled();
    app.composeEmail.recipient_email = 'not-an-address';
    app.composeEmail.subject = 'Hi';
    app.composeEmail.body = 'Plain text written in the Write tab';
    app.composePurpose = 'transactional';
    expect(app.composeProblems).toEqual(['a valid recipient email']);
    app.composeEmail.recipient_email = 'kim@client.io';
    app.trySendCompose();
    expect(api.sendEmail).toHaveBeenCalledTimes(1);
    expect(api.sendEmail.calls.mostRecent().args[0].body).toBe('Plain text written in the Write tab');
  });

  it('closing Compose with content asks first and keeps it when the user cancels', () => {
    (window.confirm as jasmine.Spy).and.returnValue(false);
    app.showComposeModal = true;
    app.closeCompose();
    expect(app.showComposeModal).withContext('kept open').toBeTrue();
    (window.confirm as jasmine.Spy).and.returnValue(true);
    app.closeCompose();
    expect(app.showComposeModal).toBeFalse();
    app.openCompose();
    (window.confirm as jasmine.Spy).calls.reset();
    app.closeCompose();
    expect(window.confirm).withContext('an empty email closes without asking').not.toHaveBeenCalled();
  });
});
