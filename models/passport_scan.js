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

/** One passport photo page scanned in an app with the Smatid SDK. */
module.exports = (sequelize, DataTypes) => {
    class passport_scan extends Model {
        static associate(models) {
            passport_scan.belongsTo(models.client, {foreignKey: 'client_id'});
        }

        /** What the client gets back. */
        toPublic() {
            return {
                scan_id: this.public_id,
                reference: this.reference,
                status: this.status,
                passed: this.status === 'passed',
                failure_reason: this.failure_reason || null,
                document: this.document || null,
                checks: this.checks || null,
                mrz: this.mrz || null,
                has_image: Boolean(this.image_file),
                // The passport chip, once the app has read it: null until then.
                chip: this.chip ? {...this.chip, has_photo: Boolean(this.chip_photo_file)} : null,
                // The passport photo against a liveness check's face, once compared: null until then.
                face_match: this.face_match || null,
                created_at: this.createdAt,
            };
        }
    }

    passport_scan.init({
        public_id: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        reference: DataTypes.STRING(255),
        status: {type: DataTypes.STRING(16), allowNull: false},
        failure_reason: DataTypes.STRING(64),
        mrz: jsonColumn(DataTypes, 'mrz'),
        document: jsonColumn(DataTypes, 'document'),
        checks: jsonColumn(DataTypes, 'checks'),
        image_file: DataTypes.STRING(255),
        device: jsonColumn(DataTypes, 'device'),
        chip: jsonColumn(DataTypes, 'chip'),
        chip_photo_file: DataTypes.STRING(255),
        chip_read_at: DataTypes.DATE,
        face_match: jsonColumn(DataTypes, 'face_match'),
    }, {
        sequelize,
        modelName: 'passport_scan',
        timestamps: true,
        underscored: true,
    });

    return passport_scan;
};
