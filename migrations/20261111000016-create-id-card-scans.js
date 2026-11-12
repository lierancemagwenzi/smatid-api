'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('id_card_scans', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            // Given to the client to look the scan up again: ic_<random>.
            public_id: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            client_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'clients', key: 'id'},
                onDelete: 'CASCADE',
            },
            reference: Sequelize.STRING(255),
            // ZW, …: whose card it is, which picks the rules and the trained model.
            country: {type: Sequelize.STRING(2), allowNull: false},
            // metal or plastic (for ZW), as read.
            card_type: Sequelize.STRING(16),
            // passed, review (read, but something needs a person) or failed.
            status: {type: Sequelize.STRING(16), allowNull: false},
            failure_reason: Sequelize.STRING(64),
            // The card's details, the checks on them, and what to look at for a review.
            document: Sequelize.JSON,
            checks: Sequelize.JSON,
            review_reasons: Sequelize.JSON,
            // What read it ("rules:ZW", "model:ZW@3") and how sure the model was of each field.
            extracted_by: Sequelize.STRING(32),
            confidence: Sequelize.JSON,
            // The app's OCR lines with their boxes: what models are trained on. Never sent to clients.
            ocr: Sequelize.JSON,
            image_file: Sequelize.STRING(255),
            device: Sequelize.JSON,
            // What an admin says the card really reads, for training: {card_type, fields: {…}}.
            label: Sequelize.JSON,
            labelled_by: Sequelize.INTEGER,
            labelled_at: Sequelize.DATE,
            // The card's photo against a liveness check's face, once compared.
            face_match: Sequelize.JSON,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('id_card_scans', ['client_id', 'created_at']);
        await queryInterface.addIndex('id_card_scans', ['country', 'labelled_at']);

        await queryInterface.addColumn('verification_sessions', 'id_card_scan_id', {type: Sequelize.STRING(64), after: 'passport_scan_id'});

        const [existing] = await queryInterface.sequelize.query("SELECT id FROM modules WHERE `key` = 'id-card-check'");
        if (!existing.length) {
            const now = new Date();
            await queryInterface.bulkInsert('modules', [{
                key: 'id-card-check', name: 'ID card scan', status: 'enabled', credit_cost: 2,
                description: 'Reads a national ID card (Zimbabwe for now) from a phone camera (the Smatid Flutter SDK) and checks its ID number.',
                created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        await queryInterface.removeColumn('verification_sessions', 'id_card_scan_id');
        await queryInterface.dropTable('id_card_scans');
        await queryInterface.sequelize.query("DELETE FROM modules WHERE `key` = 'id-card-check'");
    },
};
