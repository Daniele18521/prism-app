/**
 * SERVER API PRISM - DASHBOARD ORCHESTRATOR
 * Versione: 3.4 (Workspace Integration & Global Error Logging)
 * Scopo: Gestisce il flusso asincrono usando gli slug semantici di Firestore, aggiorna i crediti in real-time e gestisce gli strumenti del Workspace.
 */

// ==========================================
// 0. GLOBAL ERROR LOGGING (PRODUZIONE)
// ==========================================

(function initGlobalErrorLogging() {
    const errorBanner = document.getElementById('global-error-notification');
    let catastrophicShown = false;

    function logError(context, detail) {
        console.error(`[PRISM ${context}]`, detail);
    }

    function showCatastrophicNotification(message) {
        if (!errorBanner || catastrophicShown) return;
        catastrophicShown = true;
        errorBanner.textContent = message || 'Si è verificato un errore critico. Ricarica la pagina o riprova.';
        errorBanner.style.display = 'block';
    }

    window.onerror = function(message, source, lineno, colno, error) {
        logError('RUNTIME', { message, source, lineno, colno, stack: error?.stack });
        showCatastrophicNotification('Errore di runtime rilevato. L\'applicazione potrebbe non funzionare correttamente.');
        return false;
    };

    window.addEventListener('unhandledrejection', function(event) {
        const reason = event.reason;
        logError('UNHANDLED_REJECTION', reason instanceof Error ? reason.message : reason);
        showCatastrophicNotification('Errore asincrono non gestito. Controlla la connessione e riprova.');
    });

    window.addEventListener('offline', function() {
        logError('OFFLINE', 'Client offline');
        showCatastrophicNotification('Connessione persa. Verifica la rete e riprova.');
    });

    window.addEventListener('online', function() {
        if (errorBanner && catastrophicShown) {
            errorBanner.style.display = 'none';
            catastrophicShown = false;
        }
    });

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function(...args) {
        try {
            const response = await nativeFetch(...args);
            if (!response.ok) {
                logError('FETCH', { url: args[0], status: response.status, statusText: response.statusText });
            }
            return response;
        } catch (err) {
            logError('FETCH', { url: args[0], error: err.message });
            throw err;
        }
    };
})();

// ==========================================
// 1. CONFIGURAZIONE STATO E VARIABILI GLOBALI
// ==========================================

const topicInputTextarea = document.getElementById('topicInput');
const charCounterDisplay = document.getElementById('charCounter');
const btnGenerate = document.querySelector('.generate-btn');
const btnReset = document.querySelector('.reset-btn');
const settingsRow = document.querySelector('.settings-row');
const maxCharacterLength = 2000;
const MIN_WORDS_FOR_ANALYZE = 5;
const CHAR_COUNTER_WARN_THRESHOLD = 100;
let inputUnlockedByPaste = false;

function countInputWords(text) {
    const trimmed = (text || '').trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

function isTopicReadyForAnalyze(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || analysisCompleted) return false;
    if (inputUnlockedByPaste) return true;
    return countInputWords(text) >= MIN_WORDS_FOR_ANALYZE;
}

function updateTopicCharCounter() {
    if (!charCounterDisplay) return;
    const currentLength = topicInputTextarea ? topicInputTextarea.value.length : 0;
    const remaining = Math.max(0, maxCharacterLength - currentLength);
    charCounterDisplay.textContent = `${remaining} / ${maxCharacterLength}`;
    charCounterDisplay.style.color = remaining <= CHAR_COUNTER_WARN_THRESHOLD ? '#ef4444' : 'var(--text-dim)';
}

function enforceTopicMaxLength(preferredInsertLength) {
    if (!topicInputTextarea) return { truncated: false, value: '' };

    if (typeof preferredInsertLength === 'number' && preferredInsertLength > maxCharacterLength) {
        return { truncated: true, value: topicInputTextarea.value.slice(0, maxCharacterLength) };
    }

    if (topicInputTextarea.value.length > maxCharacterLength) {
        return { truncated: true, value: topicInputTextarea.value.slice(0, maxCharacterLength) };
    }

    return { truncated: false, value: topicInputTextarea.value };
}

function handleTopicPaste(event) {
    if (!topicInputTextarea || analysisCompleted) return;

    const pastedText = event.clipboardData?.getData('text') || '';
    if (!pastedText) return;

    const selectionStart = topicInputTextarea.selectionStart ?? topicInputTextarea.value.length;
    const selectionEnd = topicInputTextarea.selectionEnd ?? topicInputTextarea.value.length;
    const currentValue = topicInputTextarea.value;
    const nextValue = currentValue.slice(0, selectionStart) + pastedText + currentValue.slice(selectionEnd);

    if (nextValue.length > maxCharacterLength) {
        event.preventDefault();
        const allowedLength = maxCharacterLength - (currentValue.length - (selectionEnd - selectionStart));
        const truncatedPaste = allowedLength > 0 ? pastedText.slice(0, allowedLength) : '';
        topicInputTextarea.value = currentValue.slice(0, selectionStart) + truncatedPaste + currentValue.slice(selectionEnd);
        inputUnlockedByPaste = truncatedPaste.trim().length > 0;
        updateTopicCharCounter();
        handleInputTrigger({ fromPaste: true });
        showPrismErrorSafe(
            `Il testo incollato superava il limite di ${maxCharacterLength} caratteri ed è stato troncato.`,
            { title: 'Limite caratteri' }
        );
        return;
    }

    inputUnlockedByPaste = pastedText.trim().length > 0;
}

let globalCacheTones = {}; // idratazione UI post-Firestore (non usata come sorgente dati)
let globalCacheMedia = { verifiedImages: [], verifiedTables: [], sourcesPreview: [] }; 
let pollInterval = null;
let tonePollInterval = null;
let companyUnsubscribe = null; // Memorizza la funzione di rimozione dell'ascolto real-time di Firestore
let jobToneUnsubscribe = null; // Ascolto real-time toni job su Firestore
let activeTypewriterTimeout = null; // Memorizza il timeout attivo per l'effetto macchina da scrivere

let currentUserSessionData = { 
    userId: null, 
    companyId: null, 
    role: null,
    companyDetails: null 
};

let currentActiveToneKey = null;
let analysisCompleted = false;
let hasDeductedCreditForJob = false;
let toneGenHasSeenGenerating = false;
let toneGenRevealStarted = false;
let dashboardPlatformLocked = false;
let dashboardLanguageLocked = false;
let globalToneAvailability = {};
let activeJobToneSyncId = null;
let initialJobToneRestoreDone = false;
let userGuideActive = false;
let userGuideCurrentPhase = 0;
let userGuideAwaitingPhase5 = false;
let userGuideHighlightedEl = null;
let userGuideTextareaEl = null;
let userGuideInteractiveEls = [];
let modalToneSwitcherBusy = false;
let sessionGeneratedToneFlags = {};
let modalToneGenerationRefreshPromise = null;

function getBackendUrl() {
    if (window.FIREBASE_ENV && window.FIREBASE_ENV.backendUrl) {
        return window.FIREBASE_ENV.backendUrl;
    }
    return "http://localhost:3001";
}

// ==========================================
// 2. GESTIONE AUTENTICAZIONE E SYNC FIRESTORE
// ==========================================

firebase.auth().onAuthStateChanged(async (user) => {
    const cachedUid = sessionStorage.getItem("prism_user_uid");
    const finalUid = user ? user.uid : cachedUid;

    if (finalUid) {
        try {
            const userDoc = await window.db.collection("users").doc(finalUid).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                const companyId = userData.companyId;
                userGuideActive = userData.user_guide === true;

                if (userData.user_profile === 'admin') {
                    const adminLink = document.getElementById('adminNavLink');
                    if (adminLink) adminLink.style.display = '';
                }

                // Scollega eventuali listener attivi precedentemente
                if (companyUnsubscribe) {
                    companyUnsubscribe();
                }

                // Sottoscrizione in tempo reale al documento dell'azienda associata
                companyUnsubscribe = window.db.collection("companies").doc(companyId).onSnapshot((companyDoc) => {
                    if (companyDoc.exists) {
                        const companyData = companyDoc.data();
                        
                        currentUserSessionData = {
                            userId: finalUid,
                            companyId: companyId, 
                            role: userData.role || "member",
                            companyDetails: companyData
                        };

                        console.log("✅ PRISM Auth: Sincronizzazione slug per", companyData.name);
                        
                        // Applica restrizioni basate sugli slug nell'array enabled_tones
                        applyPlanHardLocks(companyData.enabled_tones || []);

                        // Recupero e aggiornamento dei contatori dei crediti nel footer
                        const generationsLeft = companyData.generations_left;
                        const regenerationsLeft = companyData.regenerations_left;
                        updateCreditsUI(generationsLeft, regenerationsLeft);

                        if (!initialJobToneRestoreDone) {
                            initialJobToneRestoreDone = true;
                            restoreActiveJobToneState();
                        }
                    }
                }, (error) => {
                    console.error("❌ [CREDITS] Errore sincronizzazione real-time azienda:", error.message);
                });

                if (userGuideActive) {
                    setTimeout(() => initUserGuide(), 700);
                }

            }
        } catch (err) {
            console.error("❌ [AUTH] Errore sincronizzazione:", err.message);
        }
    } else {
        window.location.href = "login.html";
    }
});

/**
 * Aggiorna gli elementi UI dei crediti rimanenti applicando il colore rosso di alert sotto le soglie critiche.
 * Soglie: <= 5 per le generazioni, <= 10 per le rigenerazioni.
 */
function updateCreditsUI(generationsLeft, regenerationsLeft) {
    const genBox = document.getElementById("credits-generations");
    const regenBox = document.getElementById("credits-regenerations");

    if (genBox) {
        const val = (generationsLeft !== undefined && generationsLeft !== null) ? generationsLeft : 0;
        genBox.innerText = val;

        // Se il contatore arriva a 5 o meno generazioni, diventa rosso
        if (val <= 5) {
            genBox.classList.add("low-credits");
        } else {
            genBox.classList.remove("low-credits");
        }
    }

    if (regenBox) {
        const val = (regenerationsLeft !== undefined && regenerationsLeft !== null) ? regenerationsLeft : 0;
        regenBox.innerText = val;

        // Se il contatore arriva a 10 o meno rigenerazioni, diventa rosso
        if (val <= 10) {
            regenBox.classList.add("low-credits");
        } else {
            regenBox.classList.remove("low-credits");
        }
    }
}

/**
 * Scala di 1 il campo companies/{companyId}.generations_left (solo analisi completata con successo).
 * L'onSnapshot sul documento company aggiorna anche l'UI; qui si forza un refresh immediato post-transazione.
 */
async function deductGenerationCredit(companyId) {
    if (!companyId || !window.db) {
        console.error("❌ [CREDITS] companyId o Firestore non disponibili");
        return false;
    }

    try {
        const companyRef = window.db.collection("companies").doc(companyId);
        let newGenerationsLeft = null;

        await window.db.runTransaction(async (transaction) => {
            const companyDoc = await transaction.get(companyRef);
            if (!companyDoc.exists) throw new Error("Documento azienda non trovato");

            const current = companyDoc.data().generations_left;
            if (current === undefined || current === null || current <= 0) {
                throw new Error("Crediti generazioni esauriti");
            }

            newGenerationsLeft = current - 1;

            transaction.update(companyRef, {
                generations_left: newGenerationsLeft,
                updated_at: firebase.firestore.FieldValue.serverTimestamp()
            });
        });

        if (currentUserSessionData.companyId === companyId && currentUserSessionData.companyDetails) {
            currentUserSessionData.companyDetails.generations_left = newGenerationsLeft;
        }
        updateCreditsUI(newGenerationsLeft, currentUserSessionData.companyDetails?.regenerations_left);

        console.log("✅ [CREDITS] companies/" + companyId + " → generations_left:", newGenerationsLeft);
        return true;
    } catch (err) {
        console.error("❌ [CREDITS] Errore scalatura generations_left:", err.message);
        return false;
    }
}

/**
 * Gestisce i lucchetti confrontando lo slug della card con enabled_tones
 */
function applyPlanHardLocks(enabledSlugs) {
    document.querySelectorAll('.tone-card').forEach(card => {
        const slug = card.getAttribute('data-key'); // slug esatto (es. 'provocatore')
        
        if (card && !enabledSlugs.includes(slug)) {
            card.classList.add('locked-by-plan');
            card.onclick = null; 
            if (!card.querySelector('.lock-badge')) {
                const lock = document.createElement('i');
                lock.className = 'fas fa-lock lock-badge';
                card.appendChild(lock);
            }
        }
    });
}

function getCurrentUserData() {
    return currentUserSessionData.userId ? currentUserSessionData : { userId: sessionStorage.getItem("prism_user_uid"), companyId: null };
}

// ==========================================
// 3. LOGICA DI INTERFACCIA E TRIGGER
// ==========================================

function handleInputTrigger(options = {}) {
    if (!topicInputTextarea) return;

    const enforced = enforceTopicMaxLength();
    if (enforced.truncated) {
        topicInputTextarea.value = enforced.value;
        showPrismErrorSafe(
            `Hai raggiunto il limite massimo di ${maxCharacterLength} caratteri.`,
            { title: 'Limite caratteri' }
        );
    }

    const text = topicInputTextarea.value;
    const trimmed = text.trim();

    if (options.fromPaste || (options.inputType && options.inputType.includes('Paste'))) {
        if (trimmed.length > 0) inputUnlockedByPaste = true;
    } else if (options.inputType && options.inputType.startsWith('delete')) {
        if (!trimmed) inputUnlockedByPaste = false;
    } else if (options.inputType && !options.inputType.includes('Paste')) {
        inputUnlockedByPaste = false;
    }

    updateTopicCharCounter();

    const canGenerate = isTopicReadyForAnalyze(text);

    btnGenerate.disabled = !canGenerate;
    btnGenerate.style.opacity = canGenerate ? '1' : '0.3';

    const canReset = trimmed.length > 0;
    btnReset.disabled = !canReset;
    btnReset.style.opacity = canReset ? '1' : '0.3';

    if (userGuideActive && userGuideCurrentPhase === 1 && isTopicReadyForAnalyze(text)) {
        showUserGuidePhase(2);
    }
}

if (topicInputTextarea) {
    topicInputTextarea.addEventListener('input', (event) => {
        handleInputTrigger({ inputType: event.inputType || '' });
    });
    topicInputTextarea.addEventListener('paste', handleTopicPaste);
    handleInputTrigger();
}

/**
 * FUNZIONE PULISCI (Reset Profondo)
 * Azione: Pulisce testo, cache, JobID e blocca la UI.
 */
window.fullReset = function() {
    if (topicInputTextarea) {
        // 1. Pulisce l'area di testo dell'argomento
        topicInputTextarea.value = '';

        // 2. Pulizia sessione UI e riferimenti JobID
        globalCacheTones = {};
        sessionGeneratedToneFlags = {};
        modalToneGenerationRefreshPromise = null;
        modalToneSwitcherBusy = false;
        analysisCompleted = false;
        hasDeductedCreditForJob = false;
        initialJobToneRestoreDone = false;
        inputUnlockedByPaste = false;
        sessionStorage.removeItem('prism_last_job_id');
        console.log("🧹 PRISM: Sessione JobID rimossa.");

        // 3. Blocca tutte le card dei toni (rimuove lo stato 'enabled')
        document.querySelectorAll('.tone-card').forEach(card => {
            card.classList.remove('enabled', 'tone-unavailable');
        });
        globalToneAvailability = {};
        activeJobToneSyncId = null;
        stopToneAvailabilityFirestoreSync();

        // 4. Riporta le impostazioni Social/Lingua allo stato bloccato
        if (settingsRow) {
            settingsRow.style.pointerEvents = "none";
            settingsRow.style.opacity = "0.5";
        }
        unlockDashboardPlatformSelection();
        resetDashboardLanguageSelection();
        unlockDashboardLanguageSelection();

        // 5. Aggiorna lo stato dei bottoni (torna a disabled)
        handleInputTrigger();

        console.log("✨ PRISM: Interfaccia e cache resettate.");
    }
};

