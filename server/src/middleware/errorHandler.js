export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} does not exist`,
    },
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  console.error('[error]', err?.message || err);

  if (err?.name === 'ValidationError') {
    const messages = Object.values(err.errors || {}).map((e) => e.message);
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: messages.join(', ') },
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({
      success: false,
      error: { code: 'DUPLICATE', message: 'A record with that value already exists.' },
    });
  }

  if (err?.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_ID', message: 'Invalid identifier in request.' },
    });
  }

  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' },
    });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
    });
  }

  // Explicit client-error statuses (e.g. the CORS 403 from app.js) get a
  // clean JSON body instead of falling through to a generic 500.
  const status = Number(err.status) || Number(err.statusCode) || 0;
  if (status >= 400 && status < 500 && err.expose) {
    return res.status(status).json({
      success: false,
      error: { code: err.code || 'BAD_REQUEST', message: err.message },
    });
  }

  res.status(500).json({
    success: false,
    error: { code: 'SERVER_ERROR', message: 'Something went wrong on the server.' },
  });
}