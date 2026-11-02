'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // The client's default webhook: used by any liveness session that doesn't give its own webhook_url.
        await queryInterface.addColumn('clients', 'webhook_url', {type: Sequelize.STRING(2048), allowNull: true});
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('clients', 'webhook_url');
    },
};
