'use strict';
const {Model} = require('sequelize');

/** Someone who can sign in to /admin. Created with `npm run admin:create`. */
module.exports = (sequelize, DataTypes) => {
    class admin extends Model {
        static associate(models) {
            admin.hasMany(models.admin_session, {foreignKey: 'admin_id'});
        }

        /** What the admin API shows; never the password hash. */
        toPublic() {
            return {id: this.id, name: this.name, email: this.email, last_login_at: this.last_login_at};
        }
    }

    admin.init({
        name: {type: DataTypes.STRING, allowNull: false},
        email: {type: DataTypes.STRING, allowNull: false, unique: true},
        password_hash: {type: DataTypes.STRING, allowNull: false},
        last_login_at: DataTypes.DATE,
    }, {
        sequelize,
        modelName: 'admin',
        timestamps: true,
        underscored: true,
    });

    return admin;
};
