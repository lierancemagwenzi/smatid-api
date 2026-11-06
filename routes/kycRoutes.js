'use strict';
module.exports = function (app) {
    const auth = require('../helpers/authHelper');
    const requestLog = require('../helpers/requestLogHelper');
    const modules = require('../helpers/moduleHelper');
    const billing = require('../helpers/billing/billingHelper');
    const company = require('../controllers/CompanyController');

    // Company registration check against the CIPZ register.
    app.route('/api/kyc/company/:number')
        .get(auth.requireClient, requestLog.log('company'), modules.requireModule('companies-check'), billing.charge('company'), company.Check);

    // Sanctions and PEP screening of a person or company through OpenSanctions (yente).
    const sanctions = require('../controllers/SanctionsController');
    app.route('/api/kyc/sanctions')
        .post(auth.requireClient, requestLog.log('sanctions'), modules.requireModule('sanctions-check'), billing.charge('sanctions'), sanctions.Check);

    // Liveness: a client opens a session and sends the person to the hosted page at /liveness/<session>.
    const liveness = require('../controllers/LivenessController');
    // Liveness is charged once, when the session is opened.
    app.route('/api/kyc/liveness')
        .post(auth.requireClient, requestLog.log('liveness'), modules.requireModule('liveness-check'), billing.charge('liveness'), liveness.Create);
    app.route('/api/kyc/liveness/:sessionId')
        .get(auth.requireClient, requestLog.log('liveness'), modules.requireModule('liveness-check'), liveness.Show);
    app.route('/api/kyc/liveness/:sessionId/image')
        .get(auth.requireClient, modules.requireModule('liveness-check'), liveness.Image);

    // Passport: the Smatid Flutter SDK sends the MRZ it read and the photo page picture, with the client's token.
    const passport = require('../controllers/PassportController');
    app.route('/api/kyc/passport')
        .post(auth.requireClient, requestLog.log('passport', {redact: ['image']}), modules.requireModule('passport-check'), billing.charge('passport'), passport.Scan);
    app.route('/api/kyc/passport/:scanId')
        .get(auth.requireClient, requestLog.log('passport'), modules.requireModule('passport-check'), passport.Show);
    app.route('/api/kyc/passport/:scanId/image')
        .get(auth.requireClient, modules.requireModule('passport-check'), passport.Image);
    // The passport's chip, read over NFC by the SDK after the photo page scan.
    app.route('/api/kyc/passport/:scanId/chip')
        .post(auth.requireClient, requestLog.log('passport_chip', {redact: ['files']}), modules.requireModule('passport-chip'), billing.charge('passport_chip'), passport.Chip);
    app.route('/api/kyc/passport/:scanId/chip/photo')
        .get(auth.requireClient, modules.requireModule('passport-chip'), passport.ChipPhoto);
    // The passport's photo against the face from a passed liveness check.
    app.route('/api/kyc/passport/:scanId/face-match')
        .post(auth.requireClient, requestLog.log('face_match'), modules.requireModule('face-match'), billing.charge('face_match'), passport.FaceMatch);

    // Verification sessions: a client opens one, the person does it in the Smatid Verify app, the client
    // reads the result. Each check the app runs is logged and charged to that client, as above.
    const verification = require('../controllers/VerificationController');
    app.route('/api/kyc/verifications')
        .post(auth.requireClient, verification.Create);
    app.route('/api/kyc/verifications/:verificationId')
        .get(auth.requireClient, verification.Show);

    // The Smatid Verify app: no token, the session's ID is the key.
    const vs = verification.requireSession;
    app.route('/api/verify/claim')
        .post(verification.Claim);
    app.route('/api/verify/:verificationId')
        .get(vs(), verification.AppShow);
    app.route('/api/verify/:verificationId/complete')
        .post(vs(), verification.Complete);
    app.route('/api/verify/:verificationId/cancel')
        .post(vs(), verification.Cancel);
    app.route('/api/verify/:verificationId/passport')
        .post(vs('passport'), requestLog.log('passport', {redact: ['image']}), modules.requireModule('passport-check'), billing.charge('passport'),
            verification.link('passport_scan_id', 'scan_id'), passport.Scan);
    app.route('/api/verify/:verificationId/passport/:scanId/chip')
        .post(vs('chip'), verification.ownsScan, requestLog.log('passport_chip', {redact: ['files']}), modules.requireModule('passport-chip'),
            billing.charge('passport_chip'), passport.Chip);
    app.route('/api/verify/:verificationId/passport/:scanId/chip/photo')
        .get(vs(), verification.ownsScan, modules.requireModule('passport-chip'), passport.ChipPhoto);
    app.route('/api/verify/:verificationId/passport/:scanId/face-match')
        .post(vs('face_match'), verification.ownsScan, verification.sameLiveness, requestLog.log('face_match'), modules.requireModule('face-match'),
            billing.charge('face_match'), passport.FaceMatch);
    app.route('/api/verify/:verificationId/liveness')
        .post(vs('liveness'), requestLog.log('liveness'), modules.requireModule('liveness-check'), billing.charge('liveness'),
            verification.link('liveness_session_id', 'session_id'), liveness.Create);
    app.route('/api/verify/:verificationId/liveness/:sessionId')
        .get(vs(), verification.ownsLiveness, modules.requireModule('liveness-check'), liveness.Show);
    app.route('/api/verify/:verificationId/liveness/:sessionId/image')
        .get(vs(), verification.ownsLiveness, modules.requireModule('liveness-check'), liveness.Image);

    // The client's default webhook, used by sessions that don't give their own.
    app.route('/api/kyc/webhook')
        .get(auth.requireClient, liveness.Webhook)
        .put(auth.requireClient, liveness.SetWebhook);

    // The secret that signs webhooks to this client. Not logged: the reply holds the secret.
    app.route('/api/kyc/webhook-secret')
        .get(auth.requireClient, liveness.WebhookSecret);
    app.route('/api/kyc/webhook-secret/rotate')
        .post(auth.requireClient, liveness.RotateWebhookSecret);

    // The hosted page and the calls it makes. The session ID in the link is their only key.
    app.route('/liveness/:sessionId')
        .get(liveness.Page);
    app.route('/api/liveness/:sessionId')
        .get(modules.requireModule('liveness-check'), liveness.PageInfo);
    app.route('/api/liveness/:sessionId/qr.svg')
        .get(modules.requireModule('liveness-check'), liveness.QrCode);
    app.route('/api/liveness/:sessionId/start')
        .post(modules.requireModule('liveness-check'), liveness.Start);
    app.route('/api/liveness/:sessionId/submit')
        .post(modules.requireModule('liveness-check'), liveness.Submit);

    // Admin sign-in for the /admin pages. Everything else under /api/admin needs a session or X-Admin-Key.
    const admin = require('../controllers/AdminController');
    app.route('/api/admin/login')
        .post(admin.Login);
    app.route('/api/admin/logout')
        .post(auth.requireAdmin, admin.Logout);
    app.route('/api/admin/me')
        .get(auth.requireAdmin, admin.Me);

    // Admin: the clients allowed to call the KYC API, and their access tokens.
    const clients = require('../controllers/ClientController');
    app.route('/api/admin/clients')
        .get(auth.requireAdmin, clients.List)
        .post(auth.requireAdmin, clients.Create);
    app.route('/api/admin/clients/:id')
        .get(auth.requireAdmin, clients.Show)
        .patch(auth.requireAdmin, clients.Update);
    app.route('/api/admin/clients/:id/revoke')
        .post(auth.requireAdmin, clients.Revoke);
    app.route('/api/admin/clients/:id/credits')
        .post(auth.requireAdmin, clients.AdjustCredits);
    app.route('/api/admin/clients/:id/transactions')
        .get(auth.requireAdmin, clients.Transactions);
    app.route('/api/admin/clients/:id/users')
        .get(auth.requireAdmin, clients.Users)
        .post(auth.requireAdmin, clients.AddUser);
    app.route('/api/admin/clients/:id/users/:userId')
        .delete(auth.requireAdmin, clients.RemoveUser);
    app.route('/api/admin/clients/:id/users/:userId/resend-invite')
        .post(auth.requireAdmin, clients.ResendInvite);
    app.route('/api/admin/clients/:id/topups')
        .get(auth.requireAdmin, clients.Topups)
        .post(auth.requireAdmin, clients.ManualTopup);
    app.route('/api/admin/clients/:id/credit-usage')
        .get(auth.requireAdmin, clients.CreditUsage);
    app.route('/api/admin/topups')
        .get(auth.requireAdmin, clients.Topups);

    // Admin: the Smatpay merchant that receives top-ups. Keys are stored encrypted and never sent back.
    const settingsAdmin = require('../controllers/SettingsController');
    app.route('/api/admin/settings/payments')
        .get(auth.requireAdmin, settingsAdmin.Payments)
        .put(auth.requireAdmin, settingsAdmin.SavePayments);
    app.route('/api/admin/settings/payments/test')
        .post(auth.requireAdmin, settingsAdmin.TestPayments);

    // Admin: the KYC modules (checks) and whether each is switched on.
    const moduleAdmin = require('../controllers/ModuleController');
    app.route('/api/admin/modules')
        .get(auth.requireAdmin, moduleAdmin.List)
        .post(auth.requireAdmin, moduleAdmin.Create);
    app.route('/api/admin/modules/:id')
        .patch(auth.requireAdmin, moduleAdmin.Update);

    // Admin: logged KYC calls (see helpers/requestLogHelper.js) and counts for the dashboard.
    const usage = require('../controllers/UsageController');
    app.route('/api/admin/requests')
        .get(auth.requireAdmin, usage.List);
    app.route('/api/admin/requests/:id')
        .get(auth.requireAdmin, usage.Show);
    app.route('/api/admin/liveness/:sessionId')
        .get(auth.requireAdmin, liveness.AdminShow);
    app.route('/api/admin/liveness/:sessionId/frames/:frame')
        .get(auth.requireAdmin, liveness.AdminFrame);
    app.route('/api/admin/passport/:scanId')
        .get(auth.requireAdmin, passport.AdminShow);
    app.route('/api/admin/passport/:scanId/image')
        .get(auth.requireAdmin, passport.AdminImage);
    app.route('/api/admin/passport/:scanId/chip/photo')
        .get(auth.requireAdmin, passport.AdminChipPhoto);
    // The CSCA certificates passport chips are checked against; POST reads config/csca/ again.
    app.route('/api/admin/csca')
        .get(auth.requireAdmin, passport.AdminCsca)
        .post(auth.requireAdmin, passport.AdminCsca);
    app.route('/api/admin/stats')
        .get(auth.requireAdmin, usage.Stats);

    // Client portal: accounts. Registration, sign-in and recovery need no session.
    const account = require('../controllers/AccountController');
    const portalAuth = require('../helpers/portalAuthHelper');
    app.route('/api/portal/register').post(account.Register);
    app.route('/api/portal/verify-email').post(account.VerifyEmail);
    app.route('/api/portal/resend-verification').post(account.ResendVerification);
    app.route('/api/portal/login').post(account.Login);
    app.route('/api/portal/forgot-password').post(account.ForgotPassword);
    app.route('/api/portal/reset-password').post(account.ResetPassword);
    app.route('/api/portal/logout').post(portalAuth.requireUser, account.Logout);
    app.route('/api/portal/me').get(portalAuth.requireUser, account.Me);
    app.route('/api/portal/password').post(portalAuth.requireUser, account.ChangePassword);

    // Client portal: the signed-in company's own dashboard, usage, credits, team and developer settings.
    const portal = require('../controllers/PortalController');
    const user = portalAuth.requireUser;
    const owner = [portalAuth.requireUser, portalAuth.requireOwner];
    app.route('/api/portal/dashboard').get(user, portal.Dashboard);
    app.route('/api/portal/usage').get(user, portal.Usage);
    app.route('/api/portal/usage/:id').get(user, portal.UsageDetail);
    app.route('/api/portal/transactions').get(user, portal.Transactions);
    app.route('/api/portal/topup-options').get(user, portal.TopupOptions);
    app.route('/api/portal/topups').get(user, portal.Topups).post(user, portal.CreateTopup);
    app.route('/api/portal/topups/:id').get(user, portal.Topup);
    app.route('/api/portal/developers').get(user, portal.Developers);
    app.route('/api/portal/api-token').post(...owner, portal.CreateApiToken);
    app.route('/api/portal/webhook').put(...owner, portal.SetWebhook);
    app.route('/api/portal/webhook-secret').get(...owner, portal.WebhookSecret);
    app.route('/api/portal/webhook-secret/rotate').post(...owner, portal.RotateWebhookSecret);
    app.route('/api/portal/team').get(user, portal.Team).post(...owner, portal.Invite);
    app.route('/api/portal/team/:id').delete(...owner, portal.RemoveUser);

    // Client portal: run a check by hand. The same log, module switches and credits as the API calls above.
    const checkAs = [portalAuth.requireUser, portalAuth.asClient];
    app.route('/api/portal/checks').get(user, portal.CheckOptions);

    // Client portal: free liveness test sessions, for the Developers page. Not charged or logged as usage.
    app.route('/api/portal/liveness-tests').post(user, modules.requireModule('liveness-check'), liveness.PortalTestCreate);
    app.route('/api/portal/liveness-tests/:sessionId').get(user, liveness.PortalTestShow);
    app.route('/api/portal/checks/company')
        .post(...checkAs, requestLog.log('company'), modules.requireModule('companies-check'), billing.charge('company'), company.Check);
    app.route('/api/portal/checks/sanctions')
        .post(...checkAs, requestLog.log('sanctions'), modules.requireModule('sanctions-check'), billing.charge('sanctions'), sanctions.Check);

    // Public: what checks cost, for the website's pricing section. No sign-in.
    app.route('/api/public/pricing').get(async (req, res) => {
        try {
            const cfg = billing.config();
            const mods = await require('../models').kyc_module.findAll({where: {status: 'enabled'}, order: [['id', 'ASC']]});
            res.set('Cache-Control', 'public, max-age=300');
            res.json({
                currency: cfg.currency,
                credit_price: cfg.credit_price,
                trial: {days: cfg.trial_days, credits: cfg.trial_credits},
                packages: cfg.packages.map((credits) => ({credits, amount: billing.priceOf(credits)})),
                checks: mods.map((m) => ({key: m.key, name: m.name, credit_cost: m.credit_cost})),
            });
        } catch (err) {
            console.error('Pricing failed:', err.message);
            res.status(503).json({error: 'pricing_unavailable'});
        }
    });

    app.route('/health')
        .get((req, res) => res.json({status: 'ok'}));
};
