'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // Settings an admin changes in the admin site, e.g. the Smatpay merchant. Secret values are
        // encrypted with SETTINGS_ENCRYPTION_KEY (see helpers/settingsHelper.js).
        await queryInterface.createTable('settings', {
            key: {allowNull: false, primaryKey: true, type: Sequelize.STRING(64)},
            value: Sequelize.TEXT,
            updated_by_admin_id: Sequelize.INTEGER,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('settings');
    },
};
