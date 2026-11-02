'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // People who sign in to the client portal. Several can belong to one client.
        await queryInterface.createTable('users', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            client_id: {type: Sequelize.INTEGER, allowNull: false, references: {model: 'clients', key: 'id'}, onDelete: 'CASCADE'},
            name: {type: Sequelize.STRING, allowNull: false},
            email: {type: Sequelize.STRING, allowNull: false, unique: true},
            // Null until an invited user sets one.
            password_hash: Sequelize.STRING,
            // owner (manages the team and API token) or member.
            role: {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'member'},
            status: {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'active'},
            email_verified_at: Sequelize.DATE,
            last_login_at: Sequelize.DATE,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });

        await queryInterface.createTable('user_sessions', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            user_id: {type: Sequelize.INTEGER, allowNull: false, references: {model: 'users', key: 'id'}, onDelete: 'CASCADE'},
            token_hash: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            expires_at: {type: Sequelize.DATE, allowNull: false},
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });

        // One-time links in emails: verify_email, reset_password, invite.
        await queryInterface.createTable('user_tokens', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            user_id: {type: Sequelize.INTEGER, allowNull: false, references: {model: 'users', key: 'id'}, onDelete: 'CASCADE'},
            purpose: {type: Sequelize.STRING(24), allowNull: false},
            token_hash: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            expires_at: {type: Sequelize.DATE, allowNull: false},
            used_at: Sequelize.DATE,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });

        // A client that registered itself has no API token until its owner creates one.
        // No unique: here: the column already has its unique index, and repeating it would add a second one.
        await queryInterface.changeColumn('clients', 'token_hash', {type: Sequelize.STRING(64), allowNull: true});
        await queryInterface.changeColumn('clients', 'token_prefix', {type: Sequelize.STRING(16), allowNull: true});
    },

    async down(queryInterface) {
        await queryInterface.dropTable('user_tokens');
        await queryInterface.dropTable('user_sessions');
        await queryInterface.dropTable('users');
    },
};
