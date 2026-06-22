const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const pinoHttp   = require('pino-http');
const pino       = require('pino');
const promClient = require('prom-client');
const { Pool }   = require('pg');
const { v4: uuidv4 } = require('uuid');

const VERSION  = process.env.APP_VERSION   || '2.0.0';
const PORT     = parseInt(process.env.PORT || '3001');
const LOG_LEVEL = process.env.LOG_LEVEL    || 'info';
const startTime = Date.now();

// ── Structured logger ─────────────────────────────────────────────────────────
const logger = pino({
  level: LOG_LEVEL,
  base: { service: 'backend-api', version: VERSION },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// ── Prometheus metrics ────────────────────────────────────────────────────────
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register, prefix: 'sre_' });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const dbQueryDuration = new promClient.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

const dbPoolSize = new promClient.Gauge({
  name: 'db_pool_size',
  help: 'Database connection pool size',
  registers: [register],
});

const dbPoolWaiting = new promClient.Gauge({
  name: 'db_pool_waiting_count',
  help: 'Number of clients waiting for a pool connection',
  registers: [register],
});

const dbConnectionErrors = new promClient.Counter({
  name: 'db_connection_errors_total',
  help: 'Total database connection errors',
  registers: [register],
});

// ── Database pool ─────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'sredb',
  user:     process.env.DB_USER     || 'sreuser',
  password: process.env.DB_PASSWORD || '',
  ssl:      { rejectUnauthorized: false },
  max:               10,
  min:               2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle:   false,
});

pool.on('error', (err) => {
  dbConnectionErrors.inc();
  logger.error({ err: err.message }, 'Unexpected pool error');
});

setInterval(() => {
  dbPoolSize.set(pool.totalCount);
  dbPoolWaiting.set(pool.waitingCount);
}, 5000);

async function dbQuery(operation, queryText, values) {
  const end = dbQueryDuration.startTimer({ operation });
  try {
    const result = await pool.query(queryText, values);
    end();
    return result;
  } catch (err) {
    end();
    throw err;
  }
}

