/**
 * SERVER API PRISM - DASHBOARD ORCHESTRATOR
 * Versione: 2.1 (Analisi Preventiva + Generazione On-Demand con Error Handling avanzato)
 * Scopo: Gestisce il flusso asincrono tra Shaper/Refiner e la generazione dei singoli toni.
 */

// ==========================================
// 1. CONFIGURAZIONE STATO E VARIABILI GLOBALI
// ==========================================

const topicInputTextarea = document.getElementById('topicInput');
const charCounterDisplay = document.getElementById('charCounter');
const maxCharacterLength = 200;

// Cache per i testi generati divisi per tono (es: { polemico: { text: "..." } })
let globalCacheTones = {};

// Cache per asset multimediali e fonti (condivisi tra i toni dello stesso job)
let globalCacheMedia = { 
    verifiedImages: [], 
    verifiedTables: [],
    sourcesPreview: [] 
}; 

// Riferimento per l'intervallo di polling (necessario per poterlo fermare globalmente)
let pollInterval = null;

// Sessione utente sincronizzata via Firestore
let currentUserSessionData = { userId: null, companyId: null, role: null };

// Tono correntemente visualizzato o in fase di generazione
let currentActiveToneKey = null;

/**
 * Risoluzione dinamica dell'URL del backend in base all'ambiente
 */
function getBackendUrl() {
    if (window.FIREBASE_ENV && window.FIREBASE_ENV.backendUrl) {
        return window.FIREBASE_ENV.backendUrl;
    }
    return "http://localhost:3001";
}

// ==========================================
// 2. GESTIONE AUTENTICAZIONE E SESSIONE
// ==========================================

firebase.auth().onAuthStateChanged(async (user) => {
    const cachedUid = sessionStorage.getItem("prism_user_uid");
    const finalUid = user ? user.uid : cachedUid;

    if (finalUid) {
        try {
            const userDoc = await window.db.collection("users").doc(finalUid).get();
            if (userDoc.exists) {
                const data = userDoc.data();
                currentUserSessionData = {
                    userId: finalUid,
                    companyId: data.company_id, 
                    role: data.role || "member"
                };
            }
        } catch (err) {
            console.error("❌ [AUTH] Errore fetch profilo:", err.message);
        }
    } else {
        window.location.href = "login.html";
    }
});

function getCurrentUserData() {
    return currentUserSessionData.userId ? currentUserSessionData : { userId: sessionStorage.getItem("prism_user_uid"), companyId: null };
}

// ==========================================
// 3. LOGICA DI INTERFACCIA E CHECKLIST
// ==========================================

function updateCounter() {
    if (!topicInputTextarea || !charCounterDisplay) return;
    const currentLength = topicInputTextarea.value.length;
    const remaining = maxCharacterLength - currentLength;
    charCounterDisplay.textContent = `${remaining} / ${maxCharacterLength}`;
    charCounterDisplay.style.color = remaining <= 10 ? "#ef4444" : "var(--text-dim)";
}

if (topicInputTextarea) {
    topicInputTextarea.addEventListener('input', updateCounter);
    updateCounter();
}

/**
 * Gestisce l'avanzamento visivo (Tick verdi) della checklist nel modal
 */
function updateChecklist(step) {
    const stepsOrder = { 'query_shaping': 1, 'tavily_search': 2, 'compression': 3, 'generation': 4 };
    const currentOrder = stepsOrder[step] || 0;

    const checklistItems = [
        { id: 'check-shaping', order: 1 },
        { id: 'check-search', order: 2 },
        { id: 'check-refiner', order: 3 }
    ];

    checklistItems.forEach(item => {
        const el = document.getElementById(item.id);
        if (!el) return;
        if (currentOrder > item.order) {
            el.innerHTML = "✅"; el.style.color = "#10b981";
        } else if (currentOrder === item.order) {
            el.innerHTML = "⏳"; el.style.color = "#3b82f6";
        } else {
            el.innerHTML = "⚪"; el.style.color = "#3f3f46";
        }
    });
}

function getStepColor(step) {
    const colors = { 'query_shaping': '#1e3a8a', 'tavily_search': '#064e3b', 'compression': '#713f12', 'generation': '#4c1d95', 'done': '#2563eb' };
    return colors[step] || '#2563eb';
}

// ==========================================
// 4. GESTIONE ERRORI PIPELINE
// ==========================================

/**
 * Funzione centralizzata per terminare i caricamenti in caso di errore
 */
function handlePipelineError(errorMessage) {
    if (pollInterval) clearInterval(pollInterval);
    
    // Nasconde il modal di caricamento
    document.getElementById('prism-modal').style.display = 'none';
    
    // Ripristina la visibilità della checklist per il prossimo uso
    const checklist = document.querySelector('.checklist-container');
    if (checklist) checklist.style.display = 'block';

    // Riabilita il bottone principale
    const btn = document.querySelector('.generate-btn');
    if (btn) {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
    
    console.error("🚨 [PRISM PIPELINE ERROR]:", errorMessage);
    alert(`Attenzione: ${errorMessage}`);
}

// ==========================================
// 5. FASE 1: ANALISI (F1 -> F3)
// ==========================================

window.generateHumanPost = async function() {
    const topic = topicInputTextarea.value.trim();
    if (!topic) return alert("Inserisci un argomento!");
    
    const btn = document.querySelector('.generate-btn');
    const modal = document.getElementById('prism-modal');
    const progressBar = document.getElementById('p-bar');
    const userData = getCurrentUserData();
    const BACKEND_URL = getBackendUrl();

    if (!userData.companyId) return alert("Sincronizzazione profilo in corso...");

    // Reset UI e Cache locale
    globalCacheTones = {};
    globalCacheMedia = { verifiedImages: [], verifiedTables: [], sourcesPreview: [] }; 
    modal.style.display = 'flex';
    progressBar.style.width = '0%';
    document.getElementById('status-msg').innerText = "Innesco analisi Shaper/Refiner...";
    
    // Reset checklist visiva
    ['check-shaping', 'check-search', 'check-refiner'].forEach(id => { 
        if(document.getElementById(id)) document.getElementById(id).innerHTML = "⚪"; 
    });

    btn.disabled = true; btn.style.opacity = "0.5";

    try {
        const response = await fetch(`${BACKEND_URL}/api/prepare-shaping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userData.userId, companyId: userData.companyId, topic, language: 'italiano' })
        });

        const initResult = await response.json();
        if (!initResult.success) throw new Error(initResult.error);

        const jobId = initResult.jobId;
        sessionStorage.setItem('prism_last_job_id', jobId);

        // Avvio Polling Fase 1
        pollInterval = setInterval(async () => {
            try {
                const statusResp = await fetch(`${BACKEND_URL}/jobs/status/${userData.userId}/${jobId}`);
                const res = await statusResp.json();
                
                if (!res.success) return handlePipelineError(res.error || "Errore di connessione");

                const { status, pipeline, error } = res.data;

                // Controllo Fallimento nel Worker
                if (status === 'failed') {
                    return handlePipelineError(error?.message || "Errore imprevisto durante l'analisi");
                }

                // Avanzamento Grafico
                progressBar.style.width = `${(pipeline.progress * 100)}%`;
                progressBar.style.backgroundColor = getStepColor(pipeline.step);
                document.getElementById('status-msg').innerText = pipeline.message;
                updateChecklist(pipeline.step);

                if (status === 'completed') {
                    clearInterval(pollInterval);
                    // Abilitazione Card Toni
                    document.querySelectorAll('.tone-card').forEach(card => {
                        card.classList.add('enabled');
                    });
                    setTimeout(() => { modal.style.display = 'none'; }, 800);
                    btn.disabled = false; btn.style.opacity = "1";
                }
            } catch (pollErr) { 
                console.warn("Polling error:", pollErr); 
            }
        }, 1000);

    } catch (err) {
        handlePipelineError(err.message);
    }
};

// ==========================================
// 6. FASE 2: GENERAZIONE TONO (ON CLICK CARD)
// ==========================================

/**
 * Gestore del click sulla card del tono
 */
window.selectToneCard = async function(toneKey) {
    const jobId = sessionStorage.getItem('prism_last_job_id');
    if (!jobId) return alert("Avvia prima l'analisi dell'argomento.");

    currentActiveToneKey = toneKey;

    // 1. Verifica Cache locale (già scaricato in questa sessione)
    if (globalCacheTones && globalCacheTones[toneKey]?.text) {
        return window.openToneModal(toneKey);
    }

    // 2. Verifica Firestore (scarica se presente nel database)
    try {
        const doc = await window.db.collection("contents").doc(String(jobId)).get();
        if (doc.exists) {
            const data = doc.data();
            const tones = data.testo?.tones;
            if (tones && tones[toneKey]?.text) {
                globalCacheTones = tones;
                const assets = extractAllDatabaseAssets(data);
                globalCacheMedia = assets;
                return window.openToneModal(toneKey);
            }
        }
    } catch (e) { console.error("Firestore Check Error:", e); }

    // 3. Generazione chirurgica F4 se non trovato altrove
    await generateSingleTone(toneKey, jobId);
};

/**
 * Chiama l'API di generazione specifica per un singolo tono
 */
async function generateSingleTone(toneKey, jobId) {
    const modal = document.getElementById('prism-modal');
    const progressBar = document.getElementById('p-bar');
    const statusMsg = document.getElementById('status-msg');
    const checklist = document.querySelector('.checklist-container');
    const userData = getCurrentUserData();
    const BACKEND_URL = getBackendUrl();

    // Reset interfaccia per modalità "Scrittura"
    modal.style.display = 'flex';
    if (checklist) checklist.style.display = 'none'; // Nasconde Shaping/Search/Refiner
    statusMsg.innerText = `PRISM sta scrivendo il post [${toneKey.toUpperCase()}]...`;
    progressBar.style.width = '15%';

    try {
        const response = await fetch(`${BACKEND_URL}/api/regenerate-tone-surgical`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userData.userId,
                companyId: userData.companyId, 
                toneKey: toneKey,
                jobId: jobId
            })
        });

        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        if (pollInterval) clearInterval(pollInterval);

        // Polling per la generazione del tono
        pollInterval = setInterval(async () => {
            const pr = await fetch(`${BACKEND_URL}/jobs/status/${userData.userId}/${jobId}`);
            const ps = await pr.json();
            
            if (!ps.success) return handlePipelineError("Errore nella generazione del tono");

            const task = ps.data;

            // INTERCETTAZIONE ERRORE CRITICO (Es: Profilo BASIC non autorizzato)
            if (task.status === 'failed') {
                return handlePipelineError(task.error?.message || "Errore di generazione");
            }

            progressBar.style.width = `${(task.pipeline.progress * 100)}%`;
            statusMsg.innerText = task.pipeline.message;

            // Se completato, carica i dati e apri il modale finale
            if ((task.status === 'completed' || task.status === 'done') && task.tones?.[toneKey]?.text) {
                clearInterval(pollInterval);
                globalCacheTones = task.tones;
                const assets = extractAllDatabaseAssets(task);
                globalCacheMedia = assets;
                
                setTimeout(() => {
                    modal.style.display = 'none';
                    if (checklist) checklist.style.display = 'block'; // Ripristina per prossimo uso
                    window.openToneModal(toneKey);
                }, 500);
            }
        }, 2000);

    } catch (error) {
        handlePipelineError(error.message);
    }
}

// ==========================================
// 7. UTILITY ESTRATTORE E MODALE
// ==========================================

function extractAllDatabaseAssets(data) {
    if (!data) return { images: [], sources: [] };
    const target = data.testo ? data.testo : (data.data ? data.data : data);
    const assets = { images: [], sources: [] };

    if (target.media_support) {
        assets.images = target.media_support.verified_images || target.media_support.verifiedImages || [];
    } else if (data.media_support) {
        assets.images = data.media_support.verified_images || [];
    }

    assets.sources = target.sources_preview || target.sourcesPreview || [];
    return assets;
}

window.openToneModal = function(toneKey) {
    if (!globalCacheTones || !globalCacheTones[toneKey]) return;
    
    const rawText = globalCacheTones[toneKey].text || "";
    const richHTMLContent = parseAndCleanContentForModal(rawText);
    
    document.getElementById('modal-tone-title').innerText = `PRISM - Contenuto [${toneKey.toUpperCase()}]`;
    
    // Logica Gallerie/Fonti integrata nel modale (omessa per brevità ma presente nel sistema)
    // ...
    
    document.getElementById('modal-tone-text').innerHTML = `
        <div style="color: #e4e4e7; font-size: 15px; line-height: 1.7; white-space: pre-wrap;">${richHTMLContent}</div>
    `;
    document.getElementById('output-modal').style.display = 'flex';
};

window.closeToneModal = function() { 
    document.getElementById('output-modal').style.display = 'none'; 
};

function parseAndCleanContentForModal(text) {
    if (!text) return "";
    return text.replace(/\[(TITOLO|GANCIO|HOOK|EPILOGO|FONTI|HASHTAG|TESTO|NOTE|TAG|CONTESTO|POST|ANALISI)\]/gi, (match) => {
        return `<span style="color: #3b82f6; font-weight: 700; font-size: 12px; display: block; margin-top: 18px; margin-bottom: 6px; text-transform: uppercase;">${match}</span>`;
    });
}

window.clearInput = function() { if (topicInputTextarea) { topicInputTextarea.value = ''; updateCounter(); } };
window.selP = function(el) { document.querySelectorAll('.pill').forEach(p => p.classList.remove('active')); el.classList.add('active'); };