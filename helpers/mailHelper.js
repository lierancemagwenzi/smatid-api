const sgMail = require('@sendgrid/mail');

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = {
    sgMail,

    /** The email a new client gets with its access token. */
    accessTokenEmail: function (client, token) {
        const name = escapeHtml(client.name);
        return {
            subject: 'Your SmatPay KYC API access token',
            text: [
                `Hello ${client.name},`,
                '',
                'Your access to the SmatPay KYC API is ready. Your access token is:',
                '',
                token,
                '',
                'Send it with every request as the header:',
                `Authorization: Bearer ${token}`,
                '',
                'Keep it secret. We only store a fingerprint of it, so we cannot show it to you again. '
                + 'If it is lost or leaked, ask us to revoke it and issue a new one.',
            ].join('\n'),
            html: `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2a35;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 12px;font-size:20px;">Your SmatPay KYC API access token</h1>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">Hello ${name}, your access to the SmatPay KYC API is ready. Your access token is:</p>
        <p style="margin:0 0 16px;padding:14px;background:#f0f3f6;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:14px;word-break:break-all;">${escapeHtml(token)}</p>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.6;">Send it with every request as the header:</p>
        <p style="margin:0 0 16px;font-family:Menlo,Consolas,monospace;font-size:13px;word-break:break-all;">Authorization: Bearer ${escapeHtml(token)}</p>
        <p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#5b6b78;">Keep it secret. We only store a fingerprint of it, so we cannot show it to you again. If it is lost or leaked, ask us to revoke it and issue a new one.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
        };
    },

    /** Sends a new client its access token. Resolves true when SendGrid accepted it. */
    sendAccessToken: async function (client, token) {
        if (!process.env.SENDGRID_API_KEY) {
            console.error('Access token email not sent: SENDGRID_API_KEY is not set');
            return false;
        }
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        const {subject, text, html} = this.accessTokenEmail(client, token);
        try {
            const [res] = await sgMail.send({
                to: client.email,
                from: {email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'SmatPay KYC'},
                subject,
                text,
                html,
                // Keep the token out of SendGrid's click-tracking redirects.
                trackingSettings: {clickTracking: {enable: false, enableText: false}},
            });
            console.log(`Access token email for client ${client.id} accepted by SendGrid (${res.statusCode})`);
            return true;
        } catch (err) {
            const detail = err.response && err.response.body ? JSON.stringify(err.response.body.errors) : err.message;
            console.error(`Access token email for client ${client.id} failed:`, detail);
            return false;
        }
    },
};
