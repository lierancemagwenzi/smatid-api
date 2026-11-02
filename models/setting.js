'use strict';
const {Model} = require('sequelize');

/** One admin-editable setting. Read and written through helpers/settingsHelper.js, which handles secrets. */
module.exports = (sequelize, DataTypes) => {
    class setting extends Model {}

    setting.init({
        key: {type: DataTypes.STRING(64), primaryKey: true},
        value: DataTypes.TEXT,
        updated_by_admin_id: DataTypes.INTEGER,
    }, {sequelize, modelName: 'setting', timestamps: true, underscored: true});

    return setting;
};
