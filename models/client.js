'use strict';
const {Model} = require('sequelize');

/** A company allowed to call the KYC API. Only the access token's SHA-256 is stored. */
module.exports = (sequelize, DataTypes) => {
    class client extends Model {
        static associate(models) {
            client.hasMany(models.user, {foreignKey: 'client_id'});
        }

        trialActive() {
            return Boolean(this.trial_until) && new Date(this.trial_until) > new Date();
        }

        /** What the client can spend now: paid credits, plus trial credits while the trial lasts. */
        balance() {
            const trial = this.trialActive() ? this.trial_credits || 0 : 0;
            return {
                credits: this.credits || 0,
                trial_credits: trial,
                trial_until: this.trial_until || null,
                trial_active: this.trialActive(),
                available_credits: (this.credits || 0) + trial,
            };
        }

        /** What the admin API shows; never the hash. */
        toPublic() {
            return {
                id: this.id,
                name: this.name,
                email: this.email,
                token_prefix: this.token_prefix,
                status: this.status,
                last_used_at: this.last_used_at,
                revoked_at: this.revoked_at,
                webhook_url: this.webhook_url || null,
                ...this.balance(),
                registered_via: this.registered_via,
                // underscored only renames the column; the attribute is still createdAt.
                created_at: this.createdAt,
            };
        }
    }

    client.init({
        name: {type: DataTypes.STRING, allowNull: false},
        email: DataTypes.STRING,
        // Null for a client that registered itself and hasn't made its API token yet.
        token_hash: {type: DataTypes.STRING(64), allowNull: true, unique: true},
        token_prefix: {type: DataTypes.STRING(16), allowNull: true},
        status: {type: DataTypes.STRING, allowNull: false, defaultValue: 'active'},
        last_used_at: DataTypes.DATE,
        revoked_at: DataTypes.DATE,
        // Not in toPublic(): only the client itself gets it, from GET /api/kyc/webhook-secret.
        webhook_secret: DataTypes.STRING(80),
        webhook_url: DataTypes.STRING(2048),
        // Paid credits never expire; trial credits only count until trial_until. See billingHelper.
        credits: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        trial_credits: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        trial_until: DataTypes.DATE,
        registered_via: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'admin'},
    }, {
        sequelize,
        modelName: 'client',
        timestamps: true,
        underscored: true,
    });

    return client;
};
