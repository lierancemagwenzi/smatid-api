'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // The latest comparison of the passport's photo with a liveness check's face.
        await queryInterface.addColumn('passport_scans', 'face_match', {type: Sequelize.JSON, allowNull: true});

        const [existing] = await queryInterface.sequelize.query("SELECT id FROM modules WHERE `key` = 'face-match'");
        if (!existing.length) {
            const now = new Date();
            await queryInterface.bulkInsert('modules', [{
                key: 'face-match', name: 'Face match', status: 'enabled', credit_cost: 1,
                description: 'Compares the passport photo (from the chip, or the photo page) with the face from a passed liveness check.',
                created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('passport_scans', 'face_match');
        await queryInterface.sequelize.query("DELETE FROM modules WHERE `key` = 'face-match'");
    },
};
