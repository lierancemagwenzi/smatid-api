'use strict';
const {Model} = require('sequelize');

/** MariaDB keeps JSON columns as text and hands them back as strings; MySQL gives objects. */
function jsonColumn(DataTypes, name) {
    return {
        type: DataTypes.JSON,
        get() {
            const value = this.getDataValue(name);
            return typeof value === 'string' ? JSON.parse(value) : value;
        },
    };
}

/** One document checked by the proofreader. The file itself isn't kept. */
module.exports = (sequelize, DataTypes) => {
    class document_check extends Model {
        static associate(models) {
            document_check.belongsTo(models.client, {foreignKey: 'client_id'});
        }

        /** What the client gets back: the report, with the check's id. */
        toPublic() {
            return {
                check_id: this.public_id,
                reference: this.reference || null,
                filename: this.filename || null,
                size: this.size,
                sha256: this.sha256,
                ...(this.report || {}),
                created_at: this.createdAt,
            };
        }

        toAdmin() {
            return {
                ...this.toPublic(),
                features: this.features || null,
                label: this.label || null,
                labelled_by: this.labelled_by || null,
                labelled_at: this.labelled_at || null,
            };
        }
    }

    document_check.init({
        public_id: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        reference: DataTypes.STRING(255),
        filename: DataTypes.STRING(255),
        size: DataTypes.INTEGER,
        sha256: {type: DataTypes.STRING(64), allowNull: false},
        pages: DataTypes.INTEGER,
        doc_type: DataTypes.STRING(32),
        verdict: {type: DataTypes.STRING(16), allowNull: false},
        score: {type: DataTypes.INTEGER, allowNull: false},
        report: jsonColumn(DataTypes, 'report'),
        features: jsonColumn(DataTypes, 'features'),
        label: jsonColumn(DataTypes, 'label'),
        labelled_by: DataTypes.INTEGER,
        labelled_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'document_check',
        timestamps: true,
        underscored: true,
    });

    return document_check;
};
