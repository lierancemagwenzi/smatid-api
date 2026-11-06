'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        // The latest chip read for the scan: what was checked and how it came out.
        await queryInterface.addColumn('passport_scans', 'chip', {type: Sequelize.JSON, allowNull: true});
        // The face picture from the chip (DG2), under storage/passport/<scan>/.
        await queryInterface.addColumn('passport_scans', 'chip_photo_file', {type: Sequelize.STRING(255), allowNull: true});
        await queryInterface.addColumn('passport_scans', 'chip_read_at', {type: Sequelize.DATE, allowNull: true});

        const [existing] = await queryInterface.sequelize.query("SELECT id FROM modules WHERE `key` = 'passport-chip'");
        if (!existing.length) {
            const now = new Date();
            await queryInterface.bulkInsert('modules', [{
                key: 'passport-chip', name: 'Passport chip', status: 'enabled', credit_cost: 2,
                description: 'Reads a passport chip over NFC (the Smatid Flutter SDK) and checks it was signed by the issuing country.',
                created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        for (const column of ['chip', 'chip_photo_file', 'chip_read_at']) {
            await queryInterface.removeColumn('passport_scans', column);
        }
        await queryInterface.sequelize.query("DELETE FROM modules WHERE `key` = 'passport-chip'");
    },
};
