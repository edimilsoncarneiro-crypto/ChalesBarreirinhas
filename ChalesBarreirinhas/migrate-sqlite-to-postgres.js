/**
 * Script de Migração: SQLite -> PostgreSQL
 * Lê os dados existentes em data/database.sqlite (ou data/initial_seed.json)
 * e os transfere de forma segura para o banco PostgreSQL.
 *
 * Uso:
 *   node migrate-sqlite-to-postgres.js
 */

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

const db = require('./database');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.sqlite');
const SEED_FILE = path.join(DATA_DIR, 'initial_seed.json');

async function runMigration() {
  console.log('\n=======================================================');
  console.log('   MIGRAÇÃO DE DADOS: SQLite -> PostgreSQL');
  console.log('=======================================================\n');

  try {
    // 1. Inicializa tabelas no PostgreSQL
    console.log('[1/4] Conectando ao PostgreSQL e criando tabelas...');
    await db.initDatabase();

    let expensesToMigrate = [];
    let aportesToMigrate = [];
    let source = 'nenhum';

    // 2. Tenta ler do banco SQLite se ele existir
    if (fs.existsSync(DB_FILE)) {
      console.log(`[2/4] Arquivo SQLite encontrado: ${DB_FILE}`);
      try {
        const { DatabaseSync } = require('node:sqlite');
        const sqliteDb = new DatabaseSync(DB_FILE);
        expensesToMigrate = sqliteDb.prepare('SELECT * FROM expenses').all();
        aportesToMigrate = sqliteDb.prepare('SELECT * FROM aportes').all();
        source = 'data/database.sqlite';
        console.log(`      Lidos do SQLite: ${expensesToMigrate.length} despesas e ${aportesToMigrate.length} aportes.`);
      } catch (err) {
        console.warn('      Aviso: Não foi possível ler via node:sqlite (' + err.message + '). Tentando initial_seed.json...');
      }
    }

    // 3. Se SQLite não forneceu dados, tenta initial_seed.json
    if (expensesToMigrate.length === 0 && aportesToMigrate.length === 0 && fs.existsSync(SEED_FILE)) {
      console.log(`[2/4] Lendo dados a partir do arquivo de seed: ${SEED_FILE}`);
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      expensesToMigrate = seed.expenses || [];
      aportesToMigrate = seed.aportes || [];
      source = 'data/initial_seed.json';
      console.log(`      Lidos do JSON: ${expensesToMigrate.length} despesas e ${aportesToMigrate.length} aportes.`);
    }

    if (expensesToMigrate.length === 0 && aportesToMigrate.length === 0) {
      console.log('\nNenhum dado encontrado para migrar.');
      await db.closePool();
      return;
    }

    // 4. Inserção no PostgreSQL
    console.log(`[3/4] Gravando registros no PostgreSQL (Origem: ${source})...`);
    const pool = db.getPool();
    const client = await pool.connect();

    let insertedExpenses = 0;
    let updatedExpenses = 0;
    let insertedAportes = 0;
    let updatedAportes = 0;

    try {
      await client.query('BEGIN');

      for (const item of expensesToMigrate) {
        const id = parseInt(item.id, 10);
        const phase = String(item.phase || 'FASE_2');
        const desc = String(item.desc || '').trim();
        const qty = item.qty !== null && item.qty !== undefined ? String(item.qty).trim() : '';
        const value = parseFloat(item.value) || 0;
        const status = String(item.status || 'Confirmado');

        const res = await client.query(`
          INSERT INTO expenses (id, phase, "desc", qty, value, status)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (id) DO UPDATE
          SET phase = EXCLUDED.phase,
              "desc" = EXCLUDED."desc",
              qty = EXCLUDED.qty,
              value = EXCLUDED.value,
              status = EXCLUDED.status,
              updated_at = CURRENT_TIMESTAMP
          RETURNING (xmax = 0) AS is_inserted
        `, [id, phase, desc, qty, value, status]);

        if (res.rows[0].is_inserted) {
          insertedExpenses++;
        } else {
          updatedExpenses++;
        }
      }

      for (const item of aportesToMigrate) {
        const id = parseInt(item.id, 10);
        const date = String(item.date || '').trim();
        const desc = String(item.desc || '').trim();
        const value = parseFloat(item.value) || 0;

        const res = await client.query(`
          INSERT INTO aportes (id, date, "desc", value)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE
          SET date = EXCLUDED.date,
              "desc" = EXCLUDED."desc",
              value = EXCLUDED.value,
              updated_at = CURRENT_TIMESTAMP
          RETURNING (xmax = 0) AS is_inserted
        `, [id, date, desc, value]);

        if (res.rows[0].is_inserted) {
          insertedAportes++;
        } else {
          updatedAportes++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log('[4/4] Verificando totais no PostgreSQL...');
    const totals = await db.getFinancialTotals();

    console.log('\n=======================================================');
    console.log('   ✅ MIGRAÇÃO CONCLUÍDA COM SUCESSO!');
    console.log('=======================================================');
    console.log(`Despesas migradas: ${insertedExpenses} novas, ${updatedExpenses} atualizadas`);
    console.log(`Aportes migrados:  ${insertedAportes} novos, ${updatedAportes} atualizados`);
    console.log(`Total Despesas no PostgreSQL: ${totals.expensesCount}`);
    console.log(`Total Aportes no PostgreSQL:  ${totals.aportesCount}`);
    console.log(`Total Executado: R$ ${totals.totalExecutado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    console.log('=======================================================\n');
  } catch (error) {
    console.error('\n❌ ERRO DURANTE A MIGRAÇÃO:', error.message);
    console.error('Certifique-se de que o PostgreSQL está rodando e as credenciais no .env estão corretas.\n');
  } finally {
    await db.closePool();
  }
}

runMigration();

