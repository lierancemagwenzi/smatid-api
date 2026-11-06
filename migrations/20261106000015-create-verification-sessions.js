'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('verification_sessions', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            // vs_<random>: the key the Smatid Verify app uses, in the link that opens it.
            public_id: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            // A short code the person can type into the app instead (8 characters, shown as XXXX-XXXX).
            code: {type: Sequelize.STRING(16), allowNull: false, unique: true},
            client_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'clients', key: 'id'},
                onDelete: 'CASCADE',
            },
            reference: Sequelize.STRING(255),
            // liveness, passport, passport_chip or full: what the app is to check.
            type: {type: Sequelize.STRING(24), allowNull: false},
            // Where the app sends the person when it's over (usually the client app's own link).
            return_url: Sequelize.STRING(2048),
            // pending → in_progress (opened in the app) → completed, or cancelled. expired is worked out.
            status: {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending'},
            // The checks the app ran for this session, by their own IDs.
            passport_scan_id: Sequelize.STRING(64),
            liveness_session_id: Sequelize.STRING(64),
            // Steps the app couldn't do, and why, e.g. {"chip": "no_nfc"}.
            skipped: Sequelize.JSON,
            // The outcome, worked out when the session is completed.
            result: Sequelize.JSON,
            opened_at: Sequelize.DATE,
            completed_at: Sequelize.DATE,
            expires_at: {type: Sequelize.DATE, allowNull: false},
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('verification_sessions', ['client_id', 'created_at']);
    },

    async down(queryInterface) {
        await queryInterface.dropTable('verification_sessions');
    },
};
