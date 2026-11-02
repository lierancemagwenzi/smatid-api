require('dotenv').config({quiet: true});
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const db = require('./models');

const app = express();
const port = process.env.PORT || 8011;

app.use(morgan('dev'));
app.use(express.json({limit: '1mb'}));

const kycRoutes = require('./routes/kycRoutes');
kycRoutes(app);

db.sequelize.authenticate()
    .then(() => console.log('Database connected successfully'))
    .catch((err) => console.error('Database connection failed:', err.message));

http.createServer(app).listen(port, () => console.log(`smatpay_kyc listening on ${port}`));
