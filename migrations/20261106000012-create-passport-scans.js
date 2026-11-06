'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('passport_scans', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            // Given to the client to look the scan up again: ps_<random>.
            public_id: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            client_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'clients', key: 'id'},
                onDelete: 'CASCADE',
            },
            // The client's own ID for the person, passed back in results.
            reference: Sequelize.STRING(255),
            // passed (read and valid) or failed (read, but e.g. expired).
            status: {type: Sequelize.STRING(16), allowNull: false},
            failure_reason: Sequelize.STRING(64),
            // The MRZ lines as the server read them, after fixing OCR mix-ups.
            mrz: Sequelize.JSON,
            // The details from the MRZ, and which check digits matched.
            document: Sequelize.JSON,
            checks: Sequelize.JSON,
            // Where the photo page picture is kept, under storage/passport/.
            image_file: Sequelize.STRING(255),
            // What the app said about the scan (SDK version, platform, how long it took).
            device: Sequelize.JSON,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('passport_scans', ['client_id', 'created_at']);

        const [existing] = await queryInterface.sequelize.query("SELECT id FROM modules WHERE `key` = 'passport-check'");
        if (!existing.length) {
            const now = new Date();
            await queryInterface.bulkInsert('modules', [{
                key: 'passport-check', name: 'Passport scan', status: 'enabled', credit_cost: 2,
                description: 'Reads a passport photo page from a phone camera (the Smatid Flutter SDK) and checks its MRZ.',
                created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('passport_scans');
        await queryInterface.sequelize.query("DELETE FROM modules WHERE `key` = 'passport-check'");
    },
};
