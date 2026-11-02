require('dotenv').config({quiet: true});
const http = require('http');
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const db = require('./models');

const app = express();
const port = process.env.PORT || 8011;

// Behind Caddy/nginx on the same box: take the client's IP from X-Forwarded-For.
app.set('trust proxy', 'loopback');
app.use(morgan('dev'));
app.use(require('./helpers/corsHelper').allowOrigins());
// The liveness page uploads its camera frames as JSON, so it gets a larger limit than everything else.
app.use('/api/liveness', express.json({limit: '4mb'}));
app.use(express.json({limit: '1mb'}));

// The hosted liveness page: its own files, the face library and models it runs in the browser.
const humanDir = path.dirname(path.dirname(require.resolve('@vladmandic/human')));
app.use('/liveness/assets', express.static(path.join(__dirname, 'public', 'liveness', 'assets')));
app.use('/liveness/vendor', express.static(path.join(humanDir, 'dist'), {maxAge: '7d'}));
app.use('/liveness/models', express.static(path.join(humanDir, 'models'), {maxAge: '7d'}));
app.use('/liveness/wasm', express.static(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm')), {maxAge: '7d'}));

const kycRoutes = require('./routes/kycRoutes');
kycRoutes(app);

db.sequelize.authenticate()
    .then(() => console.log('Database connected successfully'))
    .catch((err) => console.error('Database connection failed:', err.message));

// Marks expired liveness sessions and sends liveness webhooks, every 30 seconds.
require('./helpers/liveness/deliveryHelper').start();
// Follows Smatpay payments for credit top-ups, every 20 seconds.
require('./helpers/billing/topupHelper').start();

http.createServer(app).listen(port, () => console.log(`Smatid KYC listening on ${port}`));
