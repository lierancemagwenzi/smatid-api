'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('api_requests', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.BIGINT},
            client_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'clients', key: 'id'},
                onDelete: 'CASCADE',
            },
            // Which KYC check: "company", "sanctions", ...
            check_type: {type: Sequelize.STRING(32), allowNull: false},
            method: {type: Sequelize.STRING(8), allowNull: false},
            path: {type: Sequelize.STRING(512), allowNull: false},
            // What the client searched for: route params, query string and body.
            request: Sequelize.JSON,
            status: {type: Sequelize.INTEGER, allowNull: false},
            response: Sequelize.JSON,
            duration_ms: Sequelize.INTEGER,
            ip: Sequelize.STRING(64),

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('api_requests', ['client_id', 'created_at']);
        await queryInterface.addIndex('api_requests', ['created_at']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('api_requests');
    },
};
