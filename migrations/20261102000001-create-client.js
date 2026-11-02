'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('clients', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            name: {type: Sequelize.STRING, allowNull: false},
            email: Sequelize.STRING,
            // SHA-256 of the access token; the token itself is only shown once, when it's made.
            token_hash: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            // The token's first characters, so a token can be matched to its client without the secret.
            token_prefix: {type: Sequelize.STRING(16), allowNull: false},
            status: {type: Sequelize.STRING, allowNull: false, defaultValue: 'active'},
            last_used_at: Sequelize.DATE,
            revoked_at: Sequelize.DATE,

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('clients');
    },
};
