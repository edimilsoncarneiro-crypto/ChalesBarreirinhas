const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const DB_FILE = path.join(DATA_DIR, 'database.sqlite');
const SEED_FILE = path.join(DATA_DIR, 'initial_seed.json');

// Garante a existência das pastas data e backups
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_FILE);
    // Habilita modo WAL e foreign keys para maior integridade e desempenho
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
  }
  return dbInstance;
}

/**
 * Criação segura das tabelas e carga inicial apenas se o banco estiver vazio.
 * Nunca apaga nem sobrescreve dados existentes.
 */
function initDatabase() {
  const db = getDb();

  // 1. Criação das tabelas caso não existam
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      phase TEXT NOT NULL,
      desc TEXT NOT NULL,
      qty TEXT,
      value REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Confirmado',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS aportes (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      desc TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 2. Verifica se já existem dados
  const expCount = db.prepare('SELECT COUNT(*) as count FROM expenses').get().count;
  const apoCount = db.prepare('SELECT COUNT(*) as count FROM aportes').get().count;

  console.log(`[Database] Registros atuais no SQLite: ${expCount} despesas, ${apoCount} aportes.`);

  // 3. Se estiver completamente vazio, realiza o seed seguro inicial
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
      db.exec('BEGIN TRANSACTION');
      try {
        if (expCount === 0 && Array.isArray(seedData.expenses)) {
          const insertExp = db.prepare(`
            INSERT INTO expenses (id, phase, desc, qty, value, status)
            VALUES (?, ?, ?, ?, ?, ?)
          `);
          for (const item of seedData.expenses) {
            insertExp.run(
              item.id,
              String(item.phase || 'FASE_2'),
              String(item.desc || ''),
              item.qty !== null && item.qty !== undefined ? String(item.qty) : '',
              parseFloat(item.value) || 0,
              String(item.status || 'Confirmado')
            );
          }
          console.log(`[Database] Carga inicial de ${seedData.expenses.length} despesas concluída com sucesso.`);
        }

        if (apoCount === 0 && Array.isArray(seedData.aportes)) {
          const insertApo = db.prepare(`
            INSERT INTO aportes (id, date, desc, value)
            VALUES (?, ?, ?, ?)
          `);
          for (const item of seedData.aportes) {
            insertApo.run(
              item.id,
              String(item.date || ''),
              String(item.desc || ''),
              parseFloat(item.value) || 0
            );
          }
          console.log(`[Database] Carga inicial de ${seedData.aportes.length} aportes concluída com sucesso.`);
        }

        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        console.error('[Database] Falha ao realizar seed inicial (transação revertida):', error);
      }
    }
  }
}

/**
 * Procedimento de Backup do Arquivo SQLite
 */
function createDatabaseBackup(reason = 'auto') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `database_backup_${timestamp}_${reason}.sqlite`;
  const backupPath = path.join(BACKUPS_DIR, backupFileName);

  if (fs.existsSync(DB_FILE)) {
    // Garante que os dados ainda no WAL sejam incorporados antes da cópia.
    getDb().exec('PRAGMA wal_checkpoint(FULL);');
    fs.copyFileSync(DB_FILE, backupPath);
    console.log(`[Backup] Backup do banco SQLite gerado em: ${backupPath}`);
    return backupPath;
  }
  return null;
}

// ==========================================
// OPERAÇÕES: DESPESAS (EXPENSES)
// ==========================================

function getAllExpenses() {
  const db = getDb();
  // Ordena por id decrescente para que novos lançamentos fiquem no topo
  return db.prepare('SELECT id, phase, desc, qty, value, status, created_at, updated_at FROM expenses ORDER BY id DESC').all();
}

function getExpenseById(id) {
  const db = getDb();
  return db.prepare('SELECT id, phase, desc, qty, value, status, created_at, updated_at FROM expenses WHERE id = ?').get(id);
}

function createExpense(data) {
  validateExpenseData(data);
  const db = getDb();
  const id = data.id ? parseInt(data.id, 10) : Date.now();
  const phase = String(data.phase);
  const desc = String(data.desc).trim();
  const qty = data.qty !== null && data.qty !== undefined ? String(data.qty).trim() : '';
  const value = parseFloat(data.value) || 0;
  const status = String(data.status || 'Confirmado');

  const stmt = db.prepare(`
    INSERT INTO expenses (id, phase, desc, qty, value, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, phase, desc, qty, value, status);
  return getExpenseById(id);
}

function updateExpense(id, data) {
  validateExpenseData(data);
  const db = getDb();
  const targetId = parseInt(id, 10);
  const existing = getExpenseById(targetId);
  if (!existing) return null;

  const phase = String(data.phase);
  const desc = String(data.desc).trim();
  const qty = data.qty !== null && data.qty !== undefined ? String(data.qty).trim() : '';
  const value = parseFloat(data.value) || 0;
  const status = String(data.status || 'Confirmado');

  const stmt = db.prepare(`
    UPDATE expenses
    SET phase = ?, desc = ?, qty = ?, value = ?, status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);
  stmt.run(phase, desc, qty, value, status, targetId);
  return getExpenseById(targetId);
}

function deleteExpense(id) {
  const db = getDb();
  const targetId = parseInt(id, 10);
  const existing = getExpenseById(targetId);
  if (!existing) return false;

  const stmt = db.prepare('DELETE FROM expenses WHERE id = ?');
  stmt.run(targetId);
  return true;
}

// ==========================================
// OPERAÇÕES: APORTES
// ==========================================

