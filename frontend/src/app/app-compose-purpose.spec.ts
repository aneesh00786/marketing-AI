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
      sendLeadEmail: jasmine.createSpy('sendLeadEmail').and.returnValue(of({ message: 'sent' })),
      getEmails: () => of({ emails: [] })
    };
    app = new AppComponent(api, {} as any, {} as any, {} as any);
    spyOn(app, 'showToast');
    spyOn(window, 'confirm').and.returnValue(true);
    app.composeEmail = { recipient_email: 'kim@client.io', recipient_name: 'Kim', subject: 'Hello', body: 'Hi', html_body: '', is_html: false };
  });

  it('a campaign follow-up opens Compose prefilled; the purpose is still chosen by the sender and nothing is sent', () => {
    app.showComposeModal = false;
    app.openComposeFor({ email: 'ann@acme.io', name: 'Ann Lee', subject: 'Following up: Spring offer', body: 'Hi Ann,\n\n' });
    expect(app.showComposeModal).toBeTrue();
    expect(app.composeEmail).toEqual(jasmine.objectContaining({ recipient_email: 'ann@acme.io', recipient_name: 'Ann Lee', subject: 'Following up: Spring offer', body: 'Hi Ann,\n\n' }));
    expect(app.composePurpose).toBeNull();
    expect(api.sendEmail).not.toHaveBeenCalled();
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
    // The editor holds only the reply; the original is folded below it and sent quoted.
    expect(app.composeEmail.body).toBe('');
    expect(app.composeQuote?.text).toBe('What does it cost?');
    expect(app.composeQuote?.attribution).toMatch(/Kim <kim@client\.io> wrote:$/);
    app.composeEmail.body = 'It costs 10 euros.';
    expect(app.composeBodyOut).toMatch(/^It costs 10 euros\.\n\nOn .*Kim <kim@client\.io> wrote:\n> What does it cost\?$/);
    expect(app.composeBodyOut).not.toContain('demonstration');
    app.composeEmail.html_body = '<p>It costs 10 euros.</p>';
    expect(app.composeHtmlOut).toContain('<blockquote class="gmail_quote"');
    expect(app.composeHtmlOut).toContain('What does it cost?</blockquote>');
    app.composeQuote = null;
    expect(app.composeBodyOut).toBe('It costs 10 euros.');

    app.forwardEmail({ sender_email: 'kim@client.io', subject: 'Question', body: 'What does it cost?', html_body: '' });
    expect([app.composeEmail.recipient_email, app.composeEmail.subject, app.composePurpose]).toEqual(['', 'Fwd: Question', null]);
    expect(app.composeEmail.body).toContain('Forwarded message');
    expect(app.composeQuote).toBeNull();

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

  it('✉ next to a lead\'s email opens Compose to that lead and sends through Leads; another address goes the normal way', () => {
    app.emailLeadDirect({ id: 42, name: 'Kim Lee', email: 'kim@kimco.io', productName: 'Spring offer' });
    expect(app.showComposeModal).toBeTrue();
    expect(app.composeEmail.recipient_email).toBe('kim@kimco.io');
    expect(app.composeEmail.subject).toBe('Following up: Spring offer');
    expect(app.composeEmail.body).toBe('Hi Kim,\n\n');
    app.composeEmail.body = 'Hi Kim,\n\nNews.';
    app.composePurpose = 'marketing';
    app.trySendCompose();
    expect(api.sendLeadEmail).toHaveBeenCalledTimes(1);
    expect(api.sendLeadEmail.calls.mostRecent().args[0]).toBe(42);
    expect(api.sendEmail).not.toHaveBeenCalled();
    // The address changed in Compose: not the lead's any more, so the normal Compose send.
    app.emailLeadDirect({ id: 42, name: 'Kim Lee', email: 'kim@kimco.io' });
    app.composeEmail.recipient_email = 'other@kimco.io';
    app.composeEmail.body = 'Hi';
    app.composePurpose = 'marketing';
    app.trySendCompose();
    expect(api.sendEmail).toHaveBeenCalledTimes(1);
    expect(api.sendLeadEmail).toHaveBeenCalledTimes(1);
  });

  it('staff without a verified sender address cannot send; with one, Compose sends from it', () => {
    app.sendersLoaded = true; app.sendersRequired = true; app.mySenders = [];
    app.composeEmail = { recipient_email: 'kim@client.io', recipient_name: 'Kim', subject: 'Hello', body: 'Hi', html_body: '', is_html: false };
    app.composePurpose = 'marketing';
    app.trySendCompose();
    expect(app.composeProblems).toContain('your own verified sender address (My sender email)');
    expect(api.sendEmail).not.toHaveBeenCalled();
    app.mySenders = [{ email: 'anita@thrive-co.io', name: 'Anita' }];
    app.composeFrom = 'anita@thrive-co.io';
    app.trySendCompose();
    expect(api.sendEmail).toHaveBeenCalledTimes(1);
    expect(api.sendEmail.calls.mostRecent().args[0].from_email).toBe('anita@thrive-co.io');
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

  it('a reply to a received email links it, and answering its sender may be transactional without the permission; a forward may not', () => {
    app.myCaps = new Set(['mail.view', 'mail.send']);
    app.replyToEmail({ id: 42, direction: 'received', sender: 'Kim', sender_email: 'Kim@Client.io', subject: 'Question', body: 'Hi?' });
    expect(app.composeReplyTo).toEqual({ id: 42, email: 'kim@client.io' });
    expect(app.composeCanTransactional).toBeTrue();
    expect(app.composePurpose).toBe('transactional');
    app.sendOutboundEmail();
    expect(api.sendEmail.calls.mostRecent().args[0].reply_to_email_id).toBe(42);
    // Sent to someone else, it is no longer an answer to the sender.
    app.composeEmail.recipient_email = 'boss@client.io';
    expect(app.composeCanTransactional).toBeFalse();
    app.forwardEmail({ id: 42, sender_email: 'kim@client.io', subject: 'Question', body: 'Hi?' });
    expect(app.composeReplyTo).toBeNull();
    expect(app.composeCanTransactional).toBeFalse();
  });
});
