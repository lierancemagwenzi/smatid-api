'use strict';
const {Model} = require('sequelize');

/** One change to a client's credits: a trial grant, a top-up, a check, a refund or an admin adjustment. */
module.exports = (sequelize, DataTypes) => {
    class credit_transaction extends Model {
        toPublic() {
            return {
                id: this.id,
                kind: this.kind,
                credits: this.credits,
                trial_credits: this.trial_credits,
                credits_after: this.credits_after,
                trial_credits_after: this.trial_credits_after,
                description: this.description,
                check_type: this.check_type,
                topup_id: this.topup_id,
                created_at: this.createdAt,
            };
        }
    }

    credit_transaction.init({
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        kind: {type: DataTypes.STRING(16), allowNull: false},
        credits: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        trial_credits: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        credits_after: {type: DataTypes.INTEGER, allowNull: false},
        trial_credits_after: {type: DataTypes.INTEGER, allowNull: false},
        description: DataTypes.STRING(255),
        check_type: DataTypes.STRING(32),
        topup_id: DataTypes.INTEGER,
        admin_id: DataTypes.INTEGER,
        user_id: DataTypes.INTEGER,
    }, {sequelize, modelName: 'credit_transaction', timestamps: true, underscored: true});

    return credit_transaction;
};
