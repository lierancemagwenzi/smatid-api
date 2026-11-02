'use strict';
const {Model} = require('sequelize');

/** Someone who signs in to the client portal. Several users can belong to one client. */
module.exports = (sequelize, DataTypes) => {
    class user extends Model {
        static associate(models) {
            user.belongsTo(models.client, {foreignKey: 'client_id'});
            user.hasMany(models.user_session, {foreignKey: 'user_id'});
        }

        isOwner() {
            return this.role === 'owner';
        }

        /** Never the password hash. */
        toPublic() {
            return {
                id: this.id,
                name: this.name,
                email: this.email,
                role: this.role,
                status: this.status,
                email_verified: Boolean(this.email_verified_at),
                // Invited, but hasn't set a password yet.
                invited: !this.password_hash,
                last_login_at: this.last_login_at,
                created_at: this.createdAt,
            };
        }
    }

    user.init({
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        name: {type: DataTypes.STRING, allowNull: false},
        email: {type: DataTypes.STRING, allowNull: false, unique: true},
        password_hash: DataTypes.STRING,
        role: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'member'},
        status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active'},
        email_verified_at: DataTypes.DATE,
        last_login_at: DataTypes.DATE,
    }, {sequelize, modelName: 'user', timestamps: true, underscored: true});

    return user;
};
