import pg from 'pg';
const { Pool } = pg;

// Define an interface for the pool configuration properties we use
interface DBConfig {
  user?: string;
  password?: string;
  database: string;
  host?: string;
  port?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  maxLifetimeSeconds?: number;
  keepAlive?: boolean;
  keepAliveInitialDelayMillis?: number;
  max?: number;
}

const isCloudRun = process.env.K_SERVICE !== undefined;

const poolConfig: DBConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
};

if (isCloudRun && process.env.INSTANCE_CONNECTION_NAME) {
  // Connection configuration for Google Cloud SQL (Unix Sockets)
  poolConfig.host = `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}`;
} else {
  // Fallback for local development (TCP)
  poolConfig.host = process.env.DB_HOST || '127.0.0.1';
  poolConfig.port = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432;
}

// Recycle idle connections before Cloud SQL or a proxy can drop them silently.
export const pool = new Pool({
  ...poolConfig,
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 300,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});
