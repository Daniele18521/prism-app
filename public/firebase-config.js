/**
 * PRISM - Configurazione Ambientale Dinamica Intercettata
 * Questo file viene caricato dal browser sia nella pagina di Login che in Dashboard.
 * Sceglie autonomamente le chiavi di Firebase, l'URL del Backend e inizializza Firestore.
 */

function initFirebaseConfig(currentEnv) {
    
    // 💻 CONFIGURAZIONE: SVILUPPO & TEST
    const configDev = {
        apiKey: "AIzaSyBT1qFk4QLttZcKRP42KCAjSXCR-gF5vnc",
        authDomain: "prism-test-e04b1.firebaseapp.com",
        projectId: "prism-test-e04b1",
        storageBucket: "prism-test-e04b1.firebasestorage.app",
        messagingSenderId: "987209405034",
        appId: "1:987209405034:web:b2efeddea5ce841cec7013",
        // 🟢 AGGIUNTO: URL del backend locale per lo sviluppo
        backendUrl: "http://localhost:3001" 
    };

    // 🚀 CONFIGURAZIONE: PRODUZIONE
    const configProd = {
        apiKey: "AIzaSyDLVgzB3w_K5XWeh9UUu4zMcZ1kF3ZLlLE",
        authDomain: "prism-production-9fc2d.firebaseapp.com",
        projectId: "prism-production-9fc2d",
        storageBucket: "prism-production-9fc2d.firebasestorage.app",
        messagingSenderId: "91708503866",
        appId: "1:91708503866:web:ed6f75d48390aa67d58203",
        measurementId: "G-BDBR0P714S"
    };

    // 🟢 FALLBACK INTELLIGENTE: Se currentEnv non viene passato o è invalido, lo rileva dall'URL
    let env = currentEnv;
    if (!env || typeof env !== 'string') {
        const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        env = isLocal ? 'development' : 'production';
    }

    // 🎯 ASSEGNAZIONE DELL'AMBIENTE RILEVATO
    if (env === 'production') {
        window.FIREBASE_ENV = configProd;
    } else {
        window.FIREBASE_ENV = configDev;
    }

    // 🟢 ESPONIAMO IL BACKEND URL GLOBALMENTE PER I FETCH (Risolve l'avviso di dashboard.js)
    window.BACKEND_URL = window.FIREBASE_ENV.backendUrl;

    // 🔥 INIZIALIZZAZIONE ATOMICA DI FIREBASE & FIRESTORE
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(window.FIREBASE_ENV);
        }
        
        // Assegnazione globale standard (sia window.db che assegna a firebase.firestore)
        window.db = firebase.firestore();
        
    } catch (initError) {
        console.error("❌ [PRISM] Errore critico durante l'inizializzazione dei servizi Firebase Client:", initError.message);
    }

    // Un log chiaro in console per rassicurarti che tutto stia puntando nel posto giusto
    console.log(
        `🌍 [PRISM] Ambiente applicato: %c${env.toUpperCase()}`, 
        "color: #2563eb; font-weight: bold;"
    );
    console.log(`🔗 [PRISM] URL Backend Core associato: ${window.BACKEND_URL}`);
    console.log(`🔥 [PRISM] Cloud Firestore inizializzato con successo.`);
}

// 🟢 AUTORUN DI SICUREZZA: Esegue l'inizializzazione al caricamento del file se non è ancora partita
if (!window.FIREBASE_ENV) {
    initFirebaseConfig();
}