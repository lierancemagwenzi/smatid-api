'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('admins', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            name: {type: Sequelize.STRING, allowNull: false},
            email: {type: Sequelize.STRING, allowNull: false, unique: true},
            // scrypt$<salt>$<hash>, see helpers/passwordHelper.js.
            password_hash: {type: Sequelize.STRING, allowNull: false},
            last_login_at: Sequelize.DATE,

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });

        // A signed-in admin. Like client tokens, only the SHA-256 of the session token is kept.
        await queryInterface.createTable('admin_sessions', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            admin_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'admins', key: 'id'},
                onDelete: 'CASCADE',
            },
            token_hash: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            expires_at: {type: Sequelize.DATE, allowNull: false},

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
    },

    async down(queryInterface) {
        await queryInterface.dropTable('admin_sessions');
        await queryInterface.dropTable('admins');
    },
};
