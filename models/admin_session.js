'use strict';
const {Model} = require('sequelize');

/** A signed-in admin. Only the session token's SHA-256 is stored. */
module.exports = (sequelize, DataTypes) => {
    class admin_session extends Model {
        static associate(models) {
            admin_session.belongsTo(models.admin, {foreignKey: 'admin_id'});
        }
    }

    admin_session.init({
        admin_id: {type: DataTypes.INTEGER, allowNull: false},
        token_hash: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        expires_at: {type: DataTypes.DATE, allowNull: false},
    }, {
        sequelize,
        modelName: 'admin_session',
        timestamps: true,
        underscored: true,
    });

    return admin_session;
};
