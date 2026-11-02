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

/** One KYC call by a client: what it searched for and what it got back. */
module.exports = (sequelize, DataTypes) => {
    class api_request extends Model {
        static associate(models) {
            api_request.belongsTo(models.client, {foreignKey: 'client_id'});
            models.client.hasMany(api_request, {foreignKey: 'client_id'});
        }
    }

    api_request.init({
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        check_type: {type: DataTypes.STRING(32), allowNull: false},
        method: {type: DataTypes.STRING(8), allowNull: false},
        path: {type: DataTypes.STRING(512), allowNull: false},
        request: jsonColumn(DataTypes, 'request'),
        status: {type: DataTypes.INTEGER, allowNull: false},
        response: jsonColumn(DataTypes, 'response'),
        duration_ms: DataTypes.INTEGER,
        ip: DataTypes.STRING(64),
    }, {
        sequelize,
        modelName: 'api_request',
        timestamps: true,
        underscored: true,
    });

    return api_request;
};
