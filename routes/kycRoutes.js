'use strict';
module.exports = function (app) {
    const auth = require('../helpers/authHelper');
    const requestLog = require('../helpers/requestLogHelper');
    const company = require('../controllers/CompanyController');

    // Company registration check against the CIPZ register.
    app.route('/api/kyc/company/:number')
        .get(auth.requireClient, requestLog.log('company'), company.Check);

    // Sanctions and PEP screening of a person or company through OpenSanctions (yente).
    const sanctions = require('../controllers/SanctionsController');
    app.route('/api/kyc/sanctions')
        .post(auth.requireClient, requestLog.log('sanctions'), sanctions.Check);

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
        .get(auth.requireAdmin, clients.Show);
    app.route('/api/admin/clients/:id/revoke')
        .post(auth.requireAdmin, clients.Revoke);

    // Admin: logged KYC calls (see helpers/requestLogHelper.js) and counts for the dashboard.
    const usage = require('../controllers/UsageController');
    app.route('/api/admin/requests')
        .get(auth.requireAdmin, usage.List);
    app.route('/api/admin/requests/:id')
        .get(auth.requireAdmin, usage.Show);
    app.route('/api/admin/stats')
        .get(auth.requireAdmin, usage.Stats);

    app.route('/health')
        .get((req, res) => res.json({status: 'ok'}));
};
