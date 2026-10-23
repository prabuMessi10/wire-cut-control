import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import jobRoutes from './routes/jobs.js';
import settingsRoutes from './routes/settings.js';
import esp32Routes from './routes/esp32.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');

// CORS is mainly needed when the client talks to the API directly (e.g. a
// custom VITE_API_URL). In the default setup the Vite dev server proxies /api,
// so cookies stay same-origin and CORS is not even exercised.
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      // Hard-block disallowed origins with a clean 403 (the error is passed to
      // the errorHandler, which maps err.status/expose to a JSON body) instead
      // of letting the request reach a controller and fail with a 500.
      const err = new Error('Origin not allowed by CORS: ' + origin);
      err.status = 403;
      err.code = 'CORS_DENIED';
      err.expose = true;
      return cb(err);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/esp32', esp32Routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;