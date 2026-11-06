/**
 * A ready-made campaign email to start from: email-safe layout (600px table, inline styles),
 * merge tags (first name with a default, unsubscribe) and [bracketed] parts to fill in, including
 * your company address. Approval is blocked while any [bracket]
 * is left, and the server flags the sample example.com link, so it cannot go out half-edited.
 */
/** "you", not "there": a subject is not a greeting ("A quick idea for you"). */
export const SAMPLE_SUBJECT = 'A quick idea for $[FNAME|you]$';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function sampleCampaignHtml(company?: string): string {
  const name = esc(String(company || '').trim().slice(0, 80)) || '[Your company]';
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${name}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;">[Preview text: one line people see next to the subject in their inbox]</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
      <tr><td style="padding:16px 32px;border-bottom:3px solid #4f46e5;font-size:22px;font-weight:bold;color:#4f46e5;">${name}</td></tr>
      <tr><td style="padding:28px 32px 8px;font-size:16px;line-height:1.6;">
        <p style="margin:0 0 16px;">Hi $[FNAME|there]$,</p>
        <p style="margin:0 0 16px;">We help businesses like yours [main result you deliver, e.g. cut packaging costs by 15%].</p>
        <p style="margin:0 0 8px;"><strong>Here is what you get:</strong></p>
        <ul style="margin:0 0 16px;padding-left:20px;">
          <li style="margin-bottom:6px;">[Benefit 1, e.g. next-day delivery]</li>
          <li style="margin-bottom:6px;">[Benefit 2, e.g. no minimum order]</li>
          <li style="margin-bottom:6px;">[Benefit 3, e.g. a dedicated account manager]</li>
        </ul>
        <p style="margin:0 0 24px;">[Your offer in one sentence, e.g. Book a free 15-minute call this week and we will send you a sample pack.]</p>
      </td></tr>
      <tr><td align="center" style="padding:0 32px 28px;">
        <a href="https://example.com" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:12px 28px;border-radius:6px;">Book a call</a>
      </td></tr>
      <tr><td style="padding:0 32px 28px;font-size:16px;line-height:1.6;">
        <p style="margin:0;">Thanks,<br />[Your name]<br />[Your role], ${name}<br />[Phone number]</p>
      </td></tr>
      <tr><td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
        <p style="margin:0 0 8px;">You are receiving this email because you are a business contact of ${name}.</p>
        <p style="margin:0 0 8px;">[Your company address]</p>
        <p style="margin:0;"><a href="$[LI:UNSUBSCRIBE]$" style="color:#6b7280;">Unsubscribe</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
