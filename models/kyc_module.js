'use strict';
const {Model} = require('sequelize');

/**
 * A KYC check the admin can switch on or off, e.g. "sanctions-check". Client endpoints check theirs
 * with moduleHelper.requireModule. (Not called "module": that name is taken in CommonJS files.)
 */
module.exports = (sequelize, DataTypes) => {
    class kyc_module extends Model {
        toPublic() {
            return {
                id: this.id,
                key: this.key,
                name: this.name,
                description: this.description,
                status: this.status,
                credit_cost: this.credit_cost,
                created_at: this.createdAt,
                updated_at: this.updatedAt,
            };
        }
    }

    kyc_module.init({
        key: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        name: {type: DataTypes.STRING, allowNull: false},
        description: DataTypes.TEXT,
        status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'enabled'},
        credit_cost: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 1},
    }, {
        sequelize,
        modelName: 'kyc_module',
        tableName: 'modules',
        timestamps: true,
        underscored: true,
    });

    return kyc_module;
};
