'use strict';
module.exports = function (app) {
    const auth = require('../helpers/authHelper');
    const requestLog = require('../helpers/requestLogHelper');
    const modules = require('../helpers/moduleHelper');
    const company = require('../controllers/CompanyController');

    // Company registration check against the CIPZ register.
    app.route('/api/kyc/company/:number')
        .get(auth.requireClient, requestLog.log('company'), modules.requireModule('companies-check'), company.Check);

    // Sanctions and PEP screening of a person or company through OpenSanctions (yente).
    const sanctions = require('../controllers/SanctionsController');
    app.route('/api/kyc/sanctions')
        .post(auth.requireClient, requestLog.log('sanctions'), modules.requireModule('sanctions-check'), sanctions.Check);

    // Liveness: a client opens a session and sends the person to the hosted page at /liveness/<session>.
    const liveness = require('../controllers/LivenessController');
    app.route('/api/kyc/liveness')
        .post(auth.requireClient, requestLog.log('liveness'), modules.requireModule('liveness-check'), liveness.Create);
    app.route('/api/kyc/liveness/:sessionId')
        .get(auth.requireClient, requestLog.log('liveness'), modules.requireModule('liveness-check'), liveness.Show);
    app.route('/api/kyc/liveness/:sessionId/image')
        .get(auth.requireClient, modules.requireModule('liveness-check'), liveness.Image);

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
    app.route('/api/admin/stats')
        .get(auth.requireAdmin, usage.Stats);

    app.route('/health')
        .get((req, res) => res.json({status: 'ok'}));
};
