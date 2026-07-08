'use strict';
/*
 * db.js — creates the PostgreSQL connection pool from environment variables.
 * Standalone entry points (worker.js) use this. In the monorepo you can instead
 * pass your existing shared pool straight into runLiveScan(pool).
 *
 * Env:
 *   DATABASE_URL   full connection string (preferred), e.g.
 *                  postgres://user:pass@host:5432/dbname?sslmode=require
 *   or the discrete vars: PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
 *   PGSSL=true     enable SSL (AWS RDS etc.)
 */
const { Pool } = require('pg');

function createPool() {
  const ssl = String(process.env.PGSSL || '').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : undefined;

  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  }
  return new Pool({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'trading',
    ssl,
  });
}

module.exports = { createPool };
