const path = require('path');
const fs = require('fs');

// Se as dependências estiverem instaladas no disco local C: (contornando o Google Drive)
const localModulesDir = path.join(process.env.LOCALAPPDATA || 'C:\\', 'ChalesBarreirinhas_Modules', 'node_modules');
if (fs.existsSync(localModulesDir)) {
  const Module = require('module');
  if (Module.globalPaths && !Module.globalPaths.includes(localModulesDir)) {
    Module.globalPaths.push(localModulesDir);
  }
}

// Carregamento resiliente de variáveis de ambiente do .env
try {
  require('dotenv').config();
} catch (e) {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
}

let Pool;
try {
  ({ Pool } = require('pg'));
} catch (e) {
  console.error('\n=======================================================');
  console.error('  ❌ O pacote "pg" (driver PostgreSQL) não foi encontrado!');
  console.error('=======================================================');
  console.error('Para instalar as dependências necessárias, execute no terminal:');
  console.error('   npm install\n');
  console.error('Ou simplesmente execute o arquivo iniciar.bat que instalará automaticamente.\n');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const SEED_FILE = path.join(DATA_DIR, 'initial_seed.json');

// Garante a existência das pastas data e backups
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

function getPoolConfig() {
  const config = {};

  if (process.env.DATABASE_URL) {
    config.connectionString = process.env.DATABASE_URL;
    if (
      process.env.PGSSL === 'true' ||
      process.env.DATABASE_URL.includes('sslmode=require') ||
      process.env.DATABASE_URL.includes('supabase') ||
      process.env.DATABASE_URL.includes('neon.tech')
    ) {
      config.ssl = { rejectUnauthorized: false };
    }
  } else {
    config.host = process.env.PGHOST || 'localhost';
    config.port = parseInt(process.env.PGPORT, 10) || 5432;
    config.database = process.env.PGDATABASE || 'chales_barreirinhas';
    config.user = process.env.PGUSER || 'postgres';
    config.password = String(process.env.PGPASSWORD !== undefined ? process.env.PGPASSWORD : 'postgres');
    if (process.env.PGSSL === 'true') {
      config.ssl = { rejectUnauthorized: false };
    }
  }
  return config;
}

let poolInstance = null;

function getPool() {
  if (!poolInstance) {
    const config = getPoolConfig();
    poolInstance = new Pool(config);

    poolInstance.on('error', (err) => {
      console.error('[PostgreSQL] Erro inesperado no cliente do pool:', err.message);
    });
  }
  return poolInstance;
}

/**
 * Tenta criar automaticamente o banco de dados caso não exista (em ambiente local)
 */
async function ensureDatabaseExists(config) {
  if (config.connectionString) return;
  const targetDb = config.database;
  if (!targetDb || targetDb === 'postgres') return;

  const adminPool = new Pool({ ...config, database: 'postgres' });
  try {
    const checkRes = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDb]
    );
    if (checkRes.rows.length === 0) {
      console.log(`[PostgreSQL] O banco "${targetDb}" não existia. Criando automaticamente...`);
      const safeName = targetDb.replace(/[^a-zA-Z0-9_]/g, '');
      await adminPool.query(`CREATE DATABASE "${safeName}"`);
      console.log(`[PostgreSQL] ✅ Banco de dados "${safeName}" criado com sucesso!`);
    }
  } catch (err) {
    // Se falhar (ex: serviço offline ou senha errada), prossegue para o fluxo de conexão reportar o erro exato
  } finally {
    await adminPool.end().catch(() => {});
  }
}

async function query(text, params) {
  const pool = getPool();
  return await pool.query(text, params);
}

function formatExpenseRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    phase: row.phase,
    desc: row.desc,
    qty: row.qty !== null && row.qty !== undefined ? String(row.qty) : '',
    value: parseFloat(row.value) || 0,
    status: row.status || 'Confirmado',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function formatAporteRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    date: row.date,
    desc: row.desc,
    value: parseFloat(row.value) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Criação segura das tabelas e carga inicial se o banco estiver vazio.
 */
