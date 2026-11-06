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

/**
 * A verification a client asks for, done by the person in the Smatid Verify app. The client opens it
 * (with its token) and reads the result; the app holds only the session's ID.
 */
module.exports = (sequelize, DataTypes) => {
    class verification_session extends Model {
        static associate(models) {
            verification_session.belongsTo(models.client, {foreignKey: 'client_id'});
        }

        isOpen() {
            return ['pending', 'in_progress'].includes(this.status) && new Date(this.expires_at) > new Date();
        }

        /** pending, in_progress, completed, cancelled or expired. */
        currentStatus() {
            if (['pending', 'in_progress'].includes(this.status) && new Date(this.expires_at) <= new Date()) return 'expired';
            return this.status;
        }
    }

    verification_session.init({
        public_id: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        code: {type: DataTypes.STRING(16), allowNull: false, unique: true},
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        reference: DataTypes.STRING(255),
        type: {type: DataTypes.STRING(24), allowNull: false},
        return_url: DataTypes.STRING(2048),
        status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending'},
        passport_scan_id: DataTypes.STRING(64),
        liveness_session_id: DataTypes.STRING(64),
        skipped: jsonColumn(DataTypes, 'skipped'),
        result: jsonColumn(DataTypes, 'result'),
        opened_at: DataTypes.DATE,
        completed_at: DataTypes.DATE,
        expires_at: {type: DataTypes.DATE, allowNull: false},
    }, {
        sequelize,
        modelName: 'verification_session',
        timestamps: true,
        underscored: true,
    });

    return verification_session;
};
