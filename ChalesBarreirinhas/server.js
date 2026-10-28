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

// Carregamento resiliente do .env (com ou sem pacote dotenv instalado)
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

const express = require('express');
const db = require('./database');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve arquivos estáticos do front-end (index.html, etc.)
const authAttempts = new Map();

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  if (!origin || origin !== expectedOrigin) {
    return res.status(403).json({ error: 'Origem da requisicao nao permitida.' });
  }
  next();
}

function limitAuthAttempts(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let attempt = authAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
    attempt = { startedAt: now, count: 0 };
    authAttempts.set(key, attempt);
  }
  for (const [ip, entry] of authAttempts) {
    if (now - entry.startedAt >= 15 * 60 * 1000) authAttempts.delete(ip);
  }
  if (attempt.count >= 5) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' });
  }
  req.authAttemptKey = key;
  next();
}

function recordAuthFailure(req) {
  const entry = authAttempts.get(req.authAttemptKey);
  if (entry) entry.count += 1;
}

function clearAuthFailures(req) {
  authAttempts.delete(req.authAttemptKey);
}

app.get('/api/auth/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ configured: auth.isConfigured(), authenticated: auth.isAuthenticated(req) });
});

app.post('/api/auth/setup', requireSameOrigin, limitAuthAttempts, (req, res) => {
  try {
    auth.setup(req.body.setupToken, req.body.username, req.body.password);
    clearAuthFailures(req);
    auth.setSessionCookie(res, req);
    res.status(201).json({ success: true });
  } catch (error) {
    recordAuthFailure(req);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', requireSameOrigin, limitAuthAttempts, (req, res) => {
  if (!auth.isConfigured()) return res.status(503).json({ error: 'Configure o acesso inicial antes de entrar.' });
  if (!auth.verifyCredentials(req.body.username, req.body.password)) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  clearAuthFailures(req);
  auth.setSessionCookie(res, req);
  res.json({ success: true });
});

app.post('/api/auth/logout', requireSameOrigin, (req, res) => {
  auth.clearSessionCookie(res, req);
  res.json({ success: true });
});

app.get('/login', (req, res) => {
  if (auth.isAuthenticated(req)) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', (req, res, next) => {
  if (!auth.isConfigured() || !auth.isAuthenticated(req)) return res.redirect('/login');
  next();
}, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => res.redirect('/'));
app.use('/api', auth.requireAuth);

// ==========================================
// ROTAS DA API: DESPESAS (EXPENSES)
// ==========================================

app.get('/api/expenses', async (req, res) => {
  try {
    const expenses = await db.getAllExpenses();
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/expenses/:id', async (req, res) => {
  try {
    const item = await db.getExpenseById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Lançamento não encontrado' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const created = await db.createExpense(req.body);
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/expenses/:id', async (req, res) => {
  try {
    const updated = await db.updateExpense(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Lançamento não encontrado' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const success = await db.deleteExpense(req.params.id);
    if (!success) return res.status(404).json({ error: 'Lançamento não encontrado' });
    res.json({ success: true, message: 'Lançamento excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTAS DA API: APORTES
// ==========================================

app.get('/api/aportes', async (req, res) => {
  try {
    const aportes = await db.getAllAportes();
    res.json(aportes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/aportes/:id', async (req, res) => {
  try {
    const item = await db.getAporteById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/aportes', async (req, res) => {
  try {
    const created = await db.createAporte(req.body);
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/aportes/:id', async (req, res) => {
  try {
    const updated = await db.updateAporte(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/aportes/:id', async (req, res) => {
  try {
    const success = await db.deleteAporte(req.params.id);
    if (!success) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json({ success: true, message: 'Aporte excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// TOTAIS E INDICADORES FINANCEIROS
// ==========================================

app.get('/api/totals', async (req, res) => {
  try {
    const totals = await db.getFinancialTotals();
    res.json(totals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MIGRAÇÃO SEGURA DO LOCALSTORAGE
// ==========================================

app.post('/api/migrate-localstorage', async (req, res) => {
  try {
    const result = await db.migrateFromLocalStorage(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// BACKUP E RESTAURAÇÃO
// ==========================================

app.get('/api/backup', async (req, res) => {
  try {
    const backupDbPath = await db.createDatabaseBackup('api_download');
    const expenses = await db.getAllExpenses();
    const aportes = await db.getAllAportes();
    const totals = await db.getFinancialTotals();

    const backupPayload = {
      exportedAt: new Date().toISOString(),
      database: 'PostgreSQL',
      databaseFileBackup: backupDbPath ? path.basename(backupDbPath) : null,
      totals,
      expenses,
      aportes
    };

    // Também salva cópia timestamped na pasta backups
    const jsonBackupFile = path.join(
      __dirname,
      'backups',
      `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(jsonBackupFile, JSON.stringify(backupPayload, null, 2), 'utf8');

    res.json(backupPayload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/restore', async (req, res) => {
  try {
    const result = await db.restoreData(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/reset', async (req, res) => {
  try {
    const result = await db.resetToSeed();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const totals = await db.getFinancialTotals();
    res.json({
      status: 'online',
      timestamp: new Date().toISOString(),
      database: 'PostgreSQL',
      totals
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      database: 'PostgreSQL',
      error: error.message
    });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota da API nao encontrada.' });
  res.status(404).send('Pagina nao encontrada.');
});

// Inicialização segura com conexão ao PostgreSQL
async function startServer() {
  try {
    console.log('[PostgreSQL] Conectando ao banco de dados...');
    await db.initDatabase();
    auth.ensureSetupToken();

    let initialPort = parseInt(process.env.PORT, 10) || 3000;

    function startListening(port) {
      const server = app.listen(port, '0.0.0.0', () => {
        console.log(`\n=======================================================`);
        console.log(`  ✅ SERVIDOR INICIADO E FUNCIONANDO COM SUCESSO!     `);
        console.log(`=======================================================`);
        console.log(`  Banco de Dados: PostgreSQL                          `);
        console.log(`  O sistema já está 100% pronto para uso!              `);
        console.log(`  Acesse agora no seu navegador:                      `);
        console.log(`                                                       `);
        console.log(`  👉  http://localhost:${port}                        `);
        console.log(`                                                       `);
        console.log(`  📌 IMPORTANTE:                                      `);
        console.log(`  Esta janela do terminal deve continuar ABERTA       `);
        console.log(`  enquanto você utiliza o site.                       `);
        console.log(`                                                       `);
        console.log(`  Para encerrar o servidor no futuro:                 `);
        console.log(`  Feche esta janela ou pressione Ctrl + C.            `);
        console.log(`=======================================================\n`);

        try {
          const { exec } = require('child_process');
          if (process.platform === 'win32') {
            exec(`start "" http://localhost:${port}/login`);
          } else if (process.platform === 'darwin') {
            exec(`open http://localhost:${port}/login`);
          } else {
            exec(`xdg-open http://localhost:${port}/login`);
          }
        } catch (e) {
          // Falha silenciosa se shell não disponível
        }
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          const nextPort = port + 1;
          if (nextPort <= initialPort + 10) {
            console.log(`[Aviso] A porta ${port} está bloqueada pelo Windows (${err.code}). Tentando automaticamente a porta ${nextPort}...`);
            startListening(nextPort);
          } else {
            console.error(`[Erro no Servidor]: Portas ${initialPort} a ${nextPort - 1} bloqueadas.`, err.message);
            process.exit(1);
          }
        } else {
          console.error(`[Erro no Servidor]:`, err);
          process.exit(1);
        }
      });
    }

    startListening(initialPort);
  } catch (error) {
    console.error(`\n=======================================================`);
    console.error(`  ❌ ERRO AO CONECTAR AO BANCO DE DADOS POSTGRESQL     `);
    console.error(`=======================================================`);
    
    const errorMsg = error.message || error.detail || error.code || String(error);
    console.error(`Detalhes do erro: ${errorMsg}`);
    if (error.code) console.error(`Código do erro: ${error.code}`);
    if (error.detail) console.error(`Informação adicional: ${error.detail}`);
    if (error.hint) console.error(`Dica do PostgreSQL: ${error.hint}`);

    console.error(`\nConfiguração lida do .env:`);
    if (process.env.DATABASE_URL) {
      const maskedUrl = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
      console.error(`- Modo: DATABASE_URL (${maskedUrl})`);
    } else {
      console.error(`- Host: ${process.env.PGHOST || 'localhost'}`);
      console.error(`- Porta: ${process.env.PGPORT || 5432}`);
      console.error(`- Banco: ${process.env.PGDATABASE || 'chales_barreirinhas'}`);
      console.error(`- Usuário: ${process.env.PGUSER || 'postgres'}`);
    }

    console.error(`\nComo resolver:`);
    if (error.code === 'ECONNREFUSED' || (error.message && error.message.includes('ECONNREFUSED'))) {
      console.error(`👉 O serviço do PostgreSQL NÃO está iniciado na porta 5432.`);
      console.error(`   Inicie o serviço do PostgreSQL (via Services/Serviços do Windows ou pgAdmin).`);
    } else if (error.code === '28P01' || (error.message && error.message.includes('password authentication'))) {
      console.error(`👉 Senha incorreta para o usuário "${process.env.PGUSER || 'postgres'}".`);
      console.error(`   Altere PGPASSWORD no arquivo .env com a senha correta definida na instalação do Postgres.`);
    } else if (error.code === '3D000' || (error.message && error.message.includes('does not exist'))) {
      console.error(`👉 O banco "${process.env.PGDATABASE || 'chales_barreirinhas'}" não existe.`);
      console.error(`   Abra o pgAdmin / psql e execute: CREATE DATABASE ${process.env.PGDATABASE || 'chales_barreirinhas'};`);
    } else {
      console.error(`1. Verifique se o PostgreSQL está instalado e rodando`);
      console.error(`2. Confira os dados de conexão no arquivo .env`);
      console.error(`3. Crie o banco se ainda não existir: CREATE DATABASE chales_barreirinhas;`);
    }
    console.error(`=======================================================\n`);
    process.exit(1);
  }
}

startServer();