async function initDB(retries = 10, delayMs = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS services (
          id           SERIAL PRIMARY KEY,
          name         VARCHAR(100) NOT NULL,
          type         VARCHAR(50)  NOT NULL,
          environment  VARCHAR(20)  NOT NULL DEFAULT 'production',
          status       VARCHAR(20)  NOT NULL DEFAULT 'healthy',
          owner_team   VARCHAR(100),
          endpoint_url VARCHAR(500),
          created_at   TIMESTAMPTZ  DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS incidents (
          id          SERIAL PRIMARY KEY,
          service_id  INT REFERENCES services(id) ON DELETE SET NULL,
          title       VARCHAR(200) NOT NULL,
          severity    VARCHAR(10)  NOT NULL,
          status      VARCHAR(20)  NOT NULL DEFAULT 'open',
          description TEXT,
          created_at  TIMESTAMPTZ  DEFAULT NOW(),
          resolved_at TIMESTAMPTZ
        )
      `);
      const { rows } = await pool.query('SELECT COUNT(*) FROM services');
      if (parseInt(rows[0].count) === 0) {
        await pool.query(`
          INSERT INTO services (name, type, environment, status, owner_team, endpoint_url) VALUES
          ('API Gateway',        'API',      'production', 'healthy',  'Platform',  'https://api.internal/gateway'),
          ('Auth Service',       'API',      'production', 'healthy',  'Security',  'https://api.internal/auth'),
          ('User Database',      'Database', 'production', 'healthy',  'Data',      NULL),
          ('Cache Layer',        'Cache',    'production', 'degraded', 'Platform',  NULL),
          ('Payment Service',    'API',      'production', 'healthy',  'Payments',  'https://api.internal/pay'),
          ('Notification Queue', 'Queue',    'production', 'healthy',  'Platform',  NULL),
          ('Search Service',     'API',      'production', 'healthy',  'Discovery', 'https://api.internal/search'),
          ('CDN Edge',           'Frontend', 'production', 'healthy',  'Platform',  NULL)
        `);
        await pool.query(`
          INSERT INTO incidents (service_id, title, severity, status, description) VALUES
          (4, 'Cache hit rate dropped below 60%',  'P2', 'investigating', 'Redis cache showing elevated miss rate since 14:30 UTC. Possible memory pressure.'),
          (1, 'API Gateway p99 latency spike',     'P3', 'open',          'p99 latency increased from 120ms to 380ms on /api/v2 routes.'),
          (2, 'Auth token validation errors',      'P2', 'resolved',      'JWT validation failures due to clock skew on auth-service-2. Fixed by NTP sync.'),
          (5, 'Payment processing timeout',        'P1', 'investigating', 'Intermittent 30s timeouts on /pay/checkout. Downstream bank API degraded.'),
          (7, 'Search index replication lag',      'P3', 'open',          'Search index 45 min behind primary. Cause: disk I/O saturation on replica.')
        `);
        await pool.query(`UPDATE incidents SET resolved_at = NOW() WHERE status = 'resolved'`);
      }
      logger.info('Database initialised');
      return;
    } catch (err) {
      logger.warn({ attempt: i, retries, err: err.message }, 'DB init attempt failed');
      if (i < retries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  logger.error('Could not initialise database after all retries');
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({
  contentSecurityPolicy: false, // CSP handled at nginx/ALB layer
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-ID', 'Authorization'],
  exposedHeaders: ['X-Request-ID'],
}));

app.use(express.json({ limit: '1mb' }));

// Correlation ID middleware
app.use((req, res, next) => {
  req.reqId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', req.reqId);
  next();
});

// Request logging + metrics
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.reqId,
  customLogLevel: (req, res) => (res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer({ method: req.method, route: req.path });
  res.on('finish', () => {
    end({ status_code: res.statusCode });
    httpRequestsTotal.inc({ method: req.method, route: req.path, status_code: res.statusCode });
  });
  next();
});

// Rate limiting — applied only to /api/* paths
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api', apiLimiter);

// ── Observability endpoints ───────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

app.get('/health', async (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const platform = process.env.PLATFORM_NAME || 'local';
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      version: VERSION,
      platform,
      db: 'connected',
      uptime,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      version: VERSION,
      platform,
      db: 'disconnected',
      db_error: err.message,
      uptime,
    });
  }
});

// Separate readiness probe — fails fast if DB is unavailable
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }
});

// ── Dashboard stats ───────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const [svcStats, incStats, recentInc, perfMetrics] = await Promise.all([
      dbQuery('dashboard_svc', `SELECT status, COUNT(*) AS count FROM services GROUP BY status`),
      dbQuery('dashboard_inc', `SELECT severity, status, COUNT(*) AS count FROM incidents GROUP BY severity, status`),
      dbQuery('dashboard_recent', `
        SELECT i.*, s.name AS service_name
        FROM incidents i LEFT JOIN services s ON i.service_id = s.id
        ORDER BY i.created_at DESC LIMIT 5
      `),
      Promise.resolve({ rows: [] }),
    ]);
    const svc = { total: 0, healthy: 0, degraded: 0, down: 0 };
    svcStats.rows.forEach(r => { svc[r.status] = parseInt(r.count); svc.total += parseInt(r.count); });
    const inc = { open: 0, investigating: 0, resolved: 0, p1: 0, p2: 0, p3: 0, p4: 0 };
    incStats.rows.forEach(r => {
      if (inc[r.status] !== undefined)                  inc[r.status] += parseInt(r.count);
      if (inc[r.severity?.toLowerCase()] !== undefined) inc[r.severity.toLowerCase()] += parseInt(r.count);
    });

    // Compute overall platform performance from metrics
    const totalRequests = perfMetrics.rows.length > 0
      ? perfMetrics.rows.reduce((sum, r) => sum + parseInt(r.total_requests), 0)
      : 0;
    const avgLatency = perfMetrics.rows.length > 0
      ? perfMetrics.rows.reduce((sum, r) => sum + parseFloat(r.avg_response_time), 0) / perfMetrics.rows.length
      : 0;
    const errorRate = totalRequests > 0
      ? perfMetrics.rows.reduce((sum, r) => sum + parseInt(r.error_count), 0) / totalRequests * 100
      : 0;

    res.json({
      services: svc,
      incidents: inc,
      recent_incidents: recentInc.rows,
      performance: {
        total_requests: totalRequests,
        avg_latency_ms: Math.round(avgLatency * 100) / 100,
        error_rate_pct: Math.round(errorRate * 100) / 100,
        by_service: perfMetrics.rows,
      },
    });
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack, req_id: req.reqId }, 'Dashboard query failed');
    res.status(500).json({ error: `Dashboard query failed: ${err.message}`, req_id: req.reqId });
  }
});

// ── Services CRUD ─────────────────────────────────────────────────────────────
app.get('/api/services', async (req, res) => {
  try {
    const result = await dbQuery('list_services', 'SELECT * FROM services ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.get('/api/services/:id', async (req, res) => {
  try {
    const result = await dbQuery('get_service', 'SELECT * FROM services WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Service not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.post('/api/services', async (req, res) => {
  const { name, type, environment, status, owner_team, endpoint_url } = req.body || {};
  if (!name?.trim() || !type?.trim()) return res.status(400).json({ error: 'name and type are required' });
  try {
    const result = await dbQuery('create_service',
      `INSERT INTO services (name, type, environment, status, owner_team, endpoint_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), type.trim(), environment || 'production', status || 'healthy', owner_team || null, endpoint_url || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.put('/api/services/:id', async (req, res) => {
  const { name, type, environment, status, owner_team, endpoint_url } = req.body || {};
  try {
    const result = await dbQuery('update_service',
      `UPDATE services SET name=$1, type=$2, environment=$3, status=$4, owner_team=$5, endpoint_url=$6
       WHERE id=$7 RETURNING *`,
      [name, type, environment, status, owner_team, endpoint_url, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Service not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.delete('/api/services/:id', async (req, res) => {
  try {
    const result = await dbQuery('delete_service', 'DELETE FROM services WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Service not found' });
    res.json({ deleted: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

// ── Incidents CRUD ────────────────────────────────────────────────────────────
app.get('/api/incidents', async (req, res) => {
  try {
    const { service_id, status, severity } = req.query;
    let q = `SELECT i.*, s.name AS service_name FROM incidents i LEFT JOIN services s ON i.service_id = s.id WHERE 1=1`;
    const params = [];
    if (service_id) { params.push(service_id); q += ` AND i.service_id = $${params.length}`; }
    if (status)     { params.push(status);     q += ` AND i.status = $${params.length}`; }
    if (severity)   { params.push(severity);   q += ` AND i.severity = $${params.length}`; }
    q += ' ORDER BY i.created_at DESC';
    const result = await dbQuery('list_incidents', q, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.get('/api/incidents/:id', async (req, res) => {
  try {
    const result = await dbQuery('get_incident',
      `SELECT i.*, s.name AS service_name FROM incidents i LEFT JOIN services s ON i.service_id = s.id WHERE i.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Incident not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.post('/api/incidents', async (req, res) => {
  const { service_id, title, severity, status, description } = req.body || {};
  if (!title?.trim() || !severity) return res.status(400).json({ error: 'title and severity are required' });
  if (!['P1','P2','P3','P4'].includes(severity)) return res.status(400).json({ error: 'severity must be P1–P4' });
  try {
    const result = await dbQuery('create_incident',
      `INSERT INTO incidents (service_id, title, severity, status, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [service_id || null, title.trim(), severity, status || 'open', description || null]
    );
    logger.info({ incident_id: result.rows[0].id, severity, req_id: req.reqId }, 'Incident created');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.put('/api/incidents/:id', async (req, res) => {
  const { service_id, title, severity, status, description } = req.body || {};
  try {
    const resolved_at = status === 'resolved' ? 'NOW()' : 'NULL';
    const result = await dbQuery('update_incident',
      `UPDATE incidents SET service_id=$1, title=$2, severity=$3, status=$4, description=$5, resolved_at=${resolved_at}
       WHERE id=$6 RETURNING *`,
      [service_id, title, severity, status, description, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Incident not found' });
    if (status === 'resolved') {
      logger.info({ incident_id: req.params.id, req_id: req.reqId }, 'Incident resolved');
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

app.delete('/api/incidents/:id', async (req, res) => {
  try {
    const result = await dbQuery('delete_incident', 'DELETE FROM incidents WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Incident not found' });
    res.json({ deleted: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message, req_id: req.reqId });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err: err.message, stack: err.stack, req_id: req.reqId }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error', req_id: req.reqId });
});

// ── Start + graceful shutdown ─────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  logger.info({ port: PORT, version: VERSION }, 'Server started');
  await initDB();
});

const shutdown = (signal) => {
  logger.info({ signal }, 'Shutdown initiated');
  server.close(async () => {
    logger.info('HTTP server closed');
    try { await pool.end(); } catch (_) {}
    logger.info('Database pool closed — exit');
    process.exit(0);
  });
  // Force exit if graceful shutdown takes too long
  setTimeout(() => { logger.error('Forced shutdown after timeout'); process.exit(1); }, 15000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