async function initDatabase() {
  const config = getPoolConfig();
  await ensureDatabaseExists(config);

  const pool = getPool();

  // 1. Testa a conexão obtendo um cliente do pool
  const testClient = await pool.connect();
  testClient.release();

  // 2. Criação das tabelas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id BIGINT PRIMARY KEY,
      phase VARCHAR(50) NOT NULL,
      "desc" TEXT NOT NULL,
      qty VARCHAR(255),
      value NUMERIC(15, 2) NOT NULL DEFAULT 0,
      status VARCHAR(50) NOT NULL DEFAULT 'Confirmado',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS aportes (
      id BIGINT PRIMARY KEY,
      date VARCHAR(50) NOT NULL,
      "desc" TEXT NOT NULL,
      value NUMERIC(15, 2) NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Verifica contagem atual de registros
  const expRes = await pool.query('SELECT COUNT(*) as count FROM expenses');
  const apoRes = await pool.query('SELECT COUNT(*) as count FROM aportes');

  const expCount = parseInt(expRes.rows[0].count, 10);
  const apoCount = parseInt(apoRes.rows[0].count, 10);

  console.log(`[Database] Registros atuais no PostgreSQL: ${expCount} despesas, ${apoCount} aportes.`);

  // 4. Se estiver completamente vazio, realiza carga inicial do seed
  if (expCount === 0 || apoCount === 0) {
    let seedData = null;
    if (fs.existsSync(SEED_FILE)) {
      try {
        seedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      } catch (err) {
        console.error('[Database] Erro ao ler initial_seed.json:', err.message);
      }
    }

    if (seedData) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (expCount === 0 && Array.isArray(seedData.expenses)) {
          for (const item of seedData.expenses) {
            await client.query(`
              INSERT INTO expenses (id, phase, "desc", qty, value, status)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (id) DO NOTHING
            `, [
              parseInt(item.id, 10),
              String(item.phase || 'FASE_2'),
              String(item.desc || ''),
              item.qty !== null && item.qty !== undefined ? String(item.qty) : '',
              parseFloat(item.value) || 0,
              String(item.status || 'Confirmado')
            ]);
          }
          console.log(`[Database] Carga inicial de ${seedData.expenses.length} despesas concluída no PostgreSQL.`);
        }

        if (apoCount === 0 && Array.isArray(seedData.aportes)) {
          for (const item of seedData.aportes) {
            await client.query(`
              INSERT INTO aportes (id, date, "desc", value)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (id) DO NOTHING
            `, [
              parseInt(item.id, 10),
              String(item.date || ''),
              String(item.desc || ''),
              parseFloat(item.value) || 0
            ]);
          }
          console.log(`[Database] Carga inicial de ${seedData.aportes.length} aportes concluída no PostgreSQL.`);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Database] Falha ao realizar seed inicial no PostgreSQL:', error);
      } finally {
        client.release();
      }
    }
  }
}

/**
 * Procedimento de Backup das tabelas em JSON
 */
async function createDatabaseBackup(reason = 'auto') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `database_backup_${timestamp}_${reason}.json`;
  const backupPath = path.join(BACKUPS_DIR, backupFileName);

  const expenses = await getAllExpenses();
  const aportes = await getAllAportes();
  const totals = await getFinancialTotals();

  const backupData = {
    exportedAt: new Date().toISOString(),
    database: 'PostgreSQL',
    reason,
    totals,
    expenses,
    aportes
  };

  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf8');
  console.log(`[Backup] Backup do banco PostgreSQL gerado em: ${backupPath}`);
  return backupPath;
}

// ==========================================
// OPERAÇÕES: DESPESAS (EXPENSES)
// ==========================================

async function getAllExpenses() {
  const res = await query('SELECT id, phase, "desc", qty, value, status, created_at, updated_at FROM expenses ORDER BY id DESC');
  return res.rows.map(formatExpenseRow);
}

async function getExpenseById(id) {
  const res = await query('SELECT id, phase, "desc", qty, value, status, created_at, updated_at FROM expenses WHERE id = $1', [parseInt(id, 10)]);
  return res.rows.length ? formatExpenseRow(res.rows[0]) : null;
}

async function createExpense(data) {
  validateExpenseData(data);
  const id = data.id ? parseInt(data.id, 10) : Date.now();
  const phase = String(data.phase);
  const desc = String(data.desc).trim();
  const qty = data.qty !== null && data.qty !== undefined ? String(data.qty).trim() : '';
  const value = parseFloat(data.value) || 0;
  const status = String(data.status || 'Confirmado');

  const res = await query(`
    INSERT INTO expenses (id, phase, "desc", qty, value, status)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, phase, "desc", qty, value, status, created_at, updated_at
  `, [id, phase, desc, qty, value, status]);

  return formatExpenseRow(res.rows[0]);
}

async function updateExpense(id, data) {
  validateExpenseData(data);
  const targetId = parseInt(id, 10);
  const existing = await getExpenseById(targetId);
  if (!existing) return null;

  const phase = String(data.phase);
  const desc = String(data.desc).trim();
  const qty = data.qty !== null && data.qty !== undefined ? String(data.qty).trim() : '';
  const value = parseFloat(data.value) || 0;
  const status = String(data.status || 'Confirmado');

  const res = await query(`
    UPDATE expenses
    SET phase = $1, "desc" = $2, qty = $3, value = $4, status = $5, updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
    RETURNING id, phase, "desc", qty, value, status, created_at, updated_at
  `, [phase, desc, qty, value, status, targetId]);

  return formatExpenseRow(res.rows[0]);
}