function getAllAportes() {
  const db = getDb();
  return db.prepare('SELECT id, date, desc, value, created_at, updated_at FROM aportes ORDER BY id DESC').all();
}

function getAporteById(id) {
  const db = getDb();
  return db.prepare('SELECT id, date, desc, value, created_at, updated_at FROM aportes WHERE id = ?').get(id);
}

function createAporte(data) {
  validateAporteData(data);
  const db = getDb();
  const id = data.id ? parseInt(data.id, 10) : Date.now();
  const date = String(data.date).trim();
  const desc = String(data.desc).trim();
  const value = parseFloat(data.value) || 0;

  const stmt = db.prepare(`
    INSERT INTO aportes (id, date, desc, value)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(id, date, desc, value);
  return getAporteById(id);
}

function updateAporte(id, data) {
  validateAporteData(data);
  const db = getDb();
  const targetId = parseInt(id, 10);
  const existing = getAporteById(targetId);
  if (!existing) return null;

  const date = String(data.date).trim();
  const desc = String(data.desc).trim();
  const value = parseFloat(data.value) || 0;

  const stmt = db.prepare(`
    UPDATE aportes
    SET date = ?, desc = ?, value = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);
  stmt.run(date, desc, value, targetId);
  return getAporteById(targetId);
}

function deleteAporte(id) {
  const db = getDb();
  const targetId = parseInt(id, 10);
  const existing = getAporteById(targetId);
  if (!existing) return false;

  const stmt = db.prepare('DELETE FROM aportes WHERE id = ?');
  stmt.run(targetId);
  return true;
}

// ==========================================
// MIGRAÇÃO SEGURA A PARTIR DO LOCALSTORAGE
// ==========================================

/**
 * Migra dados do localStorage para o SQLite sem duplicar e sem apagar registros existentes.
 */
function migrateFromLocalStorage(payload) {
  const db = getDb();
  const expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
  const aportes = Array.isArray(payload.aportes) ? payload.aportes : [];

  let insertedExpenses = 0;
  let insertedAportes = 0;
  let skippedExpenses = 0;
  let skippedAportes = 0;

  createDatabaseBackup('pre_migration');

  db.exec('BEGIN TRANSACTION');
  try {
    const checkExp = db.prepare('SELECT id FROM expenses WHERE id = ?');
    const insertExp = db.prepare(`
      INSERT INTO expenses (id, phase, desc, qty, value, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of expenses) {
      if (!item || !item.id) continue;
      const exists = checkExp.get(item.id);
      if (exists) {
        skippedExpenses++;
      } else {
        insertExp.run(
          parseInt(item.id, 10),
          String(item.phase || 'FASE_2'),
          String(item.desc || '').trim(),
          item.qty ? String(item.qty).trim() : '',
          parseFloat(item.value) || 0,
          String(item.status || 'Confirmado')
        );
        insertedExpenses++;
      }
    }

    const checkApo = db.prepare('SELECT id FROM aportes WHERE id = ?');
    const insertApo = db.prepare(`
      INSERT INTO aportes (id, date, desc, value)
      VALUES (?, ?, ?, ?)
    `);

    for (const item of aportes) {
      if (!item || !item.id) continue;
      const exists = checkApo.get(item.id);
      if (exists) {
        skippedAportes++;
      } else {
        insertApo.run(
          parseInt(item.id, 10),
          String(item.date || '').trim(),
          String(item.desc || '').trim(),
          parseFloat(item.value) || 0
        );
        insertedAportes++;
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('[Migration] Erro durante migração (revertida):', error);
    throw error;
  }

  const totals = getFinancialTotals();
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

function restoreData(payload) {
  const db = getDb();
  if (!payload || !Array.isArray(payload.expenses)) {
    throw new Error('Formato inválido de backup para restauração.');
  }

  createDatabaseBackup('pre_restore');

  db.exec('BEGIN TRANSACTION');
  try {
    db.exec('DELETE FROM expenses;');
    db.exec('DELETE FROM aportes;');

    const insertExp = db.prepare(`
      INSERT INTO expenses (id, phase, desc, qty, value, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of payload.expenses) {
      insertExp.run(
        parseInt(item.id, 10),
        String(item.phase || 'FASE_2'),
        String(item.desc || ''),
        item.qty ? String(item.qty) : '',
        parseFloat(item.value) || 0,
        String(item.status || 'Confirmado')
      );
    }

    if (Array.isArray(payload.aportes)) {
      const insertApo = db.prepare(`
        INSERT INTO aportes (id, date, desc, value)
        VALUES (?, ?, ?, ?)
      `);
      for (const item of payload.aportes) {
        insertApo.run(
          parseInt(item.id, 10),
          String(item.date || ''),
          String(item.desc || ''),
          parseFloat(item.value) || 0
        );
      }
    }

    db.exec('COMMIT');
    return { success: true, countExpenses: payload.expenses.length, countAportes: (payload.aportes || []).length };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function resetToSeed() {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error('Arquivo de dados padrão (initial_seed.json) não encontrado.');
  }
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  return restoreData(seed);
}

// ==========================================
// CÁLCULO E CONFERÊNCIA FINANCEIRA
// ==========================================

function getFinancialTotals() {
  const db = getDb();
  const expenses = db.prepare('SELECT phase, value FROM expenses').all();
  const aportes = db.prepare('SELECT value FROM aportes').all();

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

module.exports = {
  getDb,
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
  getFinancialTotals
};

