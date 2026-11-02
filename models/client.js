'use strict';
const {Model} = require('sequelize');

/** A company allowed to call the KYC API. Only the access token's SHA-256 is stored. */
module.exports = (sequelize, DataTypes) => {
    class client extends Model {
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
                // underscored only renames the column; the attribute is still createdAt.
                created_at: this.createdAt,
            };
        }
    }

    client.init({
        name: {type: DataTypes.STRING, allowNull: false},
        email: DataTypes.STRING,
        token_hash: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        token_prefix: {type: DataTypes.STRING(16), allowNull: false},
        status: {type: DataTypes.STRING, allowNull: false, defaultValue: 'active'},
        last_used_at: DataTypes.DATE,
        revoked_at: DataTypes.DATE,
        // Not in toPublic(): only the client itself gets it, from GET /api/kyc/webhook-secret.
        webhook_secret: DataTypes.STRING(80),
        webhook_url: DataTypes.STRING(2048),
    }, {
        sequelize,
        modelName: 'client',
        timestamps: true,
        underscored: true,
    });

    return client;
};
