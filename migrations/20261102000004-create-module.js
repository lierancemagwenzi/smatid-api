'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('modules', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            // What the code checks, e.g. "sanctions-check". Never changes once created.
            key: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            name: {type: Sequelize.STRING, allowNull: false},
            description: Sequelize.TEXT,
            status: {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'enabled'},

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });

        // The checks that already exist, switched on, so deploying this changes nothing for clients.
        const now = new Date();
        await queryInterface.bulkInsert('modules', [
            {
                key: 'companies-check', name: 'Company registration', status: 'enabled',
                description: 'Looks up a company on the CIPZ register.', created_at: now, updated_at: now,
            },
            {
                key: 'sanctions-check', name: 'Sanctions & PEP screening', status: 'enabled',
                description: 'Screens a person or company against sanctions and PEP lists (OpenSanctions).', created_at: now, updated_at: now,
            },
        ]);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('modules');
    },
};