async function deleteExpense(id) {
  const targetId = parseInt(id, 10);
  const res = await query('DELETE FROM expenses WHERE id = $1', [targetId]);
  return res.rowCount > 0;
}

// ==========================================
// OPERAÇÕES: APORTES
// ==========================================

async function getAllAportes() {
  const res = await query('SELECT id, date, "desc", value, created_at, updated_at FROM aportes ORDER BY id DESC');
  return res.rows.map(formatAporteRow);
}

async function getAporteById(id) {
  const res = await query('SELECT id, date, "desc", value, created_at, updated_at FROM aportes WHERE id = $1', [parseInt(id, 10)]);
  return res.rows.length ? formatAporteRow(res.rows[0]) : null;
}

async function createAporte(data) {
  validateAporteData(data);
  const id = data.id ? parseInt(data.id, 10) : Date.now();
  const date = String(data.date).trim();
  const desc = String(data.desc).trim();
  const value = parseFloat(data.value) || 0;

  const res = await query(`
    INSERT INTO aportes (id, date, "desc", value)
    VALUES ($1, $2, $3, $4)
    RETURNING id, date, "desc", value, created_at, updated_at
  `, [id, date, desc, value]);

  return formatAporteRow(res.rows[0]);
}

async function updateAporte(id, data) {
  validateAporteData(data);
  const targetId = parseInt(id, 10);
  const existing = await getAporteById(targetId);
  if (!existing) return null;

  const date = String(data.date).trim();
  const desc = String(data.desc).trim();
  const value = parseFloat(data.value) || 0;

  const res = await query(`
    UPDATE aportes
    SET date = $1, "desc" = $2, value = $3, updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING id, date, "desc", value, created_at, updated_at
  `, [date, desc, value, targetId]);

  return formatAporteRow(res.rows[0]);
}

async function deleteAporte(id) {
  const targetId = parseInt(id, 10);
  const res = await query('DELETE FROM aportes WHERE id = $1', [targetId]);
  return res.rowCount > 0;
}

// ==========================================
// MIGRAÇÃO SEGURA A PARTIR DO LOCALSTORAGE
// ==========================================

