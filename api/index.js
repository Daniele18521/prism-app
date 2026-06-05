import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import 'dotenv/config'; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

// 1. File statici (CSS, Immagini, Config Firebase)
app.use(express.static(path.join(__dirname, '../public')));

// Configurazione EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

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

/**
 * 🛠️ 4. Rotta Dashboard
 * Il "laboratorio" di PRISM.
 */
app.get('/dashboard', (req, res) => {
  res.render('dashboard', { 
    env: process.env.NODE_ENV || 'development' 
  });
});

// Avvio del Server Frontend
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const currentEnv = process.env.NODE_ENV || 'development';
  console.log(`
  ██████╗ ██████╗ ██╗███████╗███╗   ███╗
  ██╔══██╗██╔══██╗██║██╔════╝████╗ ████║
  ██████╔╝██████╔╝██║███████╗██╔████╔██║
  ██╔═══╝ ██╔══██╗██║╚════██║██║╚██╔╝██║
  ██║     ██║  ██║██║███████║██║ ╚═╝ ██║
  ╚═╝     ╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝
  
  📡 Porta: ${PORT}
  🌍 Ambiente: ${currentEnv.toUpperCase()}
  🔗 URL Pubblico: http://localhost:${PORT}/
  `);
});