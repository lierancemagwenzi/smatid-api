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

/** One liveness check: a client asks for it, the person takes it on the hosted page. */
module.exports = (sequelize, DataTypes) => {
    class liveness_session extends Model {
        static associate(models) {
            liveness_session.belongsTo(models.client, {foreignKey: 'client_id'});
        }

        isExpired() {
            return ['pending', 'started'].includes(this.status) && new Date(this.expires_at) <= new Date();
        }

        /** pending, started, passed, failed or expired. */
        currentStatus() {
            return this.isExpired() ? 'expired' : this.status;
        }

        /** What the client gets back. */
        toPublic(baseUrl) {
            const status = this.currentStatus();
            const result = this.result || null;
            return {
                session_id: this.public_id,
                reference: this.reference,
                // A free test session from the portal, never a real person's check.
                test: Boolean(this.test),
                status,
                passed: status === 'passed',
                url: `${baseUrl}/liveness/${this.public_id}`,
                attempts: this.attempts,
                failure_reason: status === 'failed' ? this.failure_reason : null,
                scores: result ? result.scores : null,
                steps: result ? result.steps : null,
                expires_at: this.expires_at,
                completed_at: this.completed_at,
                created_at: this.createdAt,
                webhook: this.webhook_url ? {
                    url: this.webhook_url,
                    status: this.webhook_status || null,
                    attempts: this.webhook_attempts || 0,
                    delivered_at: this.webhook_delivered_at || null,
                    last_error: this.webhook_last_error || null,
                } : null,
            };
        }
    }

    liveness_session.init({
        public_id: {type: DataTypes.STRING(64), allowNull: false, unique: true},
        client_id: {type: DataTypes.INTEGER, allowNull: false},
        reference: DataTypes.STRING(255),
        redirect_url: DataTypes.STRING(2048),
        status: {type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending'},
        steps: jsonColumn(DataTypes, 'steps'),
        attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        started_at: DataTypes.DATE,
        completed_at: DataTypes.DATE,
        expires_at: {type: DataTypes.DATE, allowNull: false},
        result: jsonColumn(DataTypes, 'result'),
        failure_reason: DataTypes.STRING(64),
        webhook_url: DataTypes.STRING(2048),
        webhook_status: DataTypes.STRING(16),
        webhook_attempts: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
        webhook_next_at: DataTypes.DATE,
        webhook_last_error: DataTypes.STRING(255),
        webhook_delivered_at: DataTypes.DATE,
        test: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    }, {
        sequelize,
        modelName: 'liveness_session',
        timestamps: true,
        underscored: true,
    });

    return liveness_session;
};
