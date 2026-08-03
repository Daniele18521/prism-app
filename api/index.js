import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carica SEMPRE il .env dalla root del progetto (non dipende dalla cwd del processo)
const ENV_FILE_PATH = path.join(__dirname, '../.env');
dotenv.config({ path: ENV_FILE_PATH });

const app = express();

app.use(cors());
app.use(express.json());

// 1. File statici (CSS, Immagini, Config Firebase)
app.use(express.static(path.join(__dirname, '../public')));

// Configurazione EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

/**
 * Feature flag mock frontend (blueprint PRISM).
 * Variabile .env: PRISM_USE_MOCK=true|1|yes
 * Equivalente documentato rispetto a VITE_PRISM_USE_MOCK (stack non-Vite).
 * Rilegge il file .env a ogni chiamata così un cambio flag non richiede necessariamente
 * di ricordarsi che process.env resta congelato al boot (meglio comunque riavviare).
 */
function getPrismUseMockFlag() {
  // prova a rileggere il file .env dal disco
  try {
    const text = fs.readFileSync(ENV_FILE_PATH, 'utf8');
    const match = text.match(/^\s*PRISM_USE_MOCK\s*=\s*(.*)$/m);
    if (match) {
      let value = String(match[1] || '').trim();
      // rimuove eventuali virgolette
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).trim();
      }
      // aggiorna anche process.env per coerenza runtime
      process.env.PRISM_USE_MOCK = value;
      if (value !== '') return value;
    }
  } catch (_) {
    // se il file non è leggibile, fallback sotto
  }
  // fallback: process.env già caricato da dotenv
  const raw = process.env.PRISM_USE_MOCK;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'false';
  return String(raw).trim();
}

/**
 * 🚀 2. Rotta Principale: LANDING PAGE
 * Questo è il punto d'ingresso pubblico del mondo PRISM.
 */
app.get('/', (req, res) => {
  res.render('landing', {
    env: process.env.NODE_ENV || 'development'
  });
});

/**
 * 🔐 3. Rotta di Login
 * Accessibile per te e per chi ha l'invito.
 */
app.get('/login', (req, res) => {
  res.render('login', {
    env: process.env.NODE_ENV || 'development'
  });
});

app.get('/archive', (req, res) => {
  res.render('archive', { env: process.env.NODE_ENV || 'development' });
});

/**
 * 🛠️ 4. Rotta Dashboard
 * Il "laboratorio" di PRISM.
 * Inietta prismUseMock da .env → window.PRISM_USE_MOCK (solo lettura flag, zero side-effect se false).
 */
app.get('/dashboard', (req, res) => {
  res.render('dashboard', {
    env: process.env.NODE_ENV || 'development',
    prismUseMock: getPrismUseMockFlag()
  });
});

app.get('/admin', (req, res) => {
  res.render('admin_page', { env: process.env.NODE_ENV || 'development' });
});

/**
 * Endpoint JS live del flag mock (no-cache).
 * Caricato dalla dashboard PRIMA di prism-mock-layer.js così il FE
 * riceve sempre il valore aggiornato da .env anche se l'HTML era in cache.
 */
app.get('/prism-mock-flag.js', (req, res) => {
  const flag = getPrismUseMockFlag();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(
    `window.PRISM_USE_MOCK=${JSON.stringify(flag)};` +
    `console.log("[PRISM MOCK] flag da server =", ${JSON.stringify(flag)});`
  );
});

// Avvio del Server Frontend
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const currentEnv = process.env.NODE_ENV || 'development';
  const mockFlag = getPrismUseMockFlag();
  console.log(`
  ██████╗ ██████╗ ██╗███████╗███╗   ███╗
  ██╔══██╗██╔══██╗██║██╔════╝████╗ ████║
  ██████╔╝██████╔╝██║███████╗██╔████╔██║
  ██╔═══╝ ██╔══██╗██║╚════██║██║╚██╔╝██║
  ██║     ██║  ██║██║███████║██║ ╚═╝ ██║
  ╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝
  
  📡 Porta: ${PORT}
  🌍 Ambiente: ${currentEnv.toUpperCase()}
  🧪 PRISM_USE_MOCK: ${mockFlag}
  🔗 URL Pubblico: http://localhost:${PORT}/
  `);
});
