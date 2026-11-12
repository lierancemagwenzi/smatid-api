'use strict';

module.exports = {
    async up(queryInterface, Sequelize) {
        await queryInterface.createTable('document_checks', {
            id: {allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER},
            // Given to the client to look the check up again: dc_<random>.
            public_id: {type: Sequelize.STRING(64), allowNull: false, unique: true},
            client_id: {
                type: Sequelize.INTEGER,
                allowNull: false,
                references: {model: 'clients', key: 'id'},
                onDelete: 'CASCADE',
            },
            reference: Sequelize.STRING(255),
            // The file isn't kept: only its name, size and fingerprint, and what was found in it.
            filename: Sequelize.STRING(255),
            size: Sequelize.INTEGER,
            sha256: {type: Sequelize.STRING(64), allowNull: false},
            pages: Sequelize.INTEGER,
            // bank_statement, payslip, utility_bill or other.
            doc_type: Sequelize.STRING(32),
            // clean, review or suspicious, and the 0-100 score behind it.
            verdict: {type: Sequelize.STRING(16), allowNull: false},
            score: {type: Sequelize.INTEGER, allowNull: false},
            // The whole report as returned, and the measurements a model is trained on.
            report: Sequelize.JSON,
            features: Sequelize.JSON,
            // What an admin says the document really is, for training: {verdict: genuine|doctored, note}.
            label: Sequelize.JSON,
            labelled_by: Sequelize.INTEGER,
            labelled_at: Sequelize.DATE,
            created_at: {allowNull: false, type: Sequelize.DATE},
            updated_at: {allowNull: false, type: Sequelize.DATE},
        });
        await queryInterface.addIndex('document_checks', ['client_id', 'created_at']);
        await queryInterface.addIndex('document_checks', ['sha256']);

        const [existing] = await queryInterface.sequelize.query("SELECT id FROM modules WHERE `key` = 'document-check'");
        if (!existing.length) {
            const now = new Date();
            await queryInterface.bulkInsert('modules', [{
                key: 'document-check', name: 'Document proofreader', status: 'enabled', credit_cost: 3,
                description: 'Checks a PDF (bank statement, payslip, utility bill or any document) for signs of editing: its history and metadata, fonts, layout, and whether its figures add up.',
                created_at: now, updated_at: now,
            }]);
        }
    },

    async down(queryInterface) {
        await queryInterface.dropTable('document_checks');
        await queryInterface.sequelize.query("DELETE FROM modules WHERE `key` = 'document-check'");
    },
};
