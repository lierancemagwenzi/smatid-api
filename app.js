require('dotenv').config({quiet: true});
const http = require('http');
const express = require('express');
const morgan = require('morgan');
const db = require('./models');

const app = express();
const port = process.env.PORT || 8011;

// Behind Caddy/nginx on the same box: take the client's IP from X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(morgan('dev'));
app.use(require('./helpers/corsHelper').allowOrigins());
app.use(express.json({limit: '1mb'}));

const kycRoutes = require('./routes/kycRoutes');
kycRoutes(app);

db.sequelize.authenticate()
    .then(() => console.log('Database connected successfully'))
    .catch((err) => console.error('Database connection failed:', err.message));

http.createServer(app).listen(port, () => console.log(`Smatid KYC listening on ${port}`));
