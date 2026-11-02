'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Signs the webhooks sent to this client, so it can tell they came from Smatid.
        await queryInterface.addColumn('clients', 'webhook_secret', {type: Sequelize.STRING(80), allowNull: true});

        // Where to send a session's result when it finishes, and how the sending went.
        await queryInterface.addColumn('liveness_sessions', 'webhook_url', {type: Sequelize.STRING(2048), allowNull: true});
        // null (no webhook), pending, delivered or failed.
        await queryInterface.addColumn('liveness_sessions', 'webhook_status', {type: Sequelize.STRING(16), allowNull: true});
        await queryInterface.addColumn('liveness_sessions', 'webhook_attempts', {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0});
        await queryInterface.addColumn('liveness_sessions', 'webhook_next_at', {type: Sequelize.DATE, allowNull: true});
        await queryInterface.addColumn('liveness_sessions', 'webhook_last_error', {type: Sequelize.STRING(255), allowNull: true});
        await queryInterface.addColumn('liveness_sessions', 'webhook_delivered_at', {type: Sequelize.DATE, allowNull: true});
        await queryInterface.addIndex('liveness_sessions', ['webhook_status', 'webhook_next_at']);
        await queryInterface.addIndex('liveness_sessions', ['status', 'expires_at']);
    },

    async down(queryInterface) {
        for (const column of ['webhook_url', 'webhook_status', 'webhook_attempts', 'webhook_next_at', 'webhook_last_error', 'webhook_delivered_at']) {
            await queryInterface.removeColumn('liveness_sessions', column);
        }
        await queryInterface.removeColumn('clients', 'webhook_secret');
    },
};
