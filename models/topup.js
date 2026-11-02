'use strict';
const {Model} = require('sequelize');

/** Buying credits through Smatpay. */
module.exports = (sequelize, DataTypes) => {
    class topup extends Model {
        static associate(models) {
            topup.belongsTo(models.client, {foreignKey: 'client_id'});
        }

        toPublic() {
            return {
                id: this.id,
                reference: this.reference,
                credits: this.credits,
                amount: Number(this.amount),
                currency: this.currency,
                method: this.method,
                payer_mobile: this.payer_mobile,
                status: this.status,
                payment_code: this.payment_code,
                payment_url: this.payment_url,
                failure_reason: this.failure_reason,
                paid_at: this.paid_at,
                created_at: this.createdAt,
            };
        }
    }

    topup.init({
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        user_id: DataTypes.INTEGER,
        reference: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        credits: {type: DataTypes.INTEGER, allowNull: false},
        amount: {type: DataTypes.DECIMAL(12, 2), allowNull: false},
        currency: {type: DataTypes.STRING(8), allowNull: false},
        method: {type: DataTypes.STRING(16), allowNull: false},
        payer_mobile: DataTypes.STRING(20),
        status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending'},
        payment_reference: DataTypes.STRING(128),
        payment_code: DataTypes.STRING(64),
        payment_url: DataTypes.STRING(2048),
        provider_status: DataTypes.STRING(64),
        failure_reason: DataTypes.STRING(255),
        paid_at: DataTypes.DATE,
        checked_at: DataTypes.DATE,
    }, {sequelize, modelName: 'topup', timestamps: true, underscored: true});

    return topup;
};
