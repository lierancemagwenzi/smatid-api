'use strict';
const {Model} = require('sequelize');

/** A one-time link sent by email: verify_email, reset_password or invite. Only its SHA-256 is stored. */
module.exports = (sequelize, DataTypes) => {
    class user_token extends Model {
        static associate(models) {
            user_token.belongsTo(models.user, {foreignKey: 'user_id'});
        }
    }

    user_token.init({
        user_id: {type: DataTypes.INTEGER, allowNull: false},
        purpose: {type: DataTypes.STRING(24), allowNull: false},
        token_hash: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        expires_at: {type: DataTypes.DATE, allowNull: false},
        used_at: DataTypes.DATE,
    }, {sequelize, modelName: 'user_token', timestamps: true, underscored: true});

    return user_token;
};
