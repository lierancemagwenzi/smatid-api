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

/** One national ID card scanned in an app with the Smatid SDK. */
module.exports = (sequelize, DataTypes) => {
    class id_card_scan extends Model {
        static associate(models) {
            id_card_scan.belongsTo(models.client, {foreignKey: 'client_id'});
        }

        /** What the client gets back. The OCR and any admin label stay on the server. */
        toPublic() {
            return {
                scan_id: this.public_id,
                reference: this.reference,
                country: this.country,
                card_type: this.card_type || null,
                status: this.status,
                passed: this.status === 'passed',
                failure_reason: this.failure_reason || null,
                review_reasons: this.review_reasons || [],
                document: this.document || null,
                checks: this.checks || null,
                extracted_by: this.extracted_by || null,
                has_image: Boolean(this.image_file),
                // The card's photo against a liveness check's face, once compared: null until then.
                face_match: this.face_match || null,
                created_at: this.createdAt,
            };
        }

        /** For admins: everything, including what training needs. */
        toAdmin() {
            return {
                ...this.toPublic(),
                confidence: this.confidence || null,
                ocr: this.ocr || null,
                device: this.device || null,
                label: this.label || null,
                labelled_by: this.labelled_by || null,
                labelled_at: this.labelled_at || null,
            };
        }
    }

    id_card_scan.init({
        public_id: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        reference: DataTypes.STRING(255),
        country: {type: DataTypes.STRING(2), allowNull: false},
        card_type: DataTypes.STRING(16),
        status: {type: DataTypes.STRING(16), allowNull: false},
        failure_reason: DataTypes.STRING(64),
        document: jsonColumn(DataTypes, 'document'),
        checks: jsonColumn(DataTypes, 'checks'),
        review_reasons: jsonColumn(DataTypes, 'review_reasons'),
        extracted_by: DataTypes.STRING(32),
        confidence: jsonColumn(DataTypes, 'confidence'),
        ocr: jsonColumn(DataTypes, 'ocr'),
        image_file: DataTypes.STRING(255),
        device: jsonColumn(DataTypes, 'device'),
        label: jsonColumn(DataTypes, 'label'),
        labelled_by: DataTypes.INTEGER,
        labelled_at: DataTypes.DATE,
        face_match: jsonColumn(DataTypes, 'face_match'),
    }, {
        sequelize,
        modelName: 'id_card_scan',
        timestamps: true,
        underscored: true,
    });

    return id_card_scan;
};
