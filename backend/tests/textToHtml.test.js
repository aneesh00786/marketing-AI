const test = require('node:test');
const assert = require('node:assert/strict');
const { textToHtml } = require('../lib/mailContent');

// Compose "Write" sends plain text; its HTML part must keep the paragraphs and line breaks.
test('plain text keeps paragraphs and line breaks in the HTML part, and is escaped', () => {
  const html = textToHtml('Hi,\n\nI hope you are doing well.\r\n\r\nThank you.\n\n\nBest regards,\nAneesh <a@x.io> & "team"');
  assert.equal(html, [
    '<p style="margin:0 0 1em">Hi,</p>',
    '<p style="margin:0 0 1em">I hope you are doing well.</p>',
    '<p style="margin:0 0 1em">Thank you.</p>',
    '<p style="margin:0 0 1em">Best regards,<br>Aneesh &lt;a@x.io&gt; &amp; &quot;team&quot;</p>'
  ].join('\n'));
  assert.equal(textToHtml(''), '<p></p>');
  assert.equal(textToHtml('one line'), '<p style="margin:0 0 1em">one line</p>');
});
