const sgMail = require('@sendgrid/mail');

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Where the client portal is, for links in emails. */
const portalUrl = () => (process.env.PORTAL_URL || 'http://localhost:5173').replace(/\/$/, '');

/** Every email's HTML: a white card with a title, paragraphs and an optional button. Text is escaped here. */
function layout({title, paragraphs, button, code, footnote}) {
    const p = (text) => `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${escapeHtml(text)}</p>`;
    return `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1d2a35;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
    <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:28px 28px 8px;">
        <h1 style="margin:0 0 12px;font-size:20px;">${escapeHtml(title)}</h1>
        ${paragraphs.map(p).join('\n        ')}
        ${code ? `<p style="margin:0 0 16px;padding:14px;background:#f0f3f6;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:14px;word-break:break-all;">${escapeHtml(code)}</p>` : ''}
        ${button ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 22px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">${escapeHtml(button.label)}</a></p>
        <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#5b6b78;">If the button doesn’t work, copy this into your browser:<br>${escapeHtml(button.url)}</p>` : ''}
        ${footnote ? `<p style="margin:0 0 24px;font-size:13px;line-height:1.6;color:#5b6b78;">${escapeHtml(footnote)}</p>` : ''}
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function text({title, paragraphs, button, code, footnote}) {
    return [title, '', ...paragraphs.flatMap((x) => [x, '']), ...(code ? [code, ''] : []), ...(button ? [`${button.label}: ${button.url}`, ''] : []), ...(footnote ? [footnote] : [])].join('\n').trim();
}

module.exports = {
    sgMail,
    portalUrl,

    /** Sends one email. Resolves true when SendGrid accepted it, false otherwise (and logs why). */
    send: async function (to, subject, content, label) {
        if (!process.env.SENDGRID_API_KEY) {
            console.error(`${label} email not sent: SENDGRID_API_KEY is not set`);
            return false;
        }
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        try {
            const [res] = await sgMail.send({
                to,
                from: {email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'Smatid KYC'},
                subject,
                text: text(content),
                html: layout(content),
                // Keep tokens and one-time links out of SendGrid's click-tracking redirects.
                trackingSettings: {clickTracking: {enable: false, enableText: false}},
            });
            console.log(`${label} email accepted by SendGrid (${res.statusCode})`);
            return true;
        } catch (err) {
            const detail = err.response && err.response.body ? JSON.stringify(err.response.body.errors) : err.message;
            console.error(`${label} email failed:`, detail);
            return false;
        }
    },

    /**
     * The email a new client gets with its access token, and (when the admin made the client) a link to
     * set a password for the client portal.
     */
    accessTokenEmail: function (client, token, setupUrl) {
        const content = {
            title: 'Your Smatid KYC API access token',
            paragraphs: [
                `Hello ${client.name}, your access to the Smatid KYC API is ready. Your access token is:`,
            ],
            code: token,
            footnote: `Send it with every request as the header "Authorization: Bearer ${token}". Keep it secret. We only store a fingerprint of it, so we cannot show it to you again. If it is lost or leaked, ask us to revoke it and issue a new one.`,
        };
        if (setupUrl) {
            content.paragraphs.push('You also have an account on the Smatid KYC portal, where you can see your credits and usage, top up, and add your team. Set your password to sign in:');
            content.button = {label: 'Set up your account', url: setupUrl};
            content.footnote += ' The set-up link works for 7 days.';
        }
        return {subject: content.title, text: text(content), html: layout(content)};
    },

    /** Sends a new client its access token (and portal set-up link). Resolves true when SendGrid accepted it. */
    sendAccessToken: async function (client, token, setupUrl) {
        if (!process.env.SENDGRID_API_KEY) {
            console.error('Access token email not sent: SENDGRID_API_KEY is not set');
            return false;
        }
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        const {subject, text: body, html} = this.accessTokenEmail(client, token, setupUrl);
        try {
            const [res] = await sgMail.send({
                to: client.email,
                from: {email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'Smatid KYC'},
                subject,
                text: body,
                html,
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

    sendVerifyEmail: function (user, token) {
        return this.send(user.email, 'Confirm your email for Smatid KYC', {
            title: 'Confirm your email',
            paragraphs: [`Hello ${user.name}, thanks for signing up for Smatid KYC.`, 'Confirm your email address to start your free trial.'],
            button: {label: 'Confirm my email', url: `${portalUrl()}/verify-email?token=${encodeURIComponent(token)}`},
            footnote: 'This link works for 24 hours. If you didn’t sign up, you can ignore this email.',
        }, `Verification for user ${user.id}`);
    },

    /** Someone tried to register with an email that already has an account. */
    sendAlreadyRegistered: function (user) {
        return this.send(user.email, 'You already have a Smatid KYC account', {
            title: 'You already have an account',
            paragraphs: [`Hello ${user.name}, someone tried to sign up for Smatid KYC with this email address, which already has an account.`, 'If it was you, sign in instead, or reset your password if you’ve forgotten it.'],
            button: {label: 'Sign in', url: `${portalUrl()}/login`},
            footnote: 'If it wasn’t you, you can ignore this email: nothing has changed.',
        }, `Already-registered notice for user ${user.id}`);
    },

    sendPasswordReset: function (user, token) {
        return this.send(user.email, 'Reset your Smatid KYC password', {
            title: 'Reset your password',
            paragraphs: [`Hello ${user.name}, we got a request to reset the password for your Smatid KYC account.`],
            button: {label: 'Choose a new password', url: `${portalUrl()}/reset-password?token=${encodeURIComponent(token)}`},
            footnote: 'This link works for 1 hour and can be used once. If you didn’t ask for this, ignore this email: your password stays the same.',
        }, `Password reset for user ${user.id}`);
    },

    sendInvite: function (user, inviter, client, token) {
        return this.send(user.email, `You’ve been invited to ${client.name} on Smatid KYC`, {
            title: `Join ${client.name} on Smatid KYC`,
            paragraphs: [`Hello ${user.name}, ${inviter ? inviter.name : 'the Smatid KYC team'} has invited you to ${client.name}’s Smatid KYC account, where you can see its checks, credits and usage.`],
            button: {label: 'Accept and set a password', url: `${portalUrl()}/accept-invite?token=${encodeURIComponent(token)}`},
            footnote: 'This invitation works for 7 days.',
        }, `Invite for user ${user.id}`);
    },

    sendTopupReceipt: function (user, client, topup) {
        const to = (user && user.email) || client.email;
        if (!to) return Promise.resolve(false);
        return this.send(to, `Receipt: ${topup.credits} Smatid KYC credits`, {
            title: 'Payment received',
            paragraphs: [
                `Thank you. We received ${topup.currency} ${Number(topup.amount).toFixed(2)} and added ${topup.credits} credits to ${client.name}.`,
                `Reference: ${topup.reference}`,
                `Your balance is now ${client.balance().available_credits} credits.`,
            ],
            button: {label: 'View your account', url: `${portalUrl()}/app/credits`},
        }, `Top-up receipt ${topup.reference}`);
    },
};
