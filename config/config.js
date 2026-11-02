require('dotenv').config({quiet: true});

const base = {
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD || null,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    dialect: 'mysql',
    timezone: '+00:00',
    logging: false,
};

module.exports = {
    development: base,
    test: base,
    production: base,
};
