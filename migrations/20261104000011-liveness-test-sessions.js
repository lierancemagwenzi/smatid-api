'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Test sessions started from the portal's Developers page: free, and marked "test": true everywhere.
        await queryInterface.addColumn('liveness_sessions', 'test', {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false});
        await queryInterface.addIndex('liveness_sessions', ['client_id', 'test', 'created_at']);
    },

    async down(queryInterface) {
        await queryInterface.removeIndex('liveness_sessions', ['client_id', 'test', 'created_at']);
        await queryInterface.removeColumn('liveness_sessions', 'test');
    },
};
