'use strict';
const {Model} = require('sequelize');

/** A user signed in to the portal. Only the session token's SHA-256 is stored. */
module.exports = (sequelize, DataTypes) => {
    class user_session extends Model {
        static associate(models) {
            user_session.belongsTo(models.user, {foreignKey: 'user_id'});
        }
    }

    user_session.init({
        user_id: {type: DataTypes.INTEGER, allowNull: false},
        token_hash: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        expires_at: {type: DataTypes.DATE, allowNull: false},
    }, {sequelize, modelName: 'user_session', timestamps: true, underscored: true});

    return user_session;
};