async function migrateFromLocalStorage(payload) {
  const expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
  const aportes = Array.isArray(payload.aportes) ? payload.aportes : [];

  let insertedExpenses = 0;
  let insertedAportes = 0;
  let skippedExpenses = 0;
  let skippedAportes = 0;

  await createDatabaseBackup('pre_migration');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    for (const item of expenses) {
      if (!item || !item.id) continue;
      const itemId = parseInt(item.id, 10);
      const check = await client.query('SELECT id FROM expenses WHERE id = $1', [itemId]);
      if (check.rows.length > 0) {
        skippedExpenses++;
      } else {
        await client.query(`
          INSERT INTO expenses (id, phase, "desc", qty, value, status)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          itemId,
          String(item.phase || 'FASE_2'),
          String(item.desc || '').trim(),
          item.qty ? String(item.qty).trim() : '',
          parseFloat(item.value) || 0,
          String(item.status || 'Confirmado')
        ]);
        insertedExpenses++;
      }
    }

    for (const item of aportes) {
      if (!item || !item.id) continue;
      const itemId = parseInt(item.id, 10);
      const check = await client.query('SELECT id FROM aportes WHERE id = $1', [itemId]);
      if (check.rows.length > 0) {
        skippedAportes++;
      } else {
        await client.query(`
          INSERT INTO aportes (id, date, "desc", value)
          VALUES ($1, $2, $3, $4)
        `, [
          itemId,
          String(item.date || '').trim(),
          String(item.desc || '').trim(),
          parseFloat(item.value) || 0
        ]);
        insertedAportes++;
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Migration] Erro durante migração PostgreSQL (revertida):', error);
    throw error;
  } finally {
    client.release();
  }

  const totals = await getFinancialTotals();
  return {
    success: true,
    insertedExpenses,
    skippedExpenses,
    insertedAportes,
    skippedAportes,
    totalExpenses: totals.expensesCount,
    totalAportes: totals.aportesCount,
    totals
  };
}

// ==========================================
// RESTAURAÇÃO E RESET COM BACKUP PRÉVIO
// ==========================================

async function restoreData(payload) {
  if (!payload || !Array.isArray(payload.expenses)) {
    throw new Error('Formato inválido de backup para restauração.');
  }

  await createDatabaseBackup('pre_restore');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM expenses');
    await client.query('DELETE FROM aportes');

    for (const item of payload.expenses) {
      await client.query(`
        INSERT INTO expenses (id, phase, "desc", qty, value, status)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        parseInt(item.id, 10),
        String(item.phase || 'FASE_2'),
        String(item.desc || ''),
        item.qty ? String(item.qty) : '',
        parseFloat(item.value) || 0,
        String(item.status || 'Confirmado')
      ]);
    }

    if (Array.isArray(payload.aportes)) {
      for (const item of payload.aportes) {
        await client.query(`
          INSERT INTO aportes (id, date, "desc", value)
          VALUES ($1, $2, $3, $4)
        `, [
          parseInt(item.id, 10),
          String(item.date || ''),
          String(item.desc || ''),
          parseFloat(item.value) || 0
        ]);
      }
    }

    await client.query('COMMIT');
    return {
      success: true,
      countExpenses: payload.expenses.length,
      countAportes: (payload.aportes || []).length
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function resetToSeed() {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error('Arquivo de dados padrão (initial_seed.json) não encontrado.');
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  return await restoreData(seed);
}

// ==========================================
// CÁLCULO E CONFERÊNCIA FINANCEIRA
// ==========================================

async function getFinancialTotals() {
  const expRes = await query('SELECT phase, value FROM expenses');
  const apoRes = await query('SELECT value FROM aportes');

  const expenses = expRes.rows;
  const aportes = apoRes.rows;

  let sumFase1 = 0;
  let sumFase2 = 0;
  let sumCartao = 0;
  let sumPendentes = 0;

  for (const e of expenses) {
    const val = parseFloat(e.value) || 0;
    if (e.phase === 'FASE_1') sumFase1 += val;
    else if (e.phase === 'FASE_2') sumFase2 += val;
    else if (e.phase === 'CARTAO') sumCartao += val;
    else if (e.phase === 'PENDENTE') sumPendentes += val;
  }

  const totalExecutado = sumFase1 + sumFase2 + sumCartao;
  const totalAportes = aportes.reduce((acc, a) => acc + (parseFloat(a.value) || 0), 0);

  // Fórmula oficial do projeto para utilização dos aportes:
  const baseFase2 = 91831.58;
  const baseUtilizadoAportes = 60259.00;
  const novosGastosFase2 = sumFase2 - baseFase2;
  const valorUtilizadoAportes = baseUtilizadoAportes + novosGastosFase2;
  const saldoAportes = totalAportes - valorUtilizadoAportes;

  return {
    expensesCount: expenses.length,
    aportesCount: aportes.length,
    sumFase1: round(sumFase1),
    sumFase2: round(sumFase2),
    sumCartao: round(sumCartao),
    sumPendentes: round(sumPendentes),
    totalExecutado: round(totalExecutado),
    totalAportes: round(totalAportes),
    valorUtilizadoAportes: round(valorUtilizadoAportes),
    saldoAportes: round(saldoAportes)
  };
}

function round(val) {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

// ==========================================
// VALIDAÇÕES
// ==========================================

function validateExpenseData(data) {
  if (!data) throw new Error('Dados do lançamento não fornecidos.');
  if (!data.desc || String(data.desc).trim() === '') throw new Error('A descrição do lançamento é obrigatória.');
  if (!data.phase || !['FASE_1', 'FASE_2', 'CARTAO', 'PENDENTE'].includes(data.phase)) {
    throw new Error('Fase/Categoria inválida. Deve ser FASE_1, FASE_2, CARTAO ou PENDENTE.');
  }
  if (data.value === undefined || data.value === null || isNaN(parseFloat(data.value))) {
    throw new Error('Valor numérico inválido.');
  }
}

function validateAporteData(data) {
  if (!data) throw new Error('Dados do aporte não fornecidos.');
  if (!data.date || String(data.date).trim() === '') throw new Error('A data/referência do aporte é obrigatória.');
  if (!data.desc || String(data.desc).trim() === '') throw new Error('A descrição do aporte é obrigatória.');
  if (data.value === undefined || data.value === null || isNaN(parseFloat(data.value))) {
    throw new Error('Valor do aporte numérico inválido.');
  }
}

async function closePool() {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

module.exports = {
  getPool,
  query,
  initDatabase,
  createDatabaseBackup,
  getAllExpenses,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense,
  getAllAportes,
  getAporteById,
  createAporte,
  updateAporte,
  deleteAporte,
  migrateFromLocalStorage,
  restoreData,
  resetToSeed,
  getFinancialTotals,
  closePool
};
