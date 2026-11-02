'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('liveness_sessions', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            // In the hosted page's link. Random and unguessable: holding it is what lets someone take the check.
            public_id: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            client_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'clients', key: 'id'},
                onDelete: 'CASCADE',
            },
            // The client's own ID for the person, passed back in results.
            reference: Sequelize.STRING(255),
            redirect_url: Sequelize.STRING(2048),
            // pending → started → passed or failed. expired is worked out from expires_at.
            status: {type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending'},
            // The steps of the current attempt, in order, e.g. ["center", "turn_right", "open_mouth", "turn_left"].
            steps: Sequelize.JSON,
            attempts: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
            started_at: Sequelize.DATE,
            completed_at: Sequelize.DATE,
            expires_at: {type: Sequelize.DATE, allowNull: false},
            // The server's verdict on the last attempt: scores and a result per step.
            result: Sequelize.JSON,
            failure_reason: Sequelize.STRING(64),

            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('liveness_sessions', ['client_id', 'created_at']);

        const [existing] = await queryInterface.sequelize.query("SELECT id FROM modules WHERE `key` = 'liveness-check'");
        if (!existing.length) {
            const now = new Date();
            await queryInterface.bulkInsert('modules', [{
                key: 'liveness-check', name: 'Liveness', status: 'enabled',
                description: 'A hosted page where a person proves they are really in front of the camera.',
                created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('liveness_sessions');
    },
};