function updateChecklist(currentStep) {
    const stepsOrder = { query_shaping: 1, tavily_search: 2, refiner: 3, done: 4 };
    const currentOrder = stepsOrder[currentStep] || 0;
    const checklistItems = [
        { id: 'check-shaping', order: 1 },
        { id: 'check-search', order: 2 },
        { id: 'check-refiner', order: 3 }
    ];
    checklistItems.forEach(item => {
        const el = document.getElementById(item.id);
        if (!el) return;
        if (currentOrder > item.order || currentStep === 'done') {
            el.innerHTML = "✅";
            el.style.color = "#10b981";
        } else if (currentOrder === item.order) {
            el.innerHTML = "⏳";
            el.style.color = "#3b82f6";
        } else {
            el.innerHTML = "⚪";
            el.style.color = "#3f3f46";
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPINNER 1 — ANALISI (F1→F3)
// DOM: #prism-modal  >  #analysis-prism-loader  >  #analysis-status-msg
// Polling: pollInterval (1s) — NON condividere con generazione tono
// ═══════════════════════════════════════════════════════════════════════════════

// Label testuali per ogni fase dell'analisi
const ANALYSIS_STEP_LABELS = {
    query_shaping: 'Shaping della query — preparazione dello spunto',
    tavily_search: 'Ricerca fonti autorevoli in tempo reale',
    refiner: 'Affinamento e compressione del research',
    done: 'Analisi completata — pronti per la rifrazione!'
};

// Legge workerState.currentStep dal payload Redis (fallback su pipeline.step)
function getAnalysisWorkerStep(jobData) {
    const workerState = jobData?.workerState || {}; // oggetto stato worker BullMQ
    return workerState.currentStep || jobData?.pipeline?.step || 'query_shaping'; // step corrente
}

// Calcola progress 0.15 / 0.40 / 0.55-0.70 in base allo step running
function resolveAnalysisRunningProgress(currentStep, rawProgress) {
    if (currentStep === 'query_shaping') return 0.15; // F1 shaping
    if (currentStep === 'tavily_search') return 0.40; // F2 ricerca
    if (currentStep === 'refiner') { // F3 refiner
        if (typeof rawProgress === 'number') return Math.min(0.70, Math.max(0.55, rawProgress)); // progress dinamico
        return 0.625; // default refiner
    }
    if (currentStep === 'done') return 1.0; // completato
    if (typeof rawProgress === 'number') return Math.min(1, Math.max(0, rawProgress)); // fallback numerico
    return 0.15; // default iniziale
}

// Mappa jobData → { status, currentStep, progress, label } per lo spinner analisi
function buildAnalysisPrismUI(jobData) {
    const status = jobData?.status || 'pending'; // status job Redis
    const workerState = jobData?.workerState || {}; // stato worker
    const currentStep = getAnalysisWorkerStep(jobData); // step corrente
    const rawProgress = workerState.progress ?? jobData?.pipeline?.progress; // progress grezzo

    if (status === 'completed' || currentStep === 'done') { // analisi terminata
        return { status, currentStep: 'done', progress: 1.0, label: ANALYSIS_STEP_LABELS.done };
    }
    if (status === 'pending') { // in coda
        return { status, currentStep, progress: 0.0, label: 'In attesa di avvio analisi...' };
    }
    if (status === 'failed') { // errore pipeline
        const progress = typeof rawProgress === 'number' ? rawProgress : resolveAnalysisRunningProgress(currentStep, rawProgress);
        const label = workerState.message || jobData?.error?.message || 'Errore durante l\'analisi';
        return { status, currentStep, progress, label };
    }
    const progress = resolveAnalysisRunningProgress(currentStep, rawProgress); // step running
    const label = workerState.message || ANALYSIS_STEP_LABELS[currentStep] || ANALYSIS_STEP_LABELS.query_shaping;
    return { status, currentStep, progress, label };
}

// true quando l'analisi F1-F3 è finita → dissolve spinner analisi
function isAnalysisJobCompleted(jobData, ui) {
    return jobData?.status === 'completed' || ui.currentStep === 'done';
}

// true quando l'analisi è fallita
function isAnalysisJobFailed(jobData) {
    return jobData?.status === 'failed';
}

// Messaggio blocco shaping (research.shaping.is_blocked === true)
function getShapingBlockMessage(jobData) {
    const shaping = jobData?.research?.shaping;
    if (!shaping || shaping.is_blocked !== true) return null;
    const msg = (shaping.block_message || '').trim();
    return msg || 'Il contenuto non può essere analizzato.';
}

// Apre overlay fullscreen analisi e resetta animazione prisma
function openAnalysisPrismModal(message) {
    const modal = document.getElementById('prism-modal'); // overlay bloccante analisi
    const loader = document.getElementById('analysis-prism-loader'); // contenitore SVG prisma
    if (loader) loader.classList.remove('dissolving'); // rimuove classe dissolvenza
    updateAnalysisPrismUI(message || 'Preparazione analisi...', 0); // label + progress 0%
    if (modal) modal.style.display = 'flex'; // mostra overlay
}

// Aggiorna testo fase e barra progress sotto il prisma analisi
function updateAnalysisPrismUI(message, progress) {
    const statusEl = document.getElementById('analysis-status-msg'); // label fase analisi
    const progressFill = document.getElementById('analysis-progress-fill'); // barra rainbow
    if (statusEl && message) statusEl.innerText = message; // scrive messaggio
    if (progressFill && typeof progress === 'number') progressFill.style.width = `${Math.round(progress * 100)}%`; // aggiorna %
}

// Chiude overlay analisi; se dissolve=true applica fade-out al prisma
function closeAnalysisPrismModal(dissolve, onComplete) {
    const modal = document.getElementById('prism-modal'); // overlay analisi
    const loader = document.getElementById('analysis-prism-loader'); // spinner analisi
    const finish = () => { // callback chiusura definitiva
        if (modal) modal.style.display = 'none'; // nasconde overlay
        if (loader) loader.classList.remove('dissolving'); // reset animazione
        updateAnalysisPrismUI('Preparazione analisi...', 0); // reset label
        if (onComplete) onComplete(); // es. guida utente fase 4
    };
    if (!dissolve || !loader) { finish(); return; } // chiusura immediata senza fade
    loader.classList.add('dissolving'); // avvia dissolvenza CSS
    setTimeout(finish, 850); // attende fine transizione
}

// Errore pipeline analisi: chiude spinner e riabilita UI
function handlePipelineError(errorMessage) {
    if (pollInterval) clearInterval(pollInterval); // ferma polling analisi
    closeAnalysisPrismModal(false); // chiude overlay senza dissolve
    const checklist = document.querySelector('.checklist-container'); // checklist fasi
    if (checklist) checklist.style.display = 'block'; // ripristina checklist
    const btn = document.querySelector('.generate-btn'); // pulsante ANALIZZA
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; } // riabilita
    console.error('🚨 [PRISM ERROR]:', errorMessage); // log errore
    if (typeof window.showPrismError === 'function') {
        window.showPrismError(errorMessage);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SPINNER 2 — GENERAZIONE TONO (F4)
// DOM: #output-modal  >  #tone-gen-prism-loader  >  #tone-gen-status-msg
// Polling: tonePollInterval (2s) — separato da pollInterval analisi
// Completamento: status torna a "completed" DOPO aver visto "generating"
// ═══════════════════════════════════════════════════════════════════════════════

// Label testuali per le fasi F4
const TONE_GEN_STEP_LABELS = {
    generation: 'Generazione del contenuto — rifrazione del tono in corso...',
    done: 'Rifrazione completata'
};

// Legge workerState.currentStep per F4 (fallback su pipeline.step)
function getToneGenWorkerStep(jobData) {
    const workerState = jobData?.workerState || {}; // stato worker
    return workerState.currentStep || workerState.step || jobData?.pipeline?.step || 'generation'; // step F4
}

// true se il tono è abilitato alla generazione (tones[toneKey].status === 'ON')
function isToneGenerationAvailable(toneKey) {
    const info = globalToneAvailability[toneKey];
    if (!info) return true;
    return info.available !== false;
}

function getToneLockReason(toneKey) {
    const reason = (globalToneAvailability[toneKey]?.lockReason || '').trim();
    return reason || 'Questo tono non è disponibile per il contenuto analizzato.';
}

function parseToneEntryAvailability(entry) {
    if (entry === null || entry === undefined) return null;

    if (typeof entry === 'boolean') {
        return { available: entry, lockReason: '' };
    }

    if (typeof entry === 'string') {
        const normalized = entry.trim().toUpperCase();
        const offValues = ['OFF', 'FALSE', 'NO', 'DISABLED', '0', 'UNAVAILABLE', 'LOCKED'];
        return { available: !offValues.includes(normalized), lockReason: '' };
    }

    if (typeof entry !== 'object') return null;

    if (typeof entry.available === 'boolean') {
        return {
            available: entry.available,
            lockReason: entry.lock_reason || entry.lockReason || entry.reason || entry.message || ''
        };
    }

    if (typeof entry.enabled === 'boolean') {
        return {
            available: entry.enabled,
            lockReason: entry.lock_reason || entry.lockReason || entry.reason || entry.message || ''
        };
    }

    const status = entry.status ?? entry.state ?? entry.suitable ?? entry.suitability;
    if (typeof status === 'boolean') {
        return {
            available: status,
            lockReason: entry.lock_reason || entry.lockReason || entry.reason || entry.message || ''
        };
    }

    const statusStr = String(status ?? 'ON').trim().toUpperCase();
    const offValues = ['OFF', 'FALSE', 'NO', 'DISABLED', '0', 'UNAVAILABLE', 'LOCKED'];
    return {
        available: !offValues.includes(statusStr),
        lockReason: entry.lock_reason || entry.lockReason || entry.reason || entry.message || ''
    };
}

function mergeToneSourceMaps(...sources) {
    const merged = {};
    sources.forEach((source) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) return;
        Object.keys(source).forEach((key) => {
            merged[key] = source[key];
        });
    });
    return merged;
}

function extractAllToneSourcesFromJob(jobData) {
    if (!jobData) return {};

    return mergeToneSourceMaps(
        jobData.tones,
        jobData.testo?.tones,
        jobData.data?.tones,
        jobData.data?.testo?.tones,
        jobData.research?.shaping?.tone_suitability,
        jobData.research?.tone_suitability,
        jobData.shaping?.tone_suitability
    );
}

function parseToneAvailabilityFromJob(jobData) {
    const toneSources = extractAllToneSourcesFromJob(jobData);
    const availability = {};

    document.querySelectorAll('.tone-card').forEach(card => {
        const slug = card.getAttribute('data-key');
        if (!slug) return;

        const entry = findToneEntry(toneSources, slug);
        const parsed = parseToneEntryAvailability(entry);

        availability[slug] = parsed || { available: true, lockReason: '' };
    });

    return availability;
}

function renderToneAvailabilityUI() {
    document.querySelectorAll('.tone-card').forEach(card => {
        if (card.classList.contains('locked-by-plan')) return;

        const slug = card.getAttribute('data-key');
        const info = globalToneAvailability[slug];

        card.classList.add('enabled');
        if (info && info.available === false) {
            card.classList.add('tone-unavailable');
        } else {
            card.classList.remove('tone-unavailable');
        }
    });
}

function applyToneAvailabilityFromJob(jobData) {
    globalToneAvailability = parseToneAvailabilityFromJob(jobData);
    renderToneAvailabilityUI();
    console.log('[PRISM TONES] Disponibilità toni aggiornata:', globalToneAvailability);
}

function stopToneAvailabilityFirestoreSync() {
    if (jobToneUnsubscribe) {
        jobToneUnsubscribe();
        jobToneUnsubscribe = null;
    }
    activeJobToneSyncId = null;
}

async function startToneAvailabilityFirestoreSync(jobId) {
    if (!jobId || !window.db) return;
    if (activeJobToneSyncId === jobId && jobToneUnsubscribe) return;

    stopToneAvailabilityFirestoreSync();

    const attachSnapshot = (ref, label) => {
        jobToneUnsubscribe = ref.onSnapshot((doc) => {
            if (!doc.exists) return;
            applyToneAvailabilityFromJob(doc.data());
            console.log(`[PRISM TONES] Sync Firestore (${label})`, jobId);
        }, (error) => {
            console.warn(`[PRISM TONES] Errore sync Firestore (${label}):`, error.message);
        });
    };

    try {
        const jobRef = window.db.collection('jobs').doc(jobId);
        const jobSnap = await jobRef.get();
        if (jobSnap.exists) {
            applyToneAvailabilityFromJob(jobSnap.data());
            attachSnapshot(jobRef, 'jobs');
            activeJobToneSyncId = jobId;
            return;
        }

        const contentRef = window.db.collection('contents').doc(jobId);
        const contentSnap = await contentRef.get();
        if (contentSnap.exists) {
            applyToneAvailabilityFromJob(contentSnap.data());
            attachSnapshot(contentRef, 'contents');
            activeJobToneSyncId = jobId;
            return;
        }

        const byJobId = await window.db.collection('contents').where('job_id', '==', jobId).limit(1).get();
        if (!byJobId.empty) {
            const doc = byJobId.docs[0];
            applyToneAvailabilityFromJob(doc.data());
            attachSnapshot(doc.ref, 'contents/job_id');
            activeJobToneSyncId = jobId;
            return;
        }

        const byJobIdCamel = await window.db.collection('contents').where('jobId', '==', jobId).limit(1).get();
        if (!byJobIdCamel.empty) {
            const doc = byJobIdCamel.docs[0];
            applyToneAvailabilityFromJob(doc.data());
            attachSnapshot(doc.ref, 'contents/jobId');
            activeJobToneSyncId = jobId;
        }
    } catch (err) {
        console.warn('[PRISM TONES] Lookup Firestore non riuscito:', err.message);
    }
}

async function restoreActiveJobToneState() {
    const jobId = sessionStorage.getItem('prism_last_job_id');
    const userData = getCurrentUserData();
    if (!jobId || !userData.userId) return;

    try {
        const BACKEND_URL = getBackendUrl();
        const statusResp = await fetch(`${BACKEND_URL}/jobs/status/${userData.userId}/${jobId}`);
        const res = await statusResp.json();
        if (res.success && res.data) {
            const jobData = res.data;
            if (isAnalysisJobCompleted(jobData, buildAnalysisPrismUI(jobData))) {
                analysisCompleted = true;
                if (settingsRow) {
                    settingsRow.style.pointerEvents = 'auto';
                    settingsRow.style.opacity = '1';
                }
                applyToneAvailabilityFromJob(jobData);
                startToneAvailabilityFirestoreSync(jobId);
                handleInputTrigger();
            }
        }
    } catch (err) {
        console.warn('[PRISM TONES] Ripristino job attivo non riuscito:', err.message);
        startToneAvailabilityFirestoreSync(jobId);
    }
}

// Estrae l'oggetto tones dal payload job (più path possibili)
function extractTonesFromJob(jobData) {
    if (!jobData) return {}; // guard
    if (jobData.tones && typeof jobData.tones === 'object') return jobData.tones; // root
    if (jobData.testo?.tones) return jobData.testo.tones; // testo.tones
    if (jobData.data?.tones) return jobData.data.tones; // data.tones
    if (jobData.data?.testo?.tones) return jobData.data.testo.tones; // data.testo.tones
    return {}; // non trovato
}

// Trova la voce tono nell'oggetto tones (match case-insensitive sulla chiave)
function findToneEntry(tones, toneKey) {
    if (!tones || !toneKey) return null; // guard
    if (tones[toneKey]) return tones[toneKey]; // match esatto
    const lower = toneKey.toLowerCase(); // chiave normalizzata
    for (const key of Object.keys(tones)) { // scan chiavi
        if (key.toLowerCase() === lower) return tones[key]; // match case-insensitive
    }
    return null; // non trovato
}

// Normalizza tones[toneKey].versions — array oppure oggetto Firebase { 0, 1, ... }
function normalizeToneVersions(versions) {
    if (!versions) return []; // nessuna versione
    if (Array.isArray(versions)) return versions.filter(Boolean); // array nativo
    if (typeof versions === 'object') { // mappa numerica Firebase
        return Object.keys(versions)
            .sort((a, b) => Number(a) - Number(b)) // ordine indice
            .map((k) => versions[k]) // ogni versione
            .filter(Boolean); // scarta null/undefined
    }
    return []; // formato non riconosciuto
}

// Estrae il testo da una voce tono: tones[toneKey].versions[n].text (ultima versione)
function extractTextFromToneEntry(entry) {
    if (!entry) return ''; // voce assente
    if (typeof entry === 'string') return entry; // testo grezzo diretto
    if (typeof entry.text === 'string' && entry.text) return entry.text; // .text legacy flat
    if (typeof entry.content === 'string' && entry.content) return entry.content; // .content fallback
    const versionList = normalizeToneVersions(entry.versions); // lista versioni
    if (versionList.length === 0) return ''; // nessuna versione con testo
    const latest = versionList.reduce((best, version) => { // ultima per createdAt
        if (!best) return version; // prima versione
        const bestTs = best.createdAt ? new Date(best.createdAt).getTime() : -1; // timestamp best
        const curTs = version.createdAt ? new Date(version.createdAt).getTime() : -1; // timestamp corrente
        return curTs >= bestTs ? version : best; // preferisci la più recente
    }, null);
    return latest?.text || latest?.content || ''; // testo ultima versione
}

/**
 * Recupera il tono da Firestore (ultima versione) e idrata la sessione UI.
 * Ritorna { status: 'ok'|'missing'|'error', text?, message?, result? }
 */
async function resolveToneContentFromFirestore(jobId, toneKey) {
    if (!window.db) {
        return { status: 'error', message: 'Firestore non disponibile. Ricarica la pagina e riprova.' };
    }
    if (!jobId) {
        return { status: 'error', message: 'Job di analisi non trovato. Avvia prima l\'analisi.' };
    }
    if (!toneKey) {
        return { status: 'error', message: 'Tono non valido.' };
    }

    try {
        const fetchResult = await fetchLatestToneFromFirestore(jobId, toneKey);
        if (fetchResult.error) {
            return { status: 'error', message: fetchResult.error };
        }
        if (!fetchResult.found || !fetchResult.text.trim()) {
            return { status: 'missing' };
        }
        applyFirestoreToneToSession(toneKey, fetchResult);
        return { status: 'ok', text: fetchResult.text, result: fetchResult };
    } catch (err) {
        console.error('❌ [PRISM FIRESTORE TONE] Errore imprevisto:', err);
        return { status: 'error', message: mapFirestoreToneError(err) };
    }
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getToneVersionTimestampMs(entry) {
    if (!entry) return -1;
    if (entry.timestamp?.toDate) return entry.timestamp.toDate().getTime();
    if (entry.updatedAt?.toDate) return entry.updatedAt.toDate().getTime();
    if (entry.createdAt) return new Date(entry.createdAt).getTime();
    if (entry.updatedAt) return new Date(entry.updatedAt).getTime();
    return -1;
}

function findStoricoEntries(storico, toneKey) {
    if (!storico || !toneKey) return [];
    if (Array.isArray(storico[toneKey])) return storico[toneKey].filter(Boolean);
    const lower = toneKey.toLowerCase();
    for (const key of Object.keys(storico)) {
        if (key.toLowerCase() === lower && Array.isArray(storico[key])) {
            return storico[key].filter(Boolean);
        }
    }
    return [];
}

function collectAllToneVersionsFromDoc(docData, toneKey) {
    if (!docData || !toneKey) return [];

    const candidates = [];
    const roots = [docData?.testo, docData?.data?.testo, docData].filter(Boolean);

    roots.forEach((root) => {
        const currentEntry = findToneEntry(root.tones || extractTonesFromJob(root), toneKey);
        if (currentEntry) candidates.push(currentEntry);
        candidates.push(...findStoricoEntries(root.storico, toneKey));
    });

    const rootTones = extractTonesFromJob(docData);
    const rootEntry = findToneEntry(rootTones, toneKey);
    if (rootEntry) candidates.push(rootEntry);

    return candidates;
}

function pickLatestToneVersion(versions) {
    if (!versions.length) return null;

    return versions.reduce((best, current) => {
        if (!best) return current;

        const bestVersion = Number(best.version) || 0;
        const currentVersion = Number(current.version) || 0;
        if (currentVersion !== bestVersion) {
            return currentVersion > bestVersion ? current : best;
        }

        const bestTs = getToneVersionTimestampMs(best);
        const currentTs = getToneVersionTimestampMs(current);
        if (bestTs !== currentTs) return currentTs > bestTs ? current : best;

        const bestTextLen = (extractTextFromToneEntry(best) || '').length;
        const currentTextLen = (extractTextFromToneEntry(current) || '').length;
        return currentTextLen >= bestTextLen ? current : best;
    }, null);
}

function mapFirestoreToneError(err) {
    const code = err?.code || '';
    if (code === 'permission-denied') {
        return 'Permessi insufficienti per leggere il contenuto da Firestore.';
    }
    if (code === 'unauthenticated') {
        return 'Sessione scaduta. Effettua di nuovo l\'accesso e riprova.';
    }
    if (code === 'not-found') {
        return 'Documento contenuto non trovato su Firestore.';
    }
    if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'resource-exhausted') {
        return 'Firestore non raggiungibile. Verifica la connessione e riprova.';
    }
    if (code === 'failed-precondition' || code === 'aborted') {
        return 'Operazione Firestore interrotta. Riprova tra qualche secondo.';
    }
    if (code === 'invalid-argument') {
        return 'Parametri non validi per la lettura del contenuto.';
    }
    return err?.message || 'Errore durante il recupero del contenuto da Firestore.';
}

async function resolveJobContentDocument(jobId) {
    if (!window.db || !jobId) return null;

    const contentRef = window.db.collection('contents').doc(jobId);
    const contentSnap = await contentRef.get();
    if (contentSnap.exists) {
        return { ref: contentRef, id: contentSnap.id, data: contentSnap.data(), source: 'contents' };
    }

    for (const field of ['job_id', 'jobId']) {
        const querySnap = await window.db.collection('contents').where(field, '==', jobId).limit(1).get();
        if (!querySnap.empty) {
            const doc = querySnap.docs[0];
            return { ref: doc.ref, id: doc.id, data: doc.data(), source: `contents/${field}` };
        }
    }

    const jobRef = window.db.collection('jobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (jobSnap.exists) {
        return { ref: jobRef, id: jobSnap.id, data: jobSnap.data(), source: 'jobs' };
    }

    return null;
}

async function fetchLatestToneFromFirestore(jobId, toneKey) {
    if (!window.db) {
        return { found: false, error: 'Firestore non disponibile. Ricarica la pagina e riprova.' };
    }
    if (!jobId) {
        return { found: false, error: 'Job di analisi non trovato. Avvia prima l\'analisi.' };
    }
    if (!toneKey) {
        return { found: false, error: 'Tono non valido.' };
    }

    try {
        const docResult = await resolveJobContentDocument(jobId);
        if (!docResult) {
            return { found: false, error: null, contentData: null, entry: null, text: '' };
        }

        const latestEntry = pickLatestToneVersion(collectAllToneVersionsFromDoc(docResult.data, toneKey));
        const text = extractTextFromToneEntry(latestEntry).trim();

        if (!text) {
            return { found: false, error: null, contentData: docResult.data, entry: null, text: '' };
        }

        return {
            found: true,
            error: null,
            contentData: docResult.data,
            entry: latestEntry,
            text,
            source: docResult.source
        };
    } catch (err) {
        console.error('❌ [PRISM FIRESTORE TONE] Errore recupero tono:', err);
        return { found: false, error: mapFirestoreToneError(err), contentData: null, entry: null, text: '' };
    }
}

async function fetchLatestToneFromFirestoreWithRetry(jobId, toneKey, attempts = 5, delayMs = 1200) {
    let lastResult = { found: false, error: null, text: '' };

    for (let attempt = 0; attempt < attempts; attempt++) {
        lastResult = await fetchLatestToneFromFirestore(jobId, toneKey);
        if (lastResult.error || lastResult.found) return lastResult;
        if (attempt < attempts - 1) await delay(delayMs);
    }

    return lastResult;
}

function applyFirestoreToneToSession(toneKey, fetchResult) {
    if (!fetchResult?.found || !fetchResult.entry) return false;

    // Idratazione sessione UI (non usata come sorgente dati — Firestore resta l'unica fonte)
    globalCacheTones[toneKey] = fetchResult.entry;
    const assets = extractAllDatabaseAssets(fetchResult.contentData || {});
    globalCacheMedia = {
        verifiedImages: assets.images || [],
        verifiedTables: [],
        sourcesPreview: assets.sources || []
    };
    return true;
}

function showPrismErrorSafe(message, options) {
    if (typeof window.showPrismError === 'function') {
        window.showPrismError(message, options);
        return;
    }
    console.error('[PRISM ERROR]', message);
}

// Mappa jobData → UI spinner generazione tono
function buildToneGenPrismUI(jobData) {
    const status = jobData?.status || 'generating'; // status job
    const workerState = jobData?.workerState || {}; // worker state
    const currentStep = getToneGenWorkerStep(jobData); // step corrente
    const rawProgress = workerState.progress ?? jobData?.pipeline?.progress; // progress grezzo

    if (status === 'failed') { // errore generazione
        return {
            phase: 'failed',
            status,
            currentStep,
            progress: typeof rawProgress === 'number' ? rawProgress : 0,
            label: workerState.message || jobData?.error?.message || 'Errore durante la generazione del tono'
        };
    }
    if (status === 'generating') { // F4 in corso (0.90 → 0.95)
        return {
            phase: 'generation',
            status,
            currentStep,
            progress: typeof rawProgress === 'number' ? rawProgress : 0.90,
            label: workerState.message || TONE_GEN_STEP_LABELS.generation
        };
    }
    if ((status === 'completed' || status === 'done') && toneGenHasSeenGenerating) { // F4 finita
        return {
            phase: 'done',
            status,
            currentStep: 'done',
            progress: 1.0,
            label: workerState.message || TONE_GEN_STEP_LABELS.done
        };
    }
    return { // stato residuo pre-F4 (completed analisi) → mostra ancora generazione
        phase: 'generation',
        status: 'generating',
        currentStep: 'generation',
        progress: typeof rawProgress === 'number' ? rawProgress : 0.90,
        label: workerState.message || TONE_GEN_STEP_LABELS.generation
    };
}

// true quando F4 è completa: status "completed" dopo aver visto "generating"
function isToneGenComplete(jobData) {
    if (!toneGenHasSeenGenerating) return false; // ignora completed residuo dell'analisi
    const status = jobData?.status || ''; // status corrente
    return status === 'completed' || status === 'done'; // F4 terminata
}

// true quando generazione tono fallita
function isToneGenFailed(jobData) {
    return jobData?.status === 'failed';
}

// Mostra spinner generazione tono dentro #output-modal
function openToneGenPrismLoader(message, progress) {
    const loader = document.getElementById('tone-gen-prism-loader'); // spinner F4
    if (!loader) return; // elemento mancante
    loader.classList.remove('dissolving'); // reset dissolvenza
    loader.style.display = 'flex'; // rende visibile il prisma
    loader.style.opacity = ''; // rimuove opacity inline
    loader.style.transform = ''; // rimuove transform inline
    loader.style.filter = ''; // rimuove filter inline
    loader.style.transition = ''; // rimuove transition inline
    updateToneGenPrismUI(message || TONE_GEN_STEP_LABELS.generation, progress ?? 0.90); // label + barra
}

// Aggiorna label e progress bar spinner generazione tono
function updateToneGenPrismUI(message, progress) {
    const statusEl = document.getElementById('tone-gen-status-msg'); // testo fase F4
    const progressFill = document.getElementById('tone-gen-progress-fill'); // barra rainbow F4
    if (statusEl && message) statusEl.innerText = message; // scrive messaggio
    if (progressFill && typeof progress === 'number') progressFill.style.width = `${Math.round(progress * 100)}%`; // aggiorna %
}

// Dissolve spinner generazione tono e chiama callback (es. typewriter)
function dissolveToneGenPrism(callback) {
    const loader = document.getElementById('tone-gen-prism-loader'); // spinner F4
    if (!loader) { if (callback) callback(); return; } // fallback se DOM assente
    const svgContainer = loader.querySelector('.prism-svg-container'); // wrapper animazione
    const svg = loader.querySelector('.prism-svg'); // SVG prisma
    if (svgContainer) svgContainer.style.animation = 'none'; // ferma float
    if (svg) svg.style.animation = 'none'; // ferma rotazione
    loader.style.opacity = ''; // pulisce inline per permettere transizione CSS
    loader.style.transform = ''; // pulisce inline
    loader.style.filter = ''; // pulisce inline
    loader.classList.remove('dissolving'); // reset classe
    void loader.offsetHeight; // forza reflow browser
    loader.classList.add('dissolving'); // avvia dissolvenza CSS
    setTimeout(() => { // dopo animazione
        loader.style.display = 'none'; // nasconde spinner
        loader.classList.remove('dissolving'); // reset classe
        if (callback) callback(); // es. startToneContentReveal
    }, 850); // durata transizione
}

// Nasconde spinner generazione senza animazione (errore o reset)
function hideToneGenPrismLoader() {
    const loader = document.getElementById('tone-gen-prism-loader'); // spinner F4
    if (!loader) return; // elemento mancante
    loader.classList.remove('dissolving'); // reset animazione
    loader.style.display = 'none'; // nasconde
}

// Gestisce errore F4: ferma polling, chiude modale, reset spinner
function handleToneGenerationError(message) {
    if (tonePollInterval) clearInterval(tonePollInterval); // ferma polling F4
    tonePollInterval = null; // reset handle
    toneGenRevealStarted = false; // reset flag reveal
    modalToneSwitcherBusy = false;
    const modal = document.getElementById('output-modal'); // modale output
    if (modal) modal.style.display = 'none'; // chiude modale
    hideToneGenPrismLoader(); // nasconde prisma
    renderModalToneSwitcher(currentActiveToneKey);
    console.error('🚨 [PRISM TONE ERROR]:', message); // log
    if (typeof window.showPrismError === 'function') {
        window.showPrismError(message, { title: 'Errore di generazione' });
    }
}

// Tick singolo polling F4 — ritorna true se generazione completata
async function pollToneGenerationOnce(toneKey, jobId, userId, backendUrl, modalBox, titleEl, textEl) {
    if (toneGenRevealStarted) return true;

    let pr;
    try {
        pr = await fetch(`${backendUrl}/jobs/status/${userId}/${jobId}`);
    } catch (err) {
        console.warn('⚠️ [PRISM F4] Polling rete:', err.message);
        return false;
    }

    if (!pr.ok) {
        handleToneGenerationError('Errore nel monitoraggio della generazione. Verifica PRISM Core e riprova.');
        return true;
    }

    let ps;
    try {
        ps = await pr.json();
    } catch (err) {
        handleToneGenerationError('Risposta non valida durante il monitoraggio della generazione.');
        return true;
    }

    if (!ps.success) {
        handleToneGenerationError(mapToneSurgicalApiError(ps, pr.status));
        return true;
    }

    const task = ps.data; // payload job Redis
    const status = task?.status || ''; // status corrente

    if (status === 'generating') toneGenHasSeenGenerating = true; // F4 avviata: ignora completed residuo analisi

    const ui = buildToneGenPrismUI(task); // calcola label + progress

    if (isToneGenFailed(task)) { handleToneGenerationError(ui.label || task.error?.message || 'Errore durante la scrittura del tono'); return true; } // stop errore

    updateToneGenPrismUI(ui.label, ui.progress); // aggiorna spinner

    if (!isToneGenComplete(task)) return false; // continua polling finché status ≠ completed

    await finalizeToneGenerationReveal(toneKey, jobId, modalBox, titleEl, textEl);
    return true; // polling terminato
}

/** Al termine F4: recupera da Firestore (fonte autoritativa) con fallback su contenutoGenerato API. */
async function finalizeToneGenerationReveal(toneKey, jobId, modalBox, titleEl, textEl, apiFallbackText) {
    toneGenRevealStarted = true;
    if (tonePollInterval) clearInterval(tonePollInterval);
    tonePollInterval = null;
    updateToneGenPrismUI(TONE_GEN_STEP_LABELS.done, 1.0);

    const firestoreTone = await fetchLatestToneFromFirestoreWithRetry(jobId, toneKey);
    let fullText = '';

    if (firestoreTone.found && firestoreTone.text.trim()) {
        applyFirestoreToneToSession(toneKey, firestoreTone);
        fullText = firestoreTone.text;
    } else if (apiFallbackText && String(apiFallbackText).trim()) {
        fullText = String(apiFallbackText).trim();
        console.warn('⚠️ [PRISM F4] Firestore non sincronizzato — fallback su contenutoGenerato API');
    } else if (firestoreTone.error) {
        handleToneGenerationError(firestoreTone.error);
        return;
    } else {
        handleToneGenerationError(
            'Generazione completata ma il contenuto non è ancora disponibile su Firestore. Riprova tra qualche secondo.'
        );
        return;
    }

    markToneAsGenerated(toneKey, true);
    const richHTMLContent = parseAndCleanContentForModal(fullText);

    dissolveToneGenPrism(() => {
        startToneContentReveal(toneKey, richHTMLContent, modalBox, titleEl, textEl);
    });
}

// Avvia typewriter del contenuto tono dopo dissolve prisma (logica premium originale)
function startToneContentReveal(toneKey, richHTMLContent, modalBox, titleEl, textEl) {
    if (activeTypewriterTimeout) clearTimeout(activeTypewriterTimeout); // ferma typewriter precedente
    titleEl.innerText = `PRISM - Contenuto [${toneKey.toUpperCase()}]`; // titolo modale finale

    textEl.innerHTML = ''; // svuota area testo
    const typewriterWrap = document.createElement('div'); // wrapper interno per typewriter
    typewriterWrap.style.cssText = 'color: #e4e4e7; font-size: 15px; line-height: 1.7; white-space: pre-wrap;'; // stile contenuto
    textEl.appendChild(typewriterWrap); // monta wrapper in #modal-tone-text

    typewriterHTML(typewriterWrap, richHTMLContent, 18, () => { // macchina da scrivere sul wrapper
        if (modalBox) { // espande modale a fine scrittura
            modalBox.style.width = '950px'; // larghezza contenuto + sidebar
            modalBox.classList.add('completed-glow'); // glow perimetrale tono
            modalBox.style.overflowY = 'auto'; // abilita scroll
        }
        markToneAsGenerated(toneKey, true);
        modalToneSwitcherBusy = false;
        ensureModalToneSwitcherReady(toneKey);
        renderToneAssetsAndActions(toneKey); // galleria media sotto il testo
        triggerUserGuidePhase5IfNeeded(); // guida freemium fase 5
    });
}

// ==========================================
// 5. FASE 1: ANALISI (F1 -> F3)
// ==========================================

window.generateHumanPost = async function() {
    const topic = topicInputTextarea.value.trim();
    if (!topic) {
        return showPrismErrorSafe('Inserisci uno spunto o incolla un contenuto da analizzare.');
    }

    if (!isTopicReadyForAnalyze(topicInputTextarea.value)) {
        return showPrismErrorSafe(
            'Scrivi almeno 5 parole oppure incolla un contenuto pre-lavorato per avviare l\'analisi.',
            { title: 'Contenuto insufficiente' }
        );
    }

    if (topic.length > maxCharacterLength) {
        return showPrismErrorSafe(
            `Il contenuto supera il limite di ${maxCharacterLength} caratteri.`,
            { title: 'Limite caratteri' }
        );
    }
    
    const btn = document.querySelector('.generate-btn');
    const userData = getCurrentUserData();
    const BACKEND_URL = getBackendUrl();

    if (!userData.companyId) {
        if (typeof window.showPrismError === 'function') {
            return window.showPrismError('Sincronizzazione profilo in corso...');
        }
        return;
    }

    const generationsLeft = currentUserSessionData.companyDetails?.generations_left;
    if (generationsLeft !== undefined && generationsLeft !== null && generationsLeft <= 0) {
        if (typeof window.showPrismError === 'function') {
            return window.showPrismError('Crediti generazioni esauriti. Contatta l\'amministratore o effettua l\'upgrade del piano.');
        }
        return;
    }

    globalCacheTones = {};
    globalCacheMedia = { verifiedImages: [], verifiedTables: [], sourcesPreview: [] };
    sessionGeneratedToneFlags = {};
    modalToneGenerationRefreshPromise = null;
    modalToneSwitcherBusy = false;
    globalToneAvailability = {};
    activeJobToneSyncId = null;
    stopToneAvailabilityFirestoreSync();
    hasDeductedCreditForJob = false;
    openAnalysisPrismModal('In attesa di avvio analisi...');
    
    ['check-shaping', 'check-search', 'check-refiner'].forEach(id => { 
        if(document.getElementById(id)) document.getElementById(id).innerHTML = "⚪"; 
    });

    btn.disabled = true; btn.style.opacity = "0.5";

    if (userGuideActive && userGuideCurrentPhase === 2) {
        hideUserGuide();
    }

    try {
        const response = await fetch(`${BACKEND_URL}/api/prepare-shaping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userData.userId, companyId: userData.companyId, topic, language: getSelectedDashboardLanguage() })
        });

        const initResult = await response.json();
        if (!initResult.success) throw new Error(initResult.error);

        const jobId = initResult.jobId;
        sessionStorage.setItem('prism_last_job_id', jobId);

        pollInterval = setInterval(async () => {
            try {
                const statusResp = await fetch(`${BACKEND_URL}/jobs/status/${userData.userId}/${jobId}`);
                const res = await statusResp.json();
                if (!res.success) return handlePipelineError(res.error || "Errore di connessione");

                const jobData = res.data;
                const ui = buildAnalysisPrismUI(jobData);

                const shapingBlockMessage = getShapingBlockMessage(jobData);
                if (shapingBlockMessage) {
                    return handlePipelineError(shapingBlockMessage);
                }

                if (isAnalysisJobFailed(jobData)) {
                    return handlePipelineError(jobData.error?.message || ui.label || "Errore durante l'analisi");
                }

                updateAnalysisPrismUI(ui.label, ui.progress);
                updateChecklist(ui.currentStep);

                if (isAnalysisJobCompleted(jobData, ui)) {
                    clearInterval(pollInterval);
                    updateAnalysisPrismUI(ANALYSIS_STEP_LABELS.done, 1.0);
                    updateChecklist('done');

                    if (!hasDeductedCreditForJob) {
                        const creditDeducted = await deductGenerationCredit(userData.companyId);
                        if (creditDeducted) {
                            hasDeductedCreditForJob = true;
                        } else {
                            console.warn("⚠️ [CREDITS] Analisi OK ma aggiornamento generations_left non riuscito");
                        }
                    }

                    if (settingsRow) { settingsRow.style.pointerEvents = "auto"; settingsRow.style.opacity = "1"; }
                    applyToneAvailabilityFromJob(jobData);
                    startToneAvailabilityFirestoreSync(jobId);
                    closeAnalysisPrismModal(true, () => {
                        if (userGuideActive) showUserGuidePhase(4);
                    });
                    analysisCompleted = true;
                    btn.disabled = true;
                    btn.style.opacity = "0.3";
                }
            } catch (pollErr) { console.warn("Polling error:", pollErr); }
        }, 1000);
    } catch (err) { handlePipelineError(err.message); }
};

// ==========================================
// 6. FASE 2: GENERAZIONE TONO (F4) - CON FLUSSO PREMIUM E LOCK-SCROLL
// ==========================================

const TONE_ACCENT_COLORS = {
    provocatore: '#3b82f6',
    confidente: '#f59e0b',
    sferzante: '#ef4444',
    visionario: '#a855f7',
    metodologico: '#ec4899',
    narratore: '#06b6d4',
    promotore: '#10b981'
};

const TONE_DEFINITIONS = [
    { key: 'provocatore', label: 'Provocatore', icon: 'fa-fire' },
    { key: 'confidente', label: 'Confidente', icon: 'fa-shield-halved' },
    { key: 'sferzante', label: 'Sferzante', icon: 'fa-bolt' },
    { key: 'visionario', label: 'Visionario', icon: 'fa-lightbulb' },
    { key: 'metodologico', label: 'Metodologico', icon: 'fa-list-check' },
    { key: 'narratore', label: 'Narratore', icon: 'fa-book-open-reader' },
    { key: 'promotore', label: 'Promotore', icon: 'fa-bullhorn' }
];

function getToneDefinition(toneKey) {
    return TONE_DEFINITIONS.find((tone) => tone.key === toneKey) || {
        key: toneKey,
        label: toneKey.charAt(0).toUpperCase() + toneKey.slice(1),
        icon: 'fa-circle'
    };
}

function getPlanEnabledToneKeys() {
    return TONE_DEFINITIONS
        .map((tone) => tone.key)
        .filter((toneKey) => {
            const card = document.querySelector(`.tone-card[data-key="${toneKey}"]`);
            return card
                && card.classList.contains('enabled')
                && !card.classList.contains('locked-by-plan');
        });
}

function isToneSelectableInModal(toneKey) {
    const card = document.querySelector(`.tone-card[data-key="${toneKey}"]`);
    if (!card || !card.classList.contains('enabled') || card.classList.contains('locked-by-plan')) return false;
    if (card.classList.contains('tone-unavailable')) return false;
    return isToneGenerationAvailable(toneKey);
}

/** @deprecated alias — usa getPlanEnabledToneKeys */
function getEnabledModalToneKeys() {
    return getPlanEnabledToneKeys();
}

async function refreshSessionGeneratedToneFlags(jobId, enabledToneKeys) {
    const flags = { ...sessionGeneratedToneFlags };

    if (!jobId || !window.db || !enabledToneKeys.length) {
        sessionGeneratedToneFlags = flags;
        return flags;
    }

    try {
        const docResult = await resolveJobContentDocument(jobId);
        if (docResult?.data) {
            enabledToneKeys.forEach((toneKey) => {
                const latestEntry = pickLatestToneVersion(collectAllToneVersionsFromDoc(docResult.data, toneKey));
                const text = extractTextFromToneEntry(latestEntry).trim();
                if (text) flags[toneKey] = true;
            });
        }
    } catch (err) {
        console.warn('[PRISM MODAL SWITCHER] Errore refresh flag generazione:', mapFirestoreToneError(err));
    }

    sessionGeneratedToneFlags = flags;
    return flags;
}

function renderModalToneSwitcher(activeToneKey) {
    const switcher = document.getElementById('modal-tone-switcher');
    if (!switcher) return;

    const enabledKeys = getPlanEnabledToneKeys();
    if (!enabledKeys.length) {
        switcher.style.display = 'none';
        switcher.innerHTML = '';
        return;
    }

    switcher.style.display = 'flex';
    switcher.innerHTML = enabledKeys.map((toneKey) => {
        const toneDef = getToneDefinition(toneKey);
        const card = document.querySelector(`.tone-card[data-key="${toneKey}"]`);
        const isActive = toneKey === activeToneKey;
        const isGenerated = sessionGeneratedToneFlags[toneKey] === true;
        const isLoading = modalToneSwitcherBusy && isActive;
        const isUnavailable = card?.classList.contains('tone-unavailable') || !isToneGenerationAvailable(toneKey);
        const color = TONE_ACCENT_COLORS[toneKey] || '#a855f7';
        const flagClass = isGenerated ? 'generated' : 'pending';
        const flagIcon = isGenerated ? 'fa-circle-check' : 'fa-circle';
        const flagTitle = isGenerated
            ? 'Già generato per questo argomento'
            : 'Non ancora generato per questo argomento';
        const unavailableClass = isUnavailable ? ' unavailable' : '';
        const disabledAttr = modalToneSwitcherBusy ? 'disabled' : '';
        const clickHandler = isUnavailable
            ? `onclick="showModalToneUnavailable('${toneKey}')"`
            : `onclick="switchModalTone('${toneKey}')"`;

        return `
            <button type="button"
                class="modal-tone-switcher-item${isActive ? ' active' : ''}${isLoading ? ' loading' : ''}${unavailableClass}"
                style="--tone-item-color: ${color}"
                data-tone-key="${toneKey}"
                ${disabledAttr}
                ${clickHandler}
                title="${isUnavailable ? getToneLockReason(toneKey) || 'Non disponibile per questo argomento' : toneDef.label}">
                <i class="fas ${toneDef.icon} tone-mini-icon" aria-hidden="true"></i>
                <span class="tone-mini-label">${toneDef.label}</span>
                ${isLoading
                    ? '<i class="fas fa-spinner fa-spin tone-mini-spinner" aria-hidden="true"></i>'
                    : isUnavailable
                        ? '<i class="fas fa-lock tone-gen-flag unavailable" aria-hidden="true"></i>'
                        : `<i class="fas ${flagIcon} tone-gen-flag ${flagClass}" title="${flagTitle}" aria-hidden="true"></i>`}
            </button>
        `;
    }).join('');
}

window.showModalToneUnavailable = function(toneKey) {
    showPrismErrorSafe(getToneLockReason(toneKey), { title: 'Tono non disponibile' });
};

function markToneAsGenerated(toneKey, generated = true) {
    if (!toneKey) return;
    sessionGeneratedToneFlags[toneKey] = generated;
    renderModalToneSwitcher(currentActiveToneKey);
}

async function ensureModalToneSwitcherReady(activeToneKey) {
    const enabledKeys = getPlanEnabledToneKeys();
    const jobId = sessionStorage.getItem('prism_last_job_id');

    renderModalToneSwitcher(activeToneKey);

    if (!jobId || !enabledKeys.length) return;

    if (modalToneGenerationRefreshPromise) {
        await modalToneGenerationRefreshPromise;
        renderModalToneSwitcher(activeToneKey);
        return;
    }

    modalToneGenerationRefreshPromise = refreshSessionGeneratedToneFlags(jobId, enabledKeys)
        .finally(() => { modalToneGenerationRefreshPromise = null; });

    await modalToneGenerationRefreshPromise;
    renderModalToneSwitcher(activeToneKey);
}

/**
 * Attiva un tono nella modale: Firestore se già generato, altrimenti generazione Gemini.
 */
async function activateModalTone(toneKey, jobId) {
    if (!isToneSelectableInModal(toneKey)) {
        showPrismErrorSafe(getToneLockReason(toneKey), { title: 'Tono non disponibile' });
        return;
    }

    currentActiveToneKey = toneKey;
    applyOutputModalToneTheme(toneKey);
    renderModalToneSwitcher(toneKey);

    modalToneSwitcherBusy = true;
    renderModalToneSwitcher(toneKey);

    try {
        const resolved = await resolveToneContentFromFirestore(jobId, toneKey);

        if (resolved.status === 'error') {
            modalToneSwitcherBusy = false;
            renderModalToneSwitcher(toneKey);
            showPrismErrorSafe(resolved.message, { title: 'Errore recupero contenuto' });
            return;
        }

        if (resolved.status === 'ok') {
            markToneAsGenerated(toneKey, true);
            await displayToneModal(toneKey, resolved.text);
            return;
        }

        lockDashboardPlatformSelection();
        lockDashboardLanguageSelection();
        await generateSingleToneWithInteractivePrism(toneKey, jobId);
    } catch (err) {
        console.error('❌ [PRISM MODAL TONE] Errore attivazione tono:', err);
        modalToneSwitcherBusy = false;
        renderModalToneSwitcher(currentActiveToneKey);
        showPrismErrorSafe(err.message || 'Errore durante il cambio tono.', { title: 'Errore' });
    }
}

window.switchModalTone = async function switchModalTone(toneKey) {
    if (modalToneSwitcherBusy) return;
    if (toneKey === currentActiveToneKey) return;

    const jobId = sessionStorage.getItem('prism_last_job_id');
    if (!jobId) {
        return showPrismErrorSafe('Sessione analisi non valida. Avvia prima l\'analisi.');
    }

    await activateModalTone(toneKey, jobId);
};

function hexToRgba(hex, alpha) {
    const normalized = hex.replace('#', '');
    const r = parseInt(normalized.slice(0, 2), 16);
    const g = parseInt(normalized.slice(2, 4), 16);
    const b = parseInt(normalized.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyOutputModalToneTheme(toneKey) {
    const modalBox = document.getElementById('output-modal-box');
    if (!modalBox || !toneKey) return;

    const card = document.querySelector(`.tone-card[data-key="${toneKey}"]`);
    let color = TONE_ACCENT_COLORS[toneKey] || '#a855f7';
    if (card) {
        const fromCard = getComputedStyle(card).getPropertyValue('--card-color').trim();
        if (fromCard) color = fromCard;
    }

    modalBox.style.setProperty('--tone-accent', color);
    modalBox.style.setProperty('--tone-border', hexToRgba(color, 0.62));
    modalBox.style.setProperty('--tone-glow-1', hexToRgba(color, 0.28));
    modalBox.style.setProperty('--tone-glow-2', hexToRgba(color, 0.14));
    modalBox.dataset.toneKey = toneKey;
}

window.selectToneCard = async function(toneKey) {
    const card = document.querySelector(`[data-key="${toneKey}"]`);
    if (!card || !card.classList.contains('enabled')) return;

    if (card.classList.contains('tone-unavailable') || !isToneGenerationAvailable(toneKey)) {
        return showPrismErrorSafe(getToneLockReason(toneKey), { title: 'Tono non disponibile' });
    }

    if (userGuideActive && userGuideCurrentPhase === 4) {
        hideUserGuide();
        userGuideAwaitingPhase5 = true;
    }

    const jobId = sessionStorage.getItem('prism_last_job_id');
    if (!jobId) {
        return showPrismErrorSafe('Avvia prima l\'analisi.');
    }

    currentActiveToneKey = toneKey;

    card.classList.add('tone-loading');

    try {
        const resolved = await resolveToneContentFromFirestore(jobId, toneKey);

        if (resolved.status === 'error') {
            return showPrismErrorSafe(resolved.message, { title: 'Errore recupero contenuto' });
        }

        if (resolved.status === 'ok') {
            markToneAsGenerated(toneKey, true);
            await displayToneModal(toneKey, resolved.text);
            return;
        }

        lockDashboardPlatformSelection();
        lockDashboardLanguageSelection();
        await generateSingleToneWithInteractivePrism(toneKey, jobId);
    } catch (err) {
        console.error('❌ [PRISM TONE SELECT] Errore imprevisto:', err);
        showPrismErrorSafe(err.message || 'Errore imprevisto durante l\'apertura del tono.', { title: 'Errore' });
    } finally {
        card.classList.remove('tone-loading');
    }
};

/** Blocca i pill piattaforma nella dashboard (non nel popup di rigenerazione). */
function lockDashboardPlatformSelection() {
    dashboardPlatformLocked = true;
    const platformPill = document.querySelector('#settingsRow .platform-pill');
    if (platformPill) {
        platformPill.classList.add('platform-locked');
        platformPill.style.pointerEvents = 'none';
        platformPill.style.opacity = '0.55';
    }
}

/** Sblocca i pill piattaforma dashboard (es. su PULISCI). */
function unlockDashboardPlatformSelection() {
    dashboardPlatformLocked = false;
    const platformPill = document.querySelector('#settingsRow .platform-pill');
    if (platformPill) {
        platformPill.classList.remove('platform-locked');
        platformPill.style.pointerEvents = '';
        platformPill.style.opacity = '';
    }
}

const DASHBOARD_LANGUAGE_DEFAULT = 'italiano';

const VALID_TONE_KEYS = new Set([
    'provocatore', 'confidente', 'sferzante', 'visionario', 'metodologico', 'narratore', 'promotore'
]);

const VALID_PLATFORMS_API = new Set(['linkedin', 'facebook', 'x']);

function normalizePlatformLabelToApi(platformLabel) {
    const raw = (platformLabel || '').toLowerCase().trim();
    if (raw.includes('linkedin')) return 'linkedin';
    if (raw.includes('facebook')) return 'facebook';
    if (raw === 'x' || raw.includes('twitter')) return 'x';
    return 'linkedin';
}

function getSelectedDashboardPlatform() {
    const active = document.querySelector('#settingsRow .platform-pill .pill.active');
    const label = active?.innerText.trim() || 'LinkedIn';
    return normalizePlatformLabelToApi(label);
}

function getSelectedDashboardLanguage() {
    const active = document.querySelector('#settingsRow .lang-pill .pill.active');
    return active?.getAttribute('data-lang') || DASHBOARD_LANGUAGE_DEFAULT;
}

/**
 * Payload prima generazione tono — contratto PRISM-CORE /api/regenerate-tone-surgical.
 * Non include istruzioniAggiuntive / contenutoPrecedente (solo flusso rigenerazione).
 */
function buildInitialToneSurgicalPayload({ userId, companyId, jobId, toneKey, piattaforma, linguaOutput }) {
    const tono = (toneKey || '').toLowerCase().trim();
    if (!VALID_TONE_KEYS.has(tono)) {
        throw new Error(`Tono non valido: "${toneKey}".`);
    }

    const platform = (piattaforma || getSelectedDashboardPlatform()).toLowerCase().trim();
    if (!VALID_PLATFORMS_API.has(platform)) {
        throw new Error(`Piattaforma non valida: "${piattaforma}". Valori ammessi: linkedin, facebook, x.`);
    }

    const language = (linguaOutput || getSelectedDashboardLanguage()).toLowerCase().trim();
    if (!language) {
        throw new Error('Seleziona una lingua di output nella dashboard.');
    }

    if (!userId || !companyId) {
        throw new Error('Profilo utente non sincronizzato. Ricarica la pagina e riprova.');
    }
    if (!jobId) {
        throw new Error('Job di analisi non trovato. Avvia prima l\'analisi.');
    }

    return {
        userId,
        companyId,
        jobId,
        tono,
        linguaOutput: language,
        piattaforma: platform
    };
}

function mapToneSurgicalApiError(result, httpStatus) {
    const code = (result?.error || '').toString();
    const lower = code.toLowerCase();

    if (httpStatus === 401 || lower.includes('unauthorized') || lower.includes('auth')) {
        return 'Sessione scaduta. Effettua di nuovo l\'accesso.';
    }
    if (httpStatus === 403 || lower.includes('permission') || lower.includes('permess')) {
        return 'Non hai i permessi per generare contenuti per questa azienda.';
    }
    if (httpStatus === 404 || code === 'JOB_NOT_FOUND' || lower.includes('non trovato') || lower.includes('not found')) {
        return 'Sessione di analisi scaduta o non trovata. Avvia una nuova analisi.';
    }
    if (httpStatus === 400 && lower.includes('bloccato')) {
        return code || 'Questo tono non è disponibile per l\'argomento selezionato.';
    }
    if (httpStatus === 400 && (lower.includes('parametr') || lower.includes('missing'))) {
        return 'Parametri di generazione non validi. Verifica piattaforma, lingua e tono.';
    }
    if (httpStatus === 429 || lower.includes('quota') || lower.includes('limit') || lower.includes('credit')) {
        return 'Limite di generazioni raggiunto. Contatta l\'amministratore o riprova più tardi.';
    }
    if (httpStatus >= 500) {
        return 'Errore interno del servizio PRISM Core. Riprova tra qualche istante.';
    }
    if (code) return code;
    return 'Impossibile avviare la generazione del tono.';
}

async function invokeToneSurgicalGeneration(payload) {
    const BACKEND_URL = getBackendUrl();
    let response;

    try {
        response = await fetch(`${BACKEND_URL}/api/regenerate-tone-surgical`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error('❌ [PRISM TONE API] Errore di rete:', err);
        throw new Error('Impossibile contattare PRISM Core. Verifica la connessione e che il servizio sia attivo.');
    }

    let result;
    try {
        result = await response.json();
    } catch (err) {
        console.error('❌ [PRISM TONE API] JSON non valido:', err);
        throw new Error('Risposta non valida dal server di generazione.');
    }

    if (!response.ok || result.success === false) {
        throw new Error(mapToneSurgicalApiError(result, response.status));
    }

    return result;
}

function resetDashboardLanguageSelection() {
    document.querySelectorAll('#settingsRow .lang-pill .pill').forEach(p => p.classList.remove('active'));
    const italianPill = document.querySelector('#settingsRow .lang-pill .pill[data-lang="italiano"]');
    if (italianPill) italianPill.classList.add('active');
}

function lockDashboardLanguageSelection() {
    dashboardLanguageLocked = true;
    const langPill = document.querySelector('#settingsRow .lang-pill');
    if (langPill) {
        langPill.classList.add('lang-locked');
        langPill.style.pointerEvents = 'none';
        langPill.style.opacity = '0.55';
    }
}

function unlockDashboardLanguageSelection() {
    dashboardLanguageLocked = false;
    const langPill = document.querySelector('#settingsRow .lang-pill');
    if (langPill) {
        langPill.classList.remove('lang-locked');
        langPill.style.pointerEvents = '';
        langPill.style.opacity = '';
    }
}

/**
 * Generazione tono (prima volta o rigenerazione): chiama PRISM-CORE e gestisce polling / reveal.
 * @param {string} toneKey
 * @param {string} jobId
 * @param {{ piattaforma?: string, linguaOutput?: string }} [options] — override selezione dashboard
 */
async function generateSingleToneWithInteractivePrism(toneKey, jobId, options = {}) {
    const modal = document.getElementById('output-modal');
    const modalBox = document.getElementById('output-modal-box');
    const titleEl = document.getElementById('modal-tone-title');
    const textEl = document.getElementById('modal-tone-text');
    const assetsEl = document.getElementById('modal-tone-assets');

    const userData = getCurrentUserData();
    const BACKEND_URL = getBackendUrl();

    currentActiveToneKey = toneKey;
    modalToneSwitcherBusy = true;

    if (activeTypewriterTimeout) clearTimeout(activeTypewriterTimeout);
    if (tonePollInterval) clearInterval(tonePollInterval);
    tonePollInterval = null;
    toneGenHasSeenGenerating = false;
    toneGenRevealStarted = false;

    titleEl.innerText = `PRISM - Generazione in corso [${toneKey.toUpperCase()}]...`;
    textEl.innerHTML = '';
    assetsEl.innerHTML = '';

    resetWorkspaceSidebarState();
    applyOutputModalToneTheme(toneKey);
    if (modalBox) {
        modalBox.style.width = '750px';
        modalBox.classList.remove('completed-glow');
        modalBox.style.overflowY = 'hidden';
    }

    openToneGenPrismLoader(TONE_GEN_STEP_LABELS.generation, 0.90);
    modal.style.display = 'flex';
    renderModalToneSwitcher(toneKey);
    await ensureModalToneSwitcherReady(toneKey);

    try {
        if (!userData.userId || !userData.companyId) {
            throw new Error('Profilo utente non sincronizzato. Attendi il caricamento o ricarica la pagina.');
        }

        const payload = buildInitialToneSurgicalPayload({
            userId: userData.userId,
            companyId: userData.companyId,
            jobId,
            toneKey,
            piattaforma: options.piattaforma,
            linguaOutput: options.linguaOutput
        });

        console.log('[PRISM] Avvio generazione tono:', {
            tono: payload.tono,
            piattaforma: payload.piattaforma,
            linguaOutput: payload.linguaOutput,
            jobId: payload.jobId
        });

        const result = await invokeToneSurgicalGeneration(payload);
        const apiContent = result.contenutoGenerato;

        if (apiContent && String(apiContent).trim()) {
            toneGenHasSeenGenerating = true;
            await finalizeToneGenerationReveal(toneKey, jobId, modalBox, titleEl, textEl, apiContent);
            return;
        }

        await pollToneGenerationOnce(toneKey, jobId, userData.userId, BACKEND_URL, modalBox, titleEl, textEl);

        tonePollInterval = setInterval(async () => {
            try {
                const done = await pollToneGenerationOnce(toneKey, jobId, userData.userId, BACKEND_URL, modalBox, titleEl, textEl);
                if (done && tonePollInterval) {
                    clearInterval(tonePollInterval);
                    tonePollInterval = null;
                }
            } catch (pollErr) {
                console.warn('⚠️ [PRISM F4] Polling transitorio:', pollErr.message);
            }
        }, 2000);

    } catch (error) {
        modal.style.display = 'none';
        hideToneGenPrismLoader();
        modalToneSwitcherBusy = false;
        renderModalToneSwitcher(currentActiveToneKey);
        console.error('🚨 [PRISM GENERATION ERROR]:', error.message);
        showPrismErrorSafe(error.message || 'Errore di connessione o generazione.', { title: 'Errore di generazione' });
    }
}

/**
 * Gestisce l'effetto typewriter saltando i tag HTML per evitare sfarfallii visivi o stampe di codice grezzo.
 */
function typewriterHTML(element, html, speed, callback) {
    if (!element) { if (callback) callback(); return; } // target mancante
    let currentHtml = ''; // HTML accumulato carattere per carattere
    let i = 0; // indice posizione nella stringa

    function step() {
        if (i < html.length) { // caratteri rimanenti
            if (html[i] === '<') { // inizio tag HTML
                const endTagIndex = html.indexOf('>', i); // fine tag
                if (endTagIndex !== -1) { // tag completo trovato
                    currentHtml += html.substring(i, endTagIndex + 1); // inietta tag intero
                    i = endTagIndex + 1; // salta oltre il tag
                } else { // tag malformato
                    currentHtml += html[i]; // aggiungi carattere singolo
                    i++; // avanza
                }
            } else { // carattere testo normale
                currentHtml += html[i]; // aggiungi carattere
                i++; // avanza
            }
            element.innerHTML = currentHtml; // renderizza HTML parziale
            activeTypewriterTimeout = setTimeout(step, speed); // prossimo carattere
        } else { // scrittura completata
            if (callback) callback(); // callback post-typewriter
        }
    }
    step(); // avvia loop
}

/**
 * Renderizza i riferimenti media (immagini) sotto il testo del post.
 */
function renderToneAssetsAndActions(toneKey) {
    const assetsEl = document.getElementById('modal-tone-assets');
    if (!assetsEl) return;

    let mediaGalleryHtml = "";
    if (globalCacheMedia.verifiedImages && globalCacheMedia.verifiedImages.length > 0) {
        mediaGalleryHtml += `<div style="margin-top:20px; border-top:1px solid #27272a; padding-top:10px;"><h4 style="color:#3b82f6; font-size:11px; margin-bottom:10px;">📸 MEDIA RIFERIMENTO</h4><div style="display:flex; gap:10px; overflow-x:auto; padding-bottom:10px;">`;
        globalCacheMedia.verifiedImages.forEach(img => {
            const url = typeof img === 'string' ? img : img.url;
            mediaGalleryHtml += `<img src="${url}" style="height:100px; border-radius:6px; border:1px solid #27272a;">`;
        });
        mediaGalleryHtml += `</div></div>`;
    }

    assetsEl.innerHTML = mediaGalleryHtml;
}

window.regenerateCurrentTone = function() {
    const jobId = sessionStorage.getItem('prism_last_job_id');
    if (!jobId || !currentActiveToneKey) {
        return showPrismErrorSafe('Impossibile rigenerare: sessione analisi non valida.');
    }

    generateSingleToneWithInteractivePrism(currentActiveToneKey, jobId, {
        piattaforma: getSelectedDashboardPlatform(),
        linguaOutput: getSelectedDashboardLanguage()
    });
};

// ==========================================
// 7. UTILITY ESTRATTORE E MODALE
// ==========================================

function extractAllDatabaseAssets(data) {
    if (!data) return { images: [], sources: [] };
    const target = data.testo ? data.testo : (data.data ? data.data : data);
    const assets = { images: [], sources: [] };
    if (target.media_support) assets.images = target.media_support.verified_images || target.media_support.verifiedImages || [];
    else if (data.media_support) assets.images = data.media_support.verified_images || [];
    assets.sources = target.sources_preview || target.sourcesPreview || [];
    return assets;
}

/**
 * Mostra la modale con contenuto tono già recuperato da Firestore.
 */
async function displayToneModal(toneKey, toneText) {
    currentActiveToneKey = toneKey;
    if (!toneText || !toneText.trim()) {
        showPrismErrorSafe('Contenuto del tono non disponibile su Firestore.', { title: 'Contenuto non trovato' });
        return false;
    }

    const modal = document.getElementById('output-modal');
    const modalBox = document.getElementById('output-modal-box');
    const prismBg = document.getElementById('tone-gen-prism-loader');
    const titleEl = document.getElementById('modal-tone-title');
    const textEl = document.getElementById('modal-tone-text');
    const assetsEl = document.getElementById('modal-tone-assets');

    if (activeTypewriterTimeout) clearTimeout(activeTypewriterTimeout);

    resetWorkspaceSidebarState();

    applyOutputModalToneTheme(toneKey);
    modalToneSwitcherBusy = false;

    renderModalToneSwitcher(toneKey);

    titleEl.innerText = `PRISM - Contenuto [${toneKey.toUpperCase()}]`;

    const richHTMLContent = parseAndCleanContentForModal(toneText);
    textEl.innerHTML = `<div style="color: #e4e4e7; font-size: 15px; line-height: 1.7; white-space: pre-wrap;">${richHTMLContent}</div>`;
    if (assetsEl) assetsEl.innerHTML = '';

    if (prismBg) {
        prismBg.style.opacity = '0';
        prismBg.style.display = 'none';
    }
    if (modalBox) {
        modalBox.style.width = '950px';
        modalBox.classList.add('completed-glow');
        modalBox.style.overflowY = 'auto';
    }

    markToneAsGenerated(toneKey, true);
    await ensureModalToneSwitcherReady(toneKey);
    renderToneAssetsAndActions(toneKey);
    modal.style.display = 'flex';
    triggerUserGuidePhase5IfNeeded();
    return true;
}

/**
 * Apre la modale recuperando sempre l'ultima versione del tono da Firestore.
 */
window.openToneModal = async function(toneKey) {
    const jobId = sessionStorage.getItem('prism_last_job_id');
    if (!jobId) {
        showPrismErrorSafe('Sessione analisi non valida. Avvia prima l\'analisi.', { title: 'Sessione non valida' });
        return false;
    }

    const card = document.querySelector(`.tone-card[data-key="${toneKey}"]`);
    if (card) card.classList.add('tone-loading');

    try {
        const resolved = await resolveToneContentFromFirestore(jobId, toneKey);
        if (resolved.status === 'error') {
            showPrismErrorSafe(resolved.message, { title: 'Errore recupero contenuto' });
            return false;
        }
        if (resolved.status === 'missing') {
            showPrismErrorSafe('Contenuto del tono non trovato su Firestore.', { title: 'Contenuto non trovato' });
            return false;
        }
        return await displayToneModal(toneKey, resolved.text);
    } catch (err) {
        console.error('❌ [PRISM OPEN TONE] Errore imprevisto:', err);
        showPrismErrorSafe(err.message || 'Errore imprevisto durante l\'apertura del tono.', { title: 'Errore' });
        return false;
    } finally {
        if (card) card.classList.remove('tone-loading');
    }
};

window.closeToneModal = function() { 
    document.getElementById('output-modal').style.display = 'none';
    if (userGuideCurrentPhase === 5) hideUserGuide();
    if (activeTypewriterTimeout) clearTimeout(activeTypewriterTimeout);
    if (pollInterval) clearInterval(pollInterval);
    if (tonePollInterval) clearInterval(tonePollInterval);
    tonePollInterval = null;
    resetWorkspaceSidebarState();
};

function parseAndCleanContentForModal(text) {
    if (!text) return "";
    return text.replace(/\[(TITOLO|GANCIO|HOOK|EPILOGO|FONTI|HASHTAG|TESTO|NOTE|TAG|CONTESTO|POST|ANALISI)\]/gi, (match) => {
        return `<span style="color: #3b82f6; font-weight: 700; font-size: 12px; display: block; margin-top: 18px; margin-bottom: 6px; text-transform: uppercase;">${match}</span>`;
    });
}

window.selP = function(el) {
    if (dashboardPlatformLocked) return;
    document.querySelectorAll('#settingsRow .platform-pill .pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
};

window.selLang = function(el) {
    if (dashboardLanguageLocked) return;
    document.querySelectorAll('#settingsRow .lang-pill .pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
};

// ==========================================
// 8. LOGICA WORKSPACE STRUMENTI (SIDEBAR & EXTENSION PANELS)
// ==========================================

function resetWorkspaceSidebarState() {
    const sidebar = document.getElementById('modal-sidebar');
    const extensionPane = document.getElementById('sidebar-extension-pane');
    const extensionBody = document.getElementById('sidebar-extension-body');
    const regenContent = document.getElementById('regen-options');
    const regenArrow = document.getElementById('arrow-regen-options');

    closeSidebarExtension();
    if (sidebar) sidebar.classList.remove('sidebar-collapsed', 'sidebar-expanded');
    if (extensionBody) extensionBody.innerHTML = '';
    if (extensionPane) extensionPane.classList.remove('active');
    if (regenContent) regenContent.style.maxHeight = '0px';
    if (regenArrow) regenArrow.classList.remove('open');
}

window.toggleSidebarCollapse = function() {
    const sidebar = document.getElementById('modal-sidebar');
    const modalBox = document.getElementById('output-modal-box');
    if (!sidebar || !modalBox?.classList.contains('completed-glow')) return;

    sidebar.classList.toggle('sidebar-collapsed');
    if (sidebar.classList.contains('sidebar-collapsed')) closeSidebarExtension();
};

window.toggleSidebarGroup = function(groupId) {
    const content = document.getElementById(groupId);
    const arrow = document.getElementById(`arrow-${groupId}`);
    if (!content) return;

    if (content.style.maxHeight && content.style.maxHeight !== '0px') {
        content.style.maxHeight = '0px';
        if (arrow) arrow.classList.remove('open');
    } else {
        content.style.maxHeight = content.scrollHeight + 'px';
        if (arrow) arrow.classList.add('open');
    }
};

window.copyModalText = function() {
    const textEl = document.getElementById('modal-tone-text');
    const toast = document.getElementById('workspace-copy-toast');
    if (!textEl) return;

    const textToCopy = textEl.innerText || textEl.textContent;

    navigator.clipboard.writeText(textToCopy).then(() => {
        if (toast) {
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
        }
    }).catch(err => {
        console.error("Errore di copia negli appunti:", err);
    });
};

function buildOverlayPlatformPillsHtml() {
    const currentPlatform = document.querySelector('#settingsRow .platform-pill .pill.active')?.innerText.trim() || 'LinkedIn';
    const platforms = [
        { label: 'Facebook', html: '<i class="fab fa-facebook"></i> Facebook' },
        { label: 'LinkedIn', html: '<i class="fab fa-linkedin"></i> LinkedIn' },
        { label: 'X', html: 'X' }
    ];
    return platforms.map((p) => {
        const activeClass = p.label === currentPlatform ? ' active' : '';
        return `<div class="pill${activeClass}" onclick="selOverlayP(this)">${p.html}</div>`;
    }).join('');
}

function buildOverlayLanguagePillsHtml() {
    const currentLang = getSelectedDashboardLanguage();
    const languages = [
        { id: 'italiano', flag: '🇮🇹', label: 'Italiano' },
        { id: 'english', flag: '🇬🇧', label: 'English' }
    ];
    return languages.map((lang) => {
        const activeClass = lang.id === currentLang ? ' active' : '';
        return `<div class="pill lang-pill-option${activeClass}" data-lang="${lang.id}" onclick="selOverlayLang(this)"><span class="lang-flag" aria-hidden="true">${lang.flag}</span> ${lang.label}</div>`;
    }).join('');
}

function getSelectedOverlayLanguage() {
    const active = document.querySelector('.overlay-lang-pill .pill.active');
    return active?.getAttribute('data-lang') || getSelectedDashboardLanguage();
}

window.openSidebarExtension = function(toolType) {
    const sidebar = document.getElementById('modal-sidebar');
    const extensionPane = document.getElementById('sidebar-extension-pane');
    const body = document.getElementById('sidebar-extension-body');
    if (!sidebar || !extensionPane || !body) return;

    if (sidebar.classList.contains('sidebar-collapsed')) {
        sidebar.classList.remove('sidebar-collapsed');
    }

    sidebar.classList.add('sidebar-expanded');
    extensionPane.classList.add('active');

    if (toolType === 'total-regen') {
        body.innerHTML = `
            <h4 style="font-size:12px; color:#fff; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">Rigenerazione totale</h4>
            <p style="font-size:12px; color:var(--text-dim); margin-bottom:4px; line-height:1.5;">Seleziona piattaforma e lingua del contenuto.</p>
            <div class="overlay-platform-pill">
                ${buildOverlayPlatformPillsHtml()}
            </div>
            <p style="font-size:11px; color:var(--text-dim); margin:0 0 4px; text-transform:uppercase; letter-spacing:0.5px;">Lingua</p>
            <div class="overlay-lang-pill">
                ${buildOverlayLanguagePillsHtml()}
            </div>
            <button class="overlay-action-btn" onclick="executeSurgicalRegen('total')">Rigenera <i class="fas fa-bolt"></i></button>
        `;
    } else if (toolType === 'instructions-regen') {
        body.innerHTML = `
            <h4 style="font-size:12px; color:#fff; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">Con istruzioni</h4>
            <p style="font-size:12px; color:var(--text-dim); line-height:1.5;">Indicazioni specifiche per PRISM (max 100 caratteri).</p>
            <textarea class="overlay-textarea" id="overlay-instructions-input" maxlength="100" placeholder="Es. aggiungi emoji, rendilo più formale..." oninput="updateOverlayCharCounter(this)"></textarea>
            <div class="overlay-char-counter" id="overlay-chars-left">100 caratteri rimasti</div>
            <button class="overlay-action-btn" onclick="executeSurgicalRegen('instructions')">Rigenera <i class="fas fa-bolt"></i></button>
        `;
    } else if (toolType === 'compare-versions') {
        body.innerHTML = `
            <h4 style="font-size:12px; color:#fff; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">Confronta versioni</h4>
            <p style="font-size:12px; color:var(--text-dim); margin-bottom:12px; line-height:1.5;">Vista affiancata per confrontare le modifiche storiche.</p>
            <div style="border: 1px dashed #27272a; padding: 30px 20px; border-radius: 8px; text-align: center; color: var(--text-dim); font-size:12px; min-height: 120px; display:flex; align-items:center; justify-content:center;">
                Funzionalità in arrivo con la prossima versione
            </div>
        `;
    }
};

window.closeSidebarExtension = function() {
    const sidebar = document.getElementById('modal-sidebar');
    const extensionPane = document.getElementById('sidebar-extension-pane');
    const body = document.getElementById('sidebar-extension-body');

    if (sidebar) sidebar.classList.remove('sidebar-expanded');
    if (extensionPane) extensionPane.classList.remove('active');
    if (body) body.innerHTML = '';
};

window.selOverlayP = function(el) {
    const container = el.closest('.overlay-platform-pill');
    if (!container) return;
    container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
};

window.selOverlayLang = function(el) {
    const container = el.closest('.overlay-lang-pill');
    if (!container) return;
    container.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
};

window.updateOverlayCharCounter = function(textarea) {
    const counter = document.getElementById('overlay-chars-left');
    if (!counter) return;
    const remaining = 100 - textarea.value.length;
    counter.innerText = `${remaining} caratteri rimasti`;
    counter.classList.toggle('low-chars', remaining <= 10);
};

window.executeSurgicalRegen = function(type) {
    let platformLabel = document.querySelector('#settingsRow .platform-pill .pill.active')?.innerText.trim() || 'LinkedIn';
    let language = getSelectedDashboardLanguage();

    if (type === 'total') {
        const overlayPlatform = document.querySelector('.overlay-platform-pill .pill.active');
        if (overlayPlatform) platformLabel = overlayPlatform.innerText.trim();
        language = getSelectedOverlayLanguage();
    }

    const instructions = document.getElementById('overlay-instructions-input')?.value.trim() || '';
    console.log(`[PRISM] Rigenerazione innescata — modalità: ${type}, piattaforma: ${platformLabel}, lingua: ${language}, istruzioni: ${instructions || '(nessuna)'}`);

    closeSidebarExtension();

    const jobId = sessionStorage.getItem('prism_last_job_id');
    if (!jobId || !currentActiveToneKey) {
        return showPrismErrorSafe('Impossibile rigenerare: sessione analisi non valida.');
    }

    generateSingleToneWithInteractivePrism(currentActiveToneKey, jobId, {
        piattaforma: normalizePlatformLabelToApi(platformLabel),
        linguaOutput: language
    });
};

// ==========================================
// 9. USER GUIDE ONBOARDING (FREEMIUM — user_guide: true)
// ==========================================

const USER_GUIDE_TEXTS = {
    1: "Benvenuto su PRISM! Inserisci qui lo spunto del tuo post. Può essere un'idea abbozzata, un fatto di cronaca o un concetto grezzo.",
    2: "Ottimo. Ora clicca su ANALIZZA. PRISM cercherà le fonti più autorevoli in tempo reale e preparerà i fatti per la scrittura.",
    4: "La rifrazione è pronta. Scegli una piattaforma e uno dei 7 toni in basso per vedere il Prisma in azione e generare il tuo post specifico per Facebook, LinkedIn o X. Avrai a disposizione anche lo Split-View per confrontare le modifiche!",
    5: "Ecco la tua rifrazione! Usa lo Split-View per confrontare le modifiche se chiedi una rigenerazione. Trovi le fonti inespresse nel Pannello Strategico in basso."
};

let userGuideTargetEl = null;

function initUserGuide() {
    if (!userGuideActive) return;

    const cancelBtn = document.getElementById('guide-btn-cancel');
    const confirmBtn = document.getElementById('guide-btn-confirm');
    if (cancelBtn && !cancelBtn.dataset.bound) {
        cancelBtn.dataset.bound = '1';
        cancelBtn.addEventListener('click', dismissUserGuideTemporary);
    }
    if (confirmBtn && !confirmBtn.dataset.bound) {
        confirmBtn.dataset.bound = '1';
        confirmBtn.addEventListener('click', dismissUserGuidePermanent);
    }

    attachGuidePositionListener();

    const text = topicInputTextarea?.value || '';
    if (isTopicReadyForAnalyze(text)) {
        showUserGuidePhase(2);
    } else {
        showUserGuidePhase(1);
    }
}

function getUserGuideTarget(phase) {
    if (phase === 1) return document.querySelector('.input-box');
    if (phase === 2) return document.getElementById('mainGenBtn');
    if (phase === 4) return document.querySelector('.tones-grid');
    if (phase === 5) return document.getElementById('modal-sidebar') || document.getElementById('output-modal-box');
    return null;
}

function getUserGuidePlacement(phase) {
    if (phase === 1) return 'bottom';
    if (phase === 2) return 'left';
    if (phase === 4) return 'bottom';
    if (phase === 5) return 'left';
    return 'bottom';
}

function markGuideInteractiveZones(phase) {
    clearGuideInteractiveZones();
    if (phase === 2) {
        ['.input-flex-container', '.side-actions'].forEach((selector) => {
            const el = document.querySelector(selector);
            if (el) {
                el.classList.add('guide-interactive-zone');
                userGuideInteractiveEls.push(el);
            }
        });
        return;
    }
    if (phase !== 4) return;

    ['.input-flex-container', '.settings-row', '.tones-grid'].forEach((selector) => {
        const el = document.querySelector(selector);
        if (el) {
            el.classList.add('guide-interactive-zone');
            userGuideInteractiveEls.push(el);
        }
    });
}

function clearGuideInteractiveZones() {
    userGuideInteractiveEls.forEach((el) => el.classList.remove('guide-interactive-zone'));
    userGuideInteractiveEls = [];
}

function getProtectedGuideRects() {
    const selectors = [
        'textarea',
        'button',
        '.input-box',
        '.side-actions',
        '.settings-row',
        '.tone-card',
        '.credits-footer'
    ];
    const rects = [];
    const callout = document.getElementById('user-guide-callout');

    selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
            if (callout && (el === callout || callout.contains(el))) return;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) rects.push(rect);
        });
    });

    return rects;
}

function calloutOverlapsProtected(top, left, width, height, margin = 10) {
    const callout = {
        top: top - margin,
        left: left - margin,
        right: left + width + margin,
        bottom: top + height + margin
    };

    return getProtectedGuideRects().some((rect) => !(
        callout.right < rect.left ||
        callout.left > rect.right ||
        callout.bottom < rect.top ||
        callout.top > rect.bottom
    ));
}

function computeCalloutPosition(target, placement, calloutWidth, calloutHeight) {
    const rect = target.getBoundingClientRect();
    const gap = 16;
    let top = 0;
    let left = 0;

    if (placement === 'bottom') {
        top = rect.bottom + gap;
        left = rect.left + (rect.width / 2) - (calloutWidth / 2);
    } else if (placement === 'top') {
        top = rect.top - calloutHeight - gap;
        left = rect.left + (rect.width / 2) - (calloutWidth / 2);
    } else if (placement === 'left') {
        top = rect.top + (rect.height / 2) - (calloutHeight / 2);
        left = rect.left - calloutWidth - gap;
    } else if (placement === 'right') {
        top = rect.top + (rect.height / 2) - (calloutHeight / 2);
        left = rect.right + gap;
    }

    return { top, left };
}

function resolveCalloutPosition(target, placement, calloutWidth, calloutHeight) {
    const pad = 12;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    let { top, left } = computeCalloutPosition(target, placement, calloutWidth, calloutHeight);

    const shifts = [
        { top: 0, left: 0 },
        { top: 18, left: 0 },
        { top: 36, left: 0 },
        { top: -18, left: 0 },
        { top: 0, left: 24 },
        { top: 0, left: -24 },
        { top: 18, left: 24 },
        { top: 18, left: -24 },
        { top: 36, left: 48 },
        { top: 36, left: -48 }
    ];

    for (const shift of shifts) {
        let candidateTop = top + shift.top;
        let candidateLeft = left + shift.left;

        candidateLeft = Math.max(pad, Math.min(candidateLeft, viewportW - calloutWidth - pad));
        candidateTop = Math.max(pad, Math.min(candidateTop, viewportH - calloutHeight - pad));

        if (!calloutOverlapsProtected(candidateTop, candidateLeft, calloutWidth, calloutHeight)) {
            return { top: candidateTop, left: candidateLeft };
        }
    }

    left = Math.max(pad, Math.min(left, viewportW - calloutWidth - pad));
    top = Math.max(pad, Math.min(top, viewportH - calloutHeight - pad));
    return { top, left };
}

function attachGuidePositionListener() {
    if (userGuidePositionHandler) return;
    userGuidePositionHandler = () => {
        if (userGuideCurrentPhase > 0 && userGuideTargetEl) {
            positionUserGuideCallout(userGuideTargetEl, getUserGuidePlacement(userGuideCurrentPhase));
        }
    };
    window.addEventListener('resize', userGuidePositionHandler);
    window.addEventListener('scroll', userGuidePositionHandler, true);
}

function showUserGuidePhase(phase) {
    if (!userGuideActive) return;

    const target = getUserGuideTarget(phase);
    if (!target) {
        if (phase === 4) setTimeout(() => showUserGuidePhase(4), 400);
        return;
    }

    hideUserGuide(false);
    userGuideCurrentPhase = phase;

    const overlay = document.getElementById('user-guide-overlay');
    const callout = document.getElementById('user-guide-callout');
    const textEl = document.getElementById('user-guide-callout-text');
    if (!overlay || !callout || !textEl) return;

    userGuideTargetEl = target;
    target.classList.add('guide-target-highlight');
    userGuideHighlightedEl = target;

    if (phase === 1 || phase === 2) {
        const inputBox = document.querySelector('.input-box');
        if (inputBox) {
            inputBox.classList.add('guide-textarea-accessible');
            userGuideTextareaEl = inputBox;
        }
    }

    if (phase === 4) {
        overlay.classList.add('guide-overlay-usable');
        markGuideInteractiveZones(4);
    } else if (phase === 2) {
        overlay.classList.remove('guide-overlay-usable');
        markGuideInteractiveZones(2);
    } else {
        overlay.classList.remove('guide-overlay-usable');
        clearGuideInteractiveZones();
    }

    textEl.textContent = USER_GUIDE_TEXTS[phase] || '';
    const placement = getUserGuidePlacement(phase);
    callout.setAttribute('data-placement', placement);
    callout.setAttribute('data-phase', String(phase));
    callout.classList.toggle('has-actions', phase === 5);

    if (phase === 4) {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setTimeout(() => positionUserGuideCallout(target, placement), 400);
    } else {
        positionUserGuideCallout(target, placement);
    }

    requestAnimationFrame(() => {
        overlay.classList.add('active');
        callout.classList.add('active');
        positionUserGuideCallout(target, placement);
    });
}

function positionUserGuideCallout(target, placement) {
    const callout = document.getElementById('user-guide-callout');
    if (!callout || !target) return;

    callout.style.visibility = 'hidden';
    callout.style.display = 'block';

    const calloutRect = callout.getBoundingClientRect();
    const cw = calloutRect.width || 320;
    const ch = calloutRect.height || 120;

    const { top, left } = resolveCalloutPosition(target, placement, cw, ch);

    callout.style.top = `${top}px`;
    callout.style.left = `${left}px`;
    callout.style.visibility = '';
}

function hideUserGuide(clearPhase = true) {
    const overlay = document.getElementById('user-guide-overlay');
    const callout = document.getElementById('user-guide-callout');

    if (overlay) {
        overlay.classList.remove('active', 'guide-overlay-usable');
    }
    if (callout) {
        callout.classList.remove('active', 'has-actions');
        callout.removeAttribute('data-phase');
    }

    clearGuideInteractiveZones();

    if (userGuideHighlightedEl) {
        userGuideHighlightedEl.classList.remove('guide-target-highlight');
        userGuideHighlightedEl = null;
    }

    if (userGuideTextareaEl) {
        userGuideTextareaEl.classList.remove('guide-textarea-accessible');
        userGuideTextareaEl = null;
    }

    userGuideTargetEl = null;
    if (clearPhase) userGuideCurrentPhase = 0;
}

function triggerUserGuidePhase5IfNeeded() {
    if (!userGuideActive || !userGuideAwaitingPhase5) return;
    setTimeout(() => showUserGuidePhase(5), 550);
}

function dismissUserGuideTemporary() {
    hideUserGuide(false);
    userGuideCurrentPhase = 0;
}

async function dismissUserGuidePermanent() {
    const userId = currentUserSessionData.userId || sessionStorage.getItem('prism_user_uid');
    if (!userId || !window.db) return;

    try {
        await window.db.collection('users').doc(userId).update({
            user_guide: false,
            updated_at: firebase.firestore.FieldValue.serverTimestamp()
        });
        userGuideActive = false;
        userGuideAwaitingPhase5 = false;
        hideUserGuide();
        console.log('✅ [GUIDE] user_guide disattivato per', userId);
    } catch (err) {
        console.error('❌ [GUIDE] Errore aggiornamento user_guide:', err.message);
        if (typeof window.showPrismError === 'function') {
            window.showPrismError('Impossibile salvare la preferenza. Riprova.');
        }
    }
}
