'use strict';

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 30);
const TRIAL_CREDITS = Number(process.env.TRIAL_CREDITS || 50);

module.exports = {
    async up(queryInterface, Sequelize) {
        // Paid credits never expire; trial credits only count until trial_until.
        await queryInterface.addColumn('clients', 'credits', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0});
        await queryInterface.addColumn('clients', 'trial_credits', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0});
        await queryInterface.addColumn('clients', 'trial_until', {type: Sequelize.DATE, allowNull: true});
        // admin (made in the admin site) or self (registered on the portal).
        await queryInterface.addColumn('clients', 'registered_via', {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'admin'});

        // What each check costs. Liveness does far more work than a lookup.
        await queryInterface.addColumn('modules', 'credit_cost', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 1});
        await queryInterface.sequelize.query("UPDATE modules SET credit_cost = 3 WHERE `key` = 'liveness-check'");

        await queryInterface.addColumn('api_requests', 'credits_charged', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0});

        // Every change to a client's credits.
        await queryInterface.createTable('credit_transactions', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.BIGINT},
            client_id: {type: Sequelize.INTEGER, allowNull: false, references: {model: 'clients', key: 'id'}, onDelete: 'CASCADE'},
            // trial_grant, trial_expiry, topup, usage, refund, adjustment
            kind: {type: Sequelize.STRING(16), allowNull: false},
            // + adds, - takes away. Paid and trial credits are kept apart.
            credits: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
            trial_credits: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
            credits_after: {type: Sequelize.INTEGER, allowNull: false},
            trial_credits_after: {type: Sequelize.INTEGER, allowNull: false},
            description: Sequelize.STRING(255),
            check_type: Sequelize.STRING(32),
            topup_id: Sequelize.INTEGER,
            admin_id: Sequelize.INTEGER,
            user_id: Sequelize.INTEGER,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('credit_transactions', ['client_id', 'created_at']);

        // Buying credits through Smatpay.
        await queryInterface.createTable('topups', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            client_id: {type: Sequelize.INTEGER, allowNull: false, references: {model: 'clients', key: 'id'}, onDelete: 'CASCADE'},
            user_id: Sequelize.INTEGER,
            // Ours, sent to Smatpay as the payer reference: SMT-<id>-<random>.
            reference: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            credits: {type: Sequelize.INTEGER, allowNull: false},
            amount: {type: Sequelize.DECIMAL(12, 2), allowNull: false},
            currency: {type: Sequelize.STRING(8), allowNull: false},
            method: {type: Sequelize.STRING(16), allowNull: false},
            payer_mobile: Sequelize.STRING(20),
            // pending → paid, or failed / cancelled / expired / refunded
            status: {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending'},
            payment_reference: Sequelize.STRING(128),
            payment_code: Sequelize.STRING(64),
            payment_url: Sequelize.STRING(2048),
            provider_status: Sequelize.STRING(64),
            failure_reason: Sequelize.STRING(255),
            paid_at: Sequelize.DATE,
            checked_at: Sequelize.DATE,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('topups', ['client_id', 'created_at']);
        await queryInterface.addIndex('topups', ['status', 'created_at']);

        // Clients made before credits existed get the standard trial, so their checks don't start failing.
        const until = new Date(Date.now() + TRIAL_DAYS * 86400000);
        const [clients] = await queryInterface.sequelize.query('SELECT id FROM clients');
        const now = new Date();
        for (const {id} of clients) {
            await queryInterface.bulkUpdate('clients', {trial_credits: TRIAL_CREDITS, trial_until: until}, {id});
            await queryInterface.bulkInsert('credit_transactions', [{
                client_id: id, kind: 'trial_grant', credits: 0, trial_credits: TRIAL_CREDITS,
                credits_after: 0, trial_credits_after: TRIAL_CREDITS,
                description: `Free trial: ${TRIAL_CREDITS} credits for ${TRIAL_DAYS} days`, created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('topups');
        await queryInterface.dropTable('credit_transactions');
        await queryInterface.removeColumn('api_requests', 'credits_charged');
        await queryInterface.removeColumn('modules', 'credit_cost');
        for (const c of ['registered_via', 'trial_until', 'trial_credits', 'credits']) await queryInterface.removeColumn('clients', c);
    },
};
