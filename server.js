// Silencia avisos experimentais do SQLite no console para saída limpa
const _origEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && typeof data === 'object' && data.name === 'ExperimentalWarning' && data.message && data.message.includes('SQLite')) {
    return false;
  }
  return _origEmit.apply(process, [name, data, ...args]);
};

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Inicializa o banco SQLite com segurança
db.initDatabase();
auth.ensureSetupToken();

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

app.get('/api/expenses', (req, res) => {
  try {
    const expenses = db.getAllExpenses();
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/expenses/:id', (req, res) => {
  try {
    const item = db.getExpenseById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Lançamento não encontrado' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/expenses', (req, res) => {
  try {
    const created = db.createExpense(req.body);
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/expenses/:id', (req, res) => {
  try {
    const updated = db.updateExpense(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Lançamento não encontrado' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/expenses/:id', (req, res) => {
  try {
    const success = db.deleteExpense(req.params.id);
    if (!success) return res.status(404).json({ error: 'Lançamento não encontrado' });
    res.json({ success: true, message: 'Lançamento excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ROTAS DA API: APORTES
// ==========================================

app.get('/api/aportes', (req, res) => {
  try {
    const aportes = db.getAllAportes();
    res.json(aportes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/aportes/:id', (req, res) => {
  try {
    const item = db.getAporteById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/aportes', (req, res) => {
  try {
    const created = db.createAporte(req.body);
    res.status(201).json(created);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/aportes/:id', (req, res) => {
  try {
    const updated = db.updateAporte(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/aportes/:id', (req, res) => {
  try {
    const success = db.deleteAporte(req.params.id);
    if (!success) return res.status(404).json({ error: 'Aporte não encontrado' });
    res.json({ success: true, message: 'Aporte excluído com sucesso' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// TOTAIS E INDICADORES FINANCEIROS
// ==========================================

app.get('/api/totals', (req, res) => {
  try {
    const totals = db.getFinancialTotals();
    res.json(totals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// MIGRAÇÃO SEGURA DO LOCALSTORAGE
// ==========================================

app.post('/api/migrate-localstorage', (req, res) => {
  try {
    const result = db.migrateFromLocalStorage(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// BACKUP E RESTAURAÇÃO
// ==========================================

app.get('/api/backup', (req, res) => {
  try {
    const backupDbPath = db.createDatabaseBackup('api_download');
    const expenses = db.getAllExpenses();
    const aportes = db.getAllAportes();
    const totals = db.getFinancialTotals();

    const backupPayload = {
      exportedAt: new Date().toISOString(),
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

app.post('/api/restore', (req, res) => {
  try {
    const result = db.restoreData(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/reset', (req, res) => {
  try {
    const result = db.resetToSeed();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    database: 'SQLite',
    totals: db.getFinancialTotals()
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota da API nao encontrada.' });
  res.status(404).send('Pagina nao encontrada.');
});

// Inicia o servidor
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=======================================================`);
  console.log(`  ✅ SERVIDOR INICIADO E FUNCIONANDO COM SUCESSO!     `);
  console.log(`=======================================================`);
  console.log(`  O sistema já está 100% pronto para uso!              `);
  console.log(`  Acesse agora no seu navegador:                      `);
  console.log(`                                                       `);
  console.log(`  👉  http://localhost:${PORT}                        `);
  console.log(`                                                       `);
  console.log(`  📌 IMPORTANTE:                                      `);
  console.log(`  Esta tela NÃO vai mudar nem fechar sozinha.         `);
  console.log(`  Esta janela do terminal deve continuar ABERTA       `);
  console.log(`  enquanto você utiliza o site, pois é ela que mantém `);
  console.log(`  o servidor e o banco SQLite ativos.                  `);
  console.log(`                                                       `);
  console.log(`  Para encerrar o servidor no futuro:                 `);
  console.log(`  Feche esta janela ou pressione Ctrl + C.            `);
  console.log(`=======================================================\n`);

  // Abre o navegador automaticamente somente após a porta 3000 estar 100% ativa e pronta
  try {
    const { exec } = require('child_process');
    if (process.platform === 'win32') {
      exec(`start "" http://localhost:${PORT}/login`);
    } else if (process.platform === 'darwin') {
      exec(`open http://localhost:${PORT}/login`);
    } else {
      exec(`xdg-open http://localhost:${PORT}/login`);
    }
  } catch (e) {
    // Falha silenciosa caso o ambiente não suporte execução de shell
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[Aviso] A porta ${PORT} já está em uso por outro processo.`);
    console.log(`O servidor já está ativo e respondendo em: http://localhost:${PORT}`);
    try {
      const { exec } = require('child_process');
      if (process.platform === 'win32') {
        exec(`start "" http://localhost:${PORT}/login`);
      } else if (process.platform === 'darwin') {
        exec(`open http://localhost:${PORT}/login`);
      } else {
        exec(`xdg-open http://localhost:${PORT}/login`);
      }
    } catch (e) {
      // O servidor existente continua acessivel pelo endereco impresso acima.
    }
    process.exit(0);
  } else {
    console.error(`[Erro no Servidor]:`, err);
    process.exit(1);
  }
});
