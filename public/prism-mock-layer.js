/**
 * =============================================================================
 * PRISM MOCK LAYER (frontend-only)
 * =============================================================================
 * Simula backend + persistenza Firestore SENZA chiamare API/worker reali.
 *
 * Isolamento:
 * - Attivo SOLO se window.PRISM_USE_MOCK (iniettato da .env via server) è true/1/yes
 * - Con flag OFF: questo file non intercetta nulla e non scrive su Firestore
 * - Job mock: ID obbligatoriamente "mock_<uuid>" + campo isMock: true
 *
 * Contratto HTTP intercettato (solo con mock ON):
 * - POST /api/prepare-shaping
 * - GET  /jobs/status/:userId/:jobId
 * - POST /api/regenerate-tone-surgical
 *
 * Approccio B (blueprint §6): Map in-memory per polling; flush su Firestore a completed / regen.
 * =============================================================================
 */
(function prismMockLayerIIFE(global) {
    // -------------------------------------------------------------------------
    // Namespace globale isolato (non collidere con dashboard.js)
    // -------------------------------------------------------------------------
    var PrismMock = global.PrismMock || {}; // crea o riusa namespace mock
    global.PrismMock = PrismMock; // espone namespace su window

    // -------------------------------------------------------------------------
    // Catalogo toni PRISM (allineato a stateManager.TONE_IDS)
    // -------------------------------------------------------------------------
    var PRISM_TONE_CATALOG = [ // elenco slug tono noti
        'provocatore', // tono provocatore
        'confidente', // tono confidente
        'sferzante', // tono sferzante
        'visionario', // tono visionario
        'metodologico', // tono metodologico
        'narratore', // tono narratore
        'promotore' // tono promotore
    ]; // fine catalogo

    // -------------------------------------------------------------------------
    // Toni sempre ON nel mock (blueprint §5.2)
    // -------------------------------------------------------------------------
    var ALWAYS_ON_TONES = { // set logico toni sempre disponibili
        confidente: true, // confidente mai OFF
        narratore: true // narratore mai OFF
    }; // fine ALWAYS_ON

    // -------------------------------------------------------------------------
    // Store in-memory dei job mock (mirror leggero di Redis)
    // -------------------------------------------------------------------------
    var mockJobsById = new Map(); // Map<jobId, jobState>

    // -------------------------------------------------------------------------
    // Riferimento al fetch nativo / già wrappato (error logging dashboard)
    // -------------------------------------------------------------------------
    var previousFetch = global.fetch ? global.fetch.bind(global) : null; // salva fetch precedente

    // -------------------------------------------------------------------------
    // Flag: true se l'interceptor fetch è già installato
    // -------------------------------------------------------------------------
    var fetchInterceptorInstalled = false; // evita doppia installazione

    /**
     * Legge e normalizza il feature flag mock.
     * Variabile documentata per questo stack Express+EJS: PRISM_USE_MOCK
     * (equivalente blueprint a VITE_PRISM_USE_MOCK / NEXT_PUBLIC_PRISM_USE_MOCK).
     * Valori accettati: true | 1 | yes (case-insensitive).
     * @returns {boolean}
     */
    function isPrismMockEnabled() {
        // sorgente primaria: window.PRISM_USE_MOCK iniettata dal server da .env
        var rawPrimary = global.PRISM_USE_MOCK; // valore grezzo primario
        // fallback opzionale: FIREBASE_ENV.prismUseMock se qualcuno lo setta in config
        var rawFallback = global.FIREBASE_ENV && global.FIREBASE_ENV.prismUseMock; // fallback config
        // scegli primario se definito, altrimenti fallback
        var raw = (rawPrimary !== undefined && rawPrimary !== null) ? rawPrimary : rawFallback; // valore scelto
        // normalizza a stringa trim lower
        var v = (raw === undefined || raw === null) ? '' : String(raw).trim().toLowerCase(); // stringa normalizzata
        // true solo per true/1/yes
        return v === 'true' || v === '1' || v === 'yes'; // esito boolean
    } // fine isPrismMockEnabled

    /**
     * Crea un jobId mock obbligatoriamente prefissato con "mock_".
     * @returns {string}
     */
    function createMockJobId() {
        // genera UUID v4 tramite Web Crypto API del browser
        var uuid = (global.crypto && typeof global.crypto.randomUUID === 'function') // crypto disponibile?
            ? global.crypto.randomUUID() // UUID standard
            : ( // fallback se randomUUID assente
                'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { // template uuid
                    var r = (Math.random() * 16) | 0; // nibble random
                    var v = c === 'x' ? r : ((r & 0x3) | 0x8); // regola UUID v4
                    return v.toString(16); // hex
                }) // fine replace
            ); // fine fallback
        return 'mock_' + uuid; // prefisso obbligatorio mock_
    } // fine createMockJobId

    /**
     * True se jobId inizia con "mock_" (case-insensitive).
     * @param {string} jobId
     * @returns {boolean}
     */
    function isMockJobId(jobId) {
        // normalizza a stringa lower e verifica prefisso
        return String(jobId == null ? '' : jobId).toLowerCase().startsWith('mock_'); // check prefisso
    } // fine isMockJobId

    /**
     * Timestamp Firestore nativo; fallback ISO se Firebase non pronto.
     * @returns {*}
     */
    function fsNow() {
        // usa Timestamp nativo Firebase se disponibile (contratto backend)
        if (global.firebase && global.firebase.firestore && global.firebase.firestore.Timestamp) { // Firebase ok?
            return global.firebase.firestore.Timestamp.now(); // Timestamp nativo
        } // fine if Timestamp
        // fallback: stringa ISO (solo se FS non inizializzato — raro)
        return new Date().toISOString(); // ISO fallback
    } // fine fsNow

    /**
     * Normalizza piattaforma a LinkedIn | Facebook | X.
     * @param {string} platform
     * @returns {string}
     */
    function normalizePlatform(platform) {
        // lower per matching
        var p = String(platform == null ? '' : platform).trim().toLowerCase(); // normalizza input
        // mappa alias comuni
        if (p === 'facebook' || p === 'fb') return 'Facebook'; // Facebook
        if (p === 'x' || p === 'twitter' || p === 'tweet') return 'X'; // X
        if (p === 'linkedin' || p === 'li' || p === '') return 'LinkedIn'; // LinkedIn default
        // se già capitalizzato correttamente
        if (platform === 'LinkedIn' || platform === 'Facebook' || platform === 'X') return platform; // passthrough
        return 'LinkedIn'; // default sicuro
    } // fine normalizePlatform

    /**
     * Detect inputType text|url dal topic.
     * @param {string} topic
     * @returns {"text"|"url"}
     */
    function detectInputType(topic) {
        // trim topic
        var t = String(topic == null ? '' : topic).trim(); // testo topic
        // URL se inizia per http:// o https://
        if (/^https?:\/\//i.test(t)) return 'url'; // tipo url
        return 'text'; // tipo text
    } // fine detectInputType

    /**
     * Costruisce Response JSON compatibile con fetch.
     * @param {number} status
     * @param {object} body
     * @returns {Response}
     */
    function jsonResponse(status, body) {
        // serializza body
        var payload = JSON.stringify(body); // JSON string
        // Headers moderni se disponibili
        var headers = { 'Content-Type': 'application/json' }; // content-type JSON
        // Response nativa browser
        return new Response(payload, { status: status, headers: headers }); // Response fetch-like
    } // fine jsonResponse

    /**
     * Estrae URL stringa da argomento fetch (string | Request).
     * @param {*} input
     * @returns {string}
     */
    function resolveFetchUrl(input) {
        // se stringa diretta
        if (typeof input === 'string') return input; // URL string
        // se Request object
        if (input && typeof input.url === 'string') return input.url; // Request.url
        // fallback vuoto
        return ''; // non risolto
    } // fine resolveFetchUrl

    /**
     * Estrae method HTTP da fetch args.
     * @param {*} input
     * @param {object} init
     * @returns {string}
     */
    function resolveFetchMethod(input, init) {
        // method da init
        if (init && init.method) return String(init.method).toUpperCase(); // init.method
        // method da Request
        if (input && input.method) return String(input.method).toUpperCase(); // Request.method
        return 'GET'; // default GET
    } // fine resolveFetchMethod

    /**
     * Estrae body JSON da fetch init / Request.
     * @param {*} input
     * @param {object} init
     * @returns {Promise<object>}
     */
    async function resolveFetchJsonBody(input, init) {
        // body da init
        var raw = init && init.body != null ? init.body : null; // init.body
        // se assente prova Request.text
        if (raw == null && input && typeof input.clone === 'function') { // Request clonabile?
            try { // try read
                raw = await input.clone().text(); // testo body Request
            } catch (e) { // lettura fallita
                raw = null; // ignora
            } // fine catch
        } // fine if Request
        // se ancora null → oggetto vuoto
        if (raw == null || raw === '') return {}; // body vuoto
        // se già oggetto (raro)
        if (typeof raw === 'object' && !(typeof Blob !== 'undefined' && raw instanceof Blob)) { // object plain?
            return raw; // già oggetto
        } // fine if object
        // parse stringa JSON
        try { // try parse
            return JSON.parse(String(raw)); // parse JSON
        } catch (err) { // JSON invalido
            return {}; // fallback vuoto
        } // fine catch
    } // fine resolveFetchJsonBody

    /**
     * Match path API prepare-shaping (match permissivo su URL assoluti).
     * @param {string} url
     * @returns {boolean}
     */
    function isPrepareShapingUrl(url) {
        // stringa URL normalizzata
        var u = String(url || '').toLowerCase(); // lower
        // match se contiene il path API
        return u.indexOf('/api/prepare-shaping') !== -1; // contiene path
    } // fine isPrepareShapingUrl

    /**
     * Match path API regenerate-tone-surgical.
     * @param {string} url
     * @returns {boolean}
     */
    function isRegenerateToneUrl(url) {
        // stringa URL normalizzata
        var u = String(url || '').toLowerCase(); // lower
        // match se contiene il path API
        return u.indexOf('/api/regenerate-tone-surgical') !== -1; // contiene path
    } // fine isRegenerateToneUrl

    /**
     * Estrae userId/jobId da URL /jobs/status/:userId/:jobId
     * @param {string} url
     * @returns {{userId:string,jobId:string}|null}
     */
    function parseJobStatusUrl(url) {
        // regex cattura userId e jobId
        var m = String(url || '').match(/\/jobs\/status\/([^\/\?]+)\/([^\/\?]+)/i); // match path
        if (!m) return null; // non è status URL
        return { userId: decodeURIComponent(m[1]), jobId: decodeURIComponent(m[2]) }; // coppia ids
    } // fine parseJobStatusUrl

    /**
     * Generatore random pilastri (blueprint §5.1).
     * @param {string} topic
     * @returns {string[]}
     */
    function buildRandomPillars(topic) {
        // helper numero decimale 5.0–85.0
        var n = function () { return (Math.random() * 80 + 5).toFixed(1); }; // % random
        // helper intero formattato it-IT
        var m = function () { return Math.floor(Math.random() * 900000 + 10000).toLocaleString('it-IT'); }; // unità
        // topic sicuro in stringa
        var safeTopic = String(topic == null ? 'topic' : topic).slice(0, 120); // evita stringhe enormi
        // esattamente 3 stringhe con prefissi obbligatori
        return [ // array compressedFacts
            'SCENARIO: Su «' + safeTopic + '», nel 2026 si osservano ' + m() + ' unità rilevanti (+' + n() + '% annuo). Quota segmento leader: ' + n() + '%.', // pilastro 1
            'CONTESTO: La narrazione dominante su «' + safeTopic + '» insiste su modernizzazione e competitività, con cornice istituzionale e pressioni di mercato.', // pilastro 2
            'SFIDE_OPPORTUNITA: Il gap operativo su «' + safeTopic + '» richiede priorità chiare, scadenze misurabili e una leva di conversione credibile entro il 2026.' // pilastro 3
        ]; // fine return
    } // fine buildRandomPillars

    /**
     * Costruisce tones ON/OFF random solo su enabled_tones (blueprint §5.2).
     * Dopo prepare-shaping: solo idoneità — versions vuoto, nessun text root.
     * @param {string[]} enabledTones
     * @returns {object}
     */
    function buildRandomTones(enabledTones) {
        // oggetto tones risultante
        var tones = {}; // Record toneKey → meta
        // itera toni abilitati company
        (enabledTones || []).forEach(function (id) { // per ogni slug
            // default ON
            var status = 'ON'; // status iniziale
            var lock_reason = ''; // motivo lock vuoto
            // ~25% OFF se non ALWAYS_ON
            if (!ALWAYS_ON_TONES[id] && Math.random() < 0.25) { // probabilità OFF
                status = 'OFF'; // disabilita
                lock_reason = 'Mock: ' + id + ' non idoneo per questo topic'; // motivo mock
            } // fine if OFF
            // voce tono: solo status + lock_reason + versions[] (niente text/version/type root)
            tones[id] = { // meta tono post-shaping
                status: status, // ON|OFF
                lock_reason: lock_reason, // stringa lock
                versions: [] // nessun testo finché non parte F4
            }; // fine tones[id]
        }); // fine forEach
        return tones; // mappa toni
    } // fine buildRandomTones

    /**
     * Normalizza tones[toneKey].versions a array ordinato (array o mappa FS {0,1,...}).
     * @param {*} versions
     * @returns {Array}
     */
    function normalizeVersionsArray(versions) {
        // assente → vuoto
        if (!versions) return []; // nessuna versione
        // già array
        if (Array.isArray(versions)) return versions.filter(Boolean); // filtra null
        // mappa numerica Firestore
        if (typeof versions === 'object') { // object map
            return Object.keys(versions) // keys
                .sort(function (a, b) { return Number(a) - Number(b); }) // ordine indice
                .map(function (k) { return versions[k]; }) // values
                .filter(Boolean); // drop empty
        } // fine if object
        return []; // formato sconosciuto
    } // fine normalizeVersionsArray

    /**
     * Calcola nextVersion = (ultima.version ?? 0) + 1 (blueprint §4.2).
     * @param {Array} versionsArr
     * @returns {number}
     */
    function computeNextToneVersion(versionsArr) {
        // lista sicura
        var list = Array.isArray(versionsArr) ? versionsArr : []; // array
        // se vuota → 1
        if (list.length === 0) return 1; // prima generazione
        // ultima entry
        var last = list[list.length - 1]; // last
        // version numerica ultima
        var lastV = last && last.version != null ? Number(last.version) : 0; // n
        // se NaN → length come fallback
        if (!isFinite(lastV) || lastV < 0) lastV = list.length; // fallback
        return lastV + 1; // sequenziale
    } // fine computeNextToneVersion

    /**
     * Costruisce una entry versions[] (solo `text`, + platform/language) — blueprint §3.2/§4.2.
     * @param {object} opts
     * @returns {object}
     */
    function buildToneVersionEntry(opts) {
        // istruzioni trim
        var rawInstructions = String((opts && opts.instructions) || '').trim(); // istruzioni grezze
        // regeneratedWith: instructions se non vuote, altrimenti total
        var regeneratedWith = rawInstructions ? 'instructions' : 'total'; // enum
        // instructions max 100 char (blueprint §4.2)
        var instructions = rawInstructions ? rawInstructions.slice(0, 100) : ''; // cap 100
        // entry versione
        return { // versions[n]
            version: opts.nextVersion, // >= 1 sequenziale
            text: opts.text, // UNICO campo testo (mai `content`)
            platform: normalizePlatform(opts.platform), // LinkedIn|Facebook|X
            language: String(opts.language || 'italiano').trim(), // lingua output
            regeneratedWith: regeneratedWith, // total|instructions
            instructions: instructions, // "" se total
            createdAt: opts.createdAt // Timestamp FS (o ISO in memory)
        }; // fine entry
    } // fine buildToneVersionEntry

    /**
     * Genera testo tono random realistico (blueprint §5.3).
     * @param {object} opts
     * @returns {string}
     */
    function buildRandomToneText(opts) {
        // destructuring sicuro
        var toneKey = (opts && opts.toneKey) || 'tono'; // chiave tono
        var platform = (opts && opts.platform) || 'LinkedIn'; // piattaforma
        var language = (opts && opts.language) || 'italiano'; // lingua
        var topic = (opts && opts.topic) || 'argomento'; // topic
        var pillars = (opts && opts.pillars) || []; // pilastri
        // estrai numeri da SCENARIO se presenti
        var scenario = pillars[0] || ''; // stringa SCENARIO
        var nums = scenario.match(/[\d.,]+/g) || []; // numeri trovati
        var n1 = nums[0] || String(Math.floor(Math.random() * 50 + 10)); // numero 1
        var n2 = nums[1] || String((Math.random() * 20 + 1).toFixed(1)); // numero 2
        // paragrafi base (citano tono, piattaforma, lingua)
        var p1 = 'Nel tono «' + toneKey + '» per ' + platform + ' (lingua: ' + language + '), partiamo da «' + String(topic).slice(0, 80) + '» senza giri di parole.'; // intro
        var p2 = 'I dati di scenario parlano chiaro: ' + n1 + ' unità rilevanti e una dinamica intorno al ' + n2 + '% che non si può ignorare.'; // numeri
        var p3 = 'Il contesto impone una lettura operativa: modernizzazione, competitività e priorità misurabili entro il 2026.'; // contesto
        var p4 = 'Qui non serve un manifesto: serve una leva concreta, una scadenza e un messaggio che regga lo scroll su ' + platform + '.'; // corpo
        // chiusura per tono
        var closing = 'Quale priorità metti per prima? A) esecuzione rapida  B) posizionamento di lungo periodo.'; // default
        if (toneKey === 'promotore') { // CTA promotore
            closing = 'CTA: scegli una leva entro 7 giorni e misura il primo risultato entro 30.'; // CTA
        } else if (toneKey === 'sferzante') { // stacco sferzante
            closing = 'Basta alibi: o chiudi il gap, o resti spettatore. Punto.'; // stacco
        } else if (toneKey === 'confidente') { // chiusura confidente
            closing = 'Possiamo farlo con metodo: una priorità, una metrica, una deadline chiara.'; // confidente
        } else if (toneKey === 'visionario') { // chiusura visionario
            closing = 'Il 2026 non aspetta: chi inquadra oggi il vantaggio, domani lo scala.'; // visionario
        } else if (toneKey === 'metodologico') { // chiusura metodologico
            closing = 'Passi: 1) diagnosi 2) priorità 3) leva 4) misura. Ripeti.'; // metodologico
        } else if (toneKey === 'narratore') { // chiusura narratore
            closing = 'La storia che racconti oggi diventa il vantaggio che difendi domani.'; // narratore
        } else if (toneKey === 'provocatore') { // domanda A/B
            closing = 'Domanda secca: A) continui come ora  B) cambi una leva questa settimana. Cosa scegli?'; // provocatore
        } // fine chiusure
        // filler per lunghezza LinkedIn ~900–1400
        var filler = 'Annotazione mock PRISM [' + toneKey + '/' + platform + '/' + language + ']: testo locale senza worker Gemini.'; // meta mock
        var filler2 = 'Variabilità intenzionale seed=' + Math.floor(Math.random() * 100000) + ' — typewriter, Firestore versions, polling.'; // seed
        // unisci paragrafi
        var text = [p1, '', p2, '', p3, '', p4, '', closing, '', filler, '', filler2].join('\n'); // testo multi-paragrafo
        // se troppo corto aggiungi padding
        while (text.length < 900) { // soglia minima
            text += '\n\nEstensione mock per raggiungere lunghezza realistica su ' + platform + ' (' + text.length + ' char).'; // padding
        } // fine while
        // tronca se eccessivo
        if (text.length > 1400) text = text.slice(0, 1397) + '...'; // cap soft
        return text; // testo finale
    } // fine buildRandomToneText

    /**
     * Interseca enabled_tones company con catalogo PRISM.
     * @param {string[]} enabled
     * @returns {string[]}
     */
    function intersectEnabledTones(enabled) {
        // set catalogo
        var catalog = {}; // lookup
        PRISM_TONE_CATALOG.forEach(function (t) { catalog[t] = true; }); // popola
        // filtra
        var out = []; // risultato
        (enabled || []).forEach(function (t) { // per ogni enabled
            var key = String(t || '').trim().toLowerCase(); // normalizza
            if (catalog[key]) out.push(key); // tieni se in catalogo
        }); // fine forEach
        // se company senza toni → usa catalogo intero (dev-friendly)
        if (out.length === 0) return PRISM_TONE_CATALOG.slice(); // fallback catalogo
        return out; // intersezione
    } // fine intersectEnabledTones

    /**
     * Legge enabled_tones da companies/{companyId} (reale) con stub fallback.
     * @param {string} companyId
     * @returns {Promise<string[]>}
     */
    async function readEnabledTones(companyId) {
        // se manca db o companyId → stub catalogo
        if (!global.db || !companyId) { // guard
            console.warn('[PRISM MOCK] enabled_tones: fallback catalogo (db/companyId assenti)'); // warn
            return PRISM_TONE_CATALOG.slice(); // stub
        } // fine guard
        try { // try FS read
            var snap = await global.db.collection('companies').doc(String(companyId)).get(); // get company
            if (!snap.exists) { // company mancante
                console.warn('[PRISM MOCK] company non trovata, uso catalogo'); // warn
                return PRISM_TONE_CATALOG.slice(); // stub
            } // fine if !exists
            var data = snap.data() || {}; // data company
            var enabled = Array.isArray(data.enabled_tones) ? data.enabled_tones : []; // array toni
            return intersectEnabledTones(enabled); // intersezione
        } catch (err) { // errore permessi/rete
            console.warn('[PRISM MOCK] lettura enabled_tones fallita:', err && err.message); // warn
            return PRISM_TONE_CATALOG.slice(); // stub
        } // fine catch
    } // fine readEnabledTones

    /**
     * Costruisce shaping plan mock sui 3 pilastri.
     * @param {string} topic
     * @returns {Array}
     */
    function buildMockPlan(topic) {
        // topic corto per query
        var q = String(topic || '').slice(0, 60); // snippet
        return [ // plan array
            { pillar: 'SCENARIO', query: 'scenario metriche ' + q }, // query scenario
            { pillar: 'CONTESTO', query: 'contesto narrazione ' + q }, // query contesto
            { pillar: 'SFIDE_OPPORTUNITA', query: 'sfide opportunità ' + q } // query sfide
        ]; // fine plan
    } // fine buildMockPlan

    /**
     * Mappa tone_suitability da tones ON/OFF.
     * @param {object} tones
     * @returns {object}
     */
    function buildToneSuitability(tones) {
        // oggetto suitability
        var suit = {}; // record
        Object.keys(tones || {}).forEach(function (key) { // ogni tono
            suit[key] = { // entry
                status: tones[key].status, // ON|OFF
                lock_reason: tones[key].lock_reason || '' // motivo
            }; // fine entry
        }); // fine forEach
        return suit; // suitability
    } // fine buildToneSuitability

    /**
     * Scrive contents/{jobId} con set merge (contratto backend).
     * @param {string} jobId
     * @param {object} payload
     * @returns {Promise<void>}
     */
    async function writeContentDoc(jobId, payload) {
        // vietato scrivere se mock OFF (safety belt)
        if (!isPrismMockEnabled()) { // flag off
            console.error('[PRISM MOCK] writeContentDoc bloccata: mock OFF'); // errore
            return; // no-op
        } // fine guard flag
        // solo job mock_
        if (!isMockJobId(jobId)) { // id reale
            console.error('[PRISM MOCK] rifiuto scrittura su jobId non-mock:', jobId); // errore
            return; // no-op
        } // fine guard id
        // db obbligatorio
        if (!global.db) { // Firestore assente
            throw new Error('Firestore non inizializzato (window.db)'); // throw
        } // fine guard db
        // set merge come consolidateToFirestore
        await global.db.collection('contents').doc(jobId).set(payload, { merge: true }); // write FS
        console.log('[PRISM MOCK] contents/' + jobId + ' scritto (merge)'); // log ok
    } // fine writeContentDoc

    /**
     * Costruisce documento FS completo post-analisi (blueprint §3.2 / §4.1).
     * @param {object} ctx
     * @returns {object}
     */
    function buildCompletedAnalysisDoc(ctx) {
        // timestamp unico per created/updated
        var now = fsNow(); // Timestamp
        // pilastri random
        var pillars = buildRandomPillars(ctx.topic); // compressedFacts
        // toni random da enabled
        var tones = buildRandomTones(ctx.enabledTones); // tones map
        // input type
        var inputType = detectInputType(ctx.originalInput || ctx.topic); // text|url
        // sourceMeta se URL
        var sourceMeta = null; // default null
        if (inputType === 'url') { // se URL
            sourceMeta = { // meta url
                type: 'url', // tipo
                url: String(ctx.originalInput || ctx.topic), // url
                title: 'Mock URL extract', // titolo fake
                charCount: String(ctx.topic || '').length, // lungh
                truncated: false, // non troncato
                extractedAt: now // Timestamp
            }; // fine sourceMeta
        } // fine if url
        // documento completo
        return { // ContentDoc
            jobId: ctx.jobId, // == doc id
            isMock: true, // marca mock
            companyId: ctx.companyId, // company
            userId: ctx.userId, // user
            topic: ctx.topic, // topic pipeline
            originalInput: ctx.originalInput || ctx.topic, // input originale
            inputType: inputType, // text|url
            sourceMeta: sourceMeta, // meta o null
            status: 'completed', // analisi done
            language: ctx.language || 'italiano', // lingua
            platform: normalizePlatform(ctx.platform), // piattaforma
            action: 'shaping_only', // solo shaping
            createdAt: now, // Timestamp
            updatedAt: now, // Timestamp
            workerState: { // stato worker
                currentStep: 'done', // step done
                step: 'done', // alias step
                progress: 1, // 100%
                retryCount: 0, // retry
                updatedAt: now // Timestamp
            }, // fine workerState
            research: { // research block
                contentIngest: inputType === 'url' ? { mock: true, note: 'ingest simulato' } : null, // ingest
                shaping: { // shaping
                    is_blocked: false, // non bloccato
                    block_message: '', // msg vuoto
                    diagnosi: { // diagnosi GAP → search
                        scenario: 'GAP', // scenario
                        context: 'GAP', // context
                        sfide_opportunita: 'GAP' // sfide
                    }, // fine diagnosi
                    search_required: true, // search
                    tone_suitability: buildToneSuitability(tones), // suitability
                    plan: buildMockPlan(ctx.topic), // plan
                    suggestedQueries: ['mock query ' + String(ctx.topic).slice(0, 40)], // queries
                    updatedAt: now // Timestamp
                }, // fine shaping
                tavily: { rawResults: [] }, // tavily vuoto
                refiner: { // refiner
                    compressedFacts: pillars, // 3 pilastri
                    sourcesPreview: [], // fonti
                    tables: [], // tabelle
                    isContextRelevant: true // rilevante
                } // fine refiner
            }, // fine research
            tones: tones, // toni ON/OFF text vuoto
            error: null // nessun errore
        }; // fine doc
    } // fine buildCompletedAnalysisDoc

    /**
     * Converte doc FS / stato memory in payload getJobStatusForClient-like.
     * @param {object} job
     * @returns {object}
     */
    function toClientStatusPayload(job) {
        // clona shallow per non mutare store
        var data = JSON.parse(JSON.stringify(job)); // clone JSON-safe
        // Timestamp → ISO string per JSON HTTP (come farebbe API)
        function convertDates(obj) { // walker
            if (!obj || typeof obj !== 'object') return obj; // base
            if (obj.seconds != null && obj.nanoseconds != null && Object.keys(obj).length <= 3) { // Timestamp-like
                try { // try date
                    var ms = (Number(obj.seconds) * 1000) + Math.floor(Number(obj.nanoseconds) / 1e6); // ms
                    return new Date(ms).toISOString(); // ISO
                } catch (e) { // fail
                    return obj; // leave
                } // fine catch
            } // fine if Timestamp-like
            if (Array.isArray(obj)) return obj.map(convertDates); // array
            var out = {}; // object out
            Object.keys(obj).forEach(function (k) { out[k] = convertDates(obj[k]); }); // recurse
            return out; // converted
        } // fine convertDates
        data = convertDates(data); // applica
        // assicurati workerState coerente se completed/blocked
        if (data.status === 'completed' || data.status === 'blocked') { // terminali
            data.workerState = data.workerState || {}; // ensure
            data.workerState.currentStep = data.workerState.currentStep || 'done'; // step
            data.workerState.step = 'done'; // alias
            data.workerState.progress = 1; // progress
        } // fine if terminal
        return { // envelope API
            success: true, // ok
            data: data // payload
        }; // fine envelope
    } // fine toClientStatusPayload

    /**
     * Avvia progressione in-memory prepare-shaping → completed + flush FS.
     * @param {object} seed
     */
    function scheduleAnalysisProgression(seed) {
        // riferimenti job in map
        var jobId = seed.jobId; // id
        // step 1 ~ immediato già impostato dal caller
        // step 2 dopo 600ms
        setTimeout(function () { // t1
            var job = mockJobsById.get(jobId); // get
            if (!job || job.status === 'completed' || job.status === 'failed') return; // stop se chiuso
            job.status = 'running'; // running
            job.workerState = { // worker
                currentStep: 'tavily_search', // F2
                step: 'tavily_search', // alias
                progress: 0.5, // 50%
                retryCount: 0, // retry
                updatedAt: new Date().toISOString(), // iso
                message: 'Ricerca fonti in corso (mock)...' // label
            }; // fine worker
            job.research = job.research || {}; // ensure research
            job.research.shaping = job.research.shaping || { // shaping minimo
                is_blocked: false, // ok
                block_message: '', // vuoto
                diagnosi: { scenario: 'GAP', context: 'GAP', sfide_opportunita: 'GAP' }, // diagnosi
                search_required: true, // search
                tone_suitability: {}, // vuoto per ora
                plan: buildMockPlan(job.topic), // plan
                suggestedQueries: [], // queries
                updatedAt: new Date().toISOString() // iso
            }; // fine shaping
            mockJobsById.set(jobId, job); // save
        }, 600); // delay step2

        // step 3 dopo 1200ms — refiner
        setTimeout(function () { // t2
            var job = mockJobsById.get(jobId); // get
            if (!job || job.status === 'completed' || job.status === 'failed') return; // stop
            job.status = 'running'; // running
            job.workerState = { // worker
                currentStep: 'refiner', // F3
                step: 'refiner', // alias
                progress: 0.7, // 70%
                retryCount: 0, // retry
                updatedAt: new Date().toISOString(), // iso
                message: 'Raffinamento fatti (mock)...' // label
            }; // fine worker
            mockJobsById.set(jobId, job); // save
        }, 1200); // delay step3

        // completed + FS dopo 1800–2500ms random
        var flushDelay = 1800 + Math.floor(Math.random() * 700); // 1.8–2.5s
        setTimeout(async function () { // t3 async
            try { // try complete
                var enabled = await readEnabledTones(seed.companyId); // enabled_tones
                var doc = buildCompletedAnalysisDoc({ // doc FS
                    jobId: jobId, // id
                    userId: seed.userId, // user
                    companyId: seed.companyId, // company
                    topic: seed.topic, // topic
                    originalInput: seed.originalInput || seed.topic, // original
                    language: seed.language, // lang
                    platform: seed.platform, // platform
                    enabledTones: enabled // toni
                }); // fine build
                await writeContentDoc(jobId, doc); // persist FS
                // aggiorna memory con shape client-ready (date ISO via toClient dopo)
                var memoryJob = JSON.parse(JSON.stringify(doc)); // clone
                // Timestamp objects non serializzano: riconverti date critical a ISO
                memoryJob.createdAt = new Date().toISOString(); // iso
                memoryJob.updatedAt = new Date().toISOString(); // iso
                memoryJob.workerState = memoryJob.workerState || {}; // ensure
                memoryJob.workerState.updatedAt = new Date().toISOString(); // iso
                memoryJob.workerState.currentStep = 'done'; // done
                memoryJob.workerState.step = 'done'; // alias
                memoryJob.workerState.progress = 1; // 100%
                memoryJob.fsReady = true; // flag interno
                mockJobsById.set(jobId, memoryJob); // store completed
                console.log('[PRISM MOCK] analisi completed per', jobId); // log
            } catch (err) { // errore flush
                console.error('[PRISM MOCK] flush analisi fallito:', err && err.message); // error
                var failed = mockJobsById.get(jobId) || { jobId: jobId }; // base
                failed.status = 'failed'; // failed
                failed.error = { message: (err && err.message) || 'Mock flush failed', step: 'refiner' }; // error obj
                failed.workerState = { currentStep: 'refiner', step: 'refiner', progress: 0.7, updatedAt: new Date().toISOString() }; // state
                mockJobsById.set(jobId, failed); // save failed
            } // fine catch
        }, flushDelay); // delay flush
    } // fine scheduleAnalysisProgression

    /**
     * Handler mock POST /api/prepare-shaping
     * @param {object} body
     * @returns {Promise<Response>}
     */
    async function handlePrepareShaping(body) {
        // validazione obbligatoria
        var userId = body && body.userId; // userId
        var companyId = body && body.companyId; // companyId
        var topic = body && body.topic; // topic
        if (!userId || !companyId || !topic) { // missing
            return jsonResponse(400, { error: 'Missing userId, companyId or topic' }); // 400
        } // fine validation
        // crea jobId mock_
        var jobId = createMockJobId(); // mock_<uuid>
        // seed stato iniziale in memory
        var seed = { // seed
            jobId: jobId, // id
            userId: String(userId), // user
            companyId: String(companyId), // company
            topic: String(topic), // topic
            originalInput: String(topic), // original
            language: (body.language || 'italiano'), // lingua
            platform: normalizePlatform(body.platform || 'linkedin'), // platform
            status: 'running', // running
            inputType: detectInputType(topic), // type
            sourceMeta: null, // meta
            action: 'shaping_only', // action
            workerState: { // worker F1
                currentStep: 'query_shaping', // F1
                step: 'query_shaping', // alias
                progress: 0.2, // 20%
                retryCount: 0, // retry
                updatedAt: new Date().toISOString(), // iso
                message: 'Analisi shaping in corso (mock)...' // label
            }, // fine worker
            research: { // research iniziale
                contentIngest: null, // null
                shaping: null, // ancora assente (step1 blueprint)
                tavily: { rawResults: [] }, // vuoto
                refiner: null // assente
            }, // fine research
            tones: {}, // vuoto finché completed
            error: null, // no error
            isMock: true, // marca
            fsReady: false // non ancora su FS
        }; // fine seed
        mockJobsById.set(jobId, seed); // store
        scheduleAnalysisProgression(seed); // avvia progressione async
        // risposta immediata come API reale
        return jsonResponse(200, { success: true, jobId: jobId }); // 200
    } // fine handlePrepareShaping

    /**
     * Handler mock GET /jobs/status/:userId/:jobId
     * @param {string} userId
     * @param {string} jobId
     * @returns {Promise<Response>}
     */
    async function handleJobStatus(userId, jobId) {
        // se non è mock id → 404 esplicito (mock ON non gestisce job reali)
        if (!isMockJobId(jobId)) { // id reale
            return jsonResponse(404, { // 404
                success: false, // fail
                error: 'JOB_NOT_FOUND', // codice
                message: 'Mock ON: jobId non-mock non gestito dal layer mock' // dettaglio
            }); // fine response
        } // fine if non-mock
        // prova memory
        var job = mockJobsById.get(jobId); // memory
        // se assente ma FS potrebbe avere doc (refresh pagina)
        if (!job && global.db) { // prova FS
            try { // try get
                var snap = await global.db.collection('contents').doc(jobId).get(); // get
                if (snap.exists) { // trovato
                    var data = snap.data() || {}; // data
                    if (data.isMock === true || isMockJobId(jobId)) { // conferma mock
                        job = data; // usa FS
                        mockJobsById.set(jobId, job); // rehydrate memory
                    } // fine if mock
                } // fine if exists
            } catch (err) { // FS error
                console.warn('[PRISM MOCK] status FS read:', err && err.message); // warn
            } // fine catch
        } // fine if !job
        // ancora assente → 404
        if (!job) { // missing
            return jsonResponse(404, { success: false, error: 'JOB_NOT_FOUND' }); // 404
        } // fine if !job
        // opzionale: verifica userId coerente (soft)
        if (userId && job.userId && String(job.userId) !== String(userId)) { // mismatch
            console.warn('[PRISM MOCK] userId status mismatch (continuo comunque)'); // warn soft
        } // fine mismatch
        // failed/blocked envelope
        if (job.status === 'failed' || job.status === 'blocked') { // terminal fail
            var failPayload = toClientStatusPayload(job); // base
            return jsonResponse(200, { // 200 con success false come blueprint note
                success: false, // fail
                jobId: jobId, // id
                status: job.status, // status
                error: job.error || { message: 'Mock job failed', step: 'unknown' }, // error
                data: failPayload.data // data
            }); // fine response
        } // fine if failed
        // successo
        return jsonResponse(200, toClientStatusPayload(job)); // 200 ok
    } // fine handleJobStatus

    /**
     * Handler mock POST /api/regenerate-tone-surgical
     * Ritorna subito success con status generating in memory; completa async + FS
     * così il polling UI vede generating → completed (toneGenHasSeenGenerating).
     * @param {object} body
     * @returns {Promise<Response>}
     */
    async function handleRegenerateTone(body) {
        // alias IT/EN
        var userId = body && body.userId; // user
        var companyId = body && body.companyId; // company
        var jobId = body && body.jobId; // job
        var toneKey = (body && (body.toneKey || body.tono)) || ''; // tono
        var language = (body && (body.language || body.linguaOutput)) || 'italiano'; // lingua
        var platform = normalizePlatform((body && (body.platform || body.piattaforma)) || 'LinkedIn'); // platform
        var instructions = (body && (body.instructions || body.istruzioniAggiuntive)) || ''; // istruzioni
        var topicOverride = (body && (body.topic || body.argomento)) || ''; // topic override
        // validazione obbligatori
        if (!userId || !companyId || !jobId || !toneKey || !language || !platform) { // missing
            return jsonResponse(400, { error: 'Parametri mancanti per regenerate-tone-surgical (mock)' }); // 400
        } // fine validation
        // SOLO job mock_
        if (!isMockJobId(jobId)) { // id reale
            return jsonResponse(400, { // 400 esplicito
                error: 'Mock ON: regenerate consentito solo su jobId mock_*', // messaggio
                jobId: jobId // id rifiutato
            }); // fine response
        } // fine if non-mock
        // carica job memory o FS
        var job = mockJobsById.get(jobId); // memory
        if (!job && global.db) { // FS fallback
            try { // try
                var snap = await global.db.collection('contents').doc(jobId).get(); // get
                if (snap.exists) job = snap.data(); // data
            } catch (e) { // err
                console.warn('[PRISM MOCK] regen FS load:', e && e.message); // warn
            } // fine catch
        } // fine FS
        if (!job) { // not found
            return jsonResponse(404, { error: 'Job non trovato' }); // 404
        } // fine !job
        // enabled_tones company
        var enabled = await readEnabledTones(companyId); // lista
        var toneNorm = String(toneKey).trim().toLowerCase(); // normalizza
        if (enabled.indexOf(toneNorm) === -1) { // non enabled
            return jsonResponse(403, { error: 'Tono non in companies.enabled_tones' }); // 403
        } // fine 403
        // tones map
        var tones = job.tones || {}; // tones
        var toneEntry = tones[toneNorm] || tones[toneKey]; // entry
        if (!toneEntry) { // tono assente nel job
            return jsonResponse(400, { error: 'Tono assente nel documento job' }); // 400
        } // fine !entry
        if (String(toneEntry.status || '').toUpperCase() === 'OFF') { // OFF
            return jsonResponse(400, { error: 'Tono status OFF — generazione non consentita' }); // 400
        } // fine OFF
        // pilastri per testo
        var pillars = (job.research && job.research.refiner && job.research.refiner.compressedFacts) || []; // facts
        var topic = topicOverride || job.topic || ''; // topic
        var languageNorm = String(language || 'italiano').trim(); // lingua normalizzata
        // genera testo subito (userà flush async) — include platform + language
        var contenutoGenerato = buildRandomToneText({ // testo
            toneKey: toneNorm, // tono
            platform: platform, // platform
            language: languageNorm, // lingua
            topic: topic, // topic
            pillars: pillars // pillars
        }); // fine text
        // versions esistenti (da memory o FS entry)
        var prevVersionsSeed = normalizeVersionsArray(toneEntry.versions); // array
        var nextVersion = computeNextToneVersion(prevVersionsSeed); // last+1 o 1
        // marca generating in memory SUBITO (per polling UI)
        job.status = 'generating'; // generating
        job.action = 'regen_tone'; // action
        job.workerState = { // worker F4
            currentStep: 'generation', // generation
            step: 'generation', // alias
            progress: 0.9, // 90%
            retryCount: 0, // retry
            updatedAt: new Date().toISOString(), // iso
            message: 'Generazione tono mock in corso...' // label
        }; // fine worker
        job.language = languageNorm; // aggiorna contesto job (lingua)
        job.platform = platform; // aggiorna contesto job (piattaforma)
        mockJobsById.set(jobId, job); // save generating

        // completa async dopo breve delay (poll vede generating poi completed)
        setTimeout(async function () { // async complete
            try { // try
                var now = fsNow(); // Timestamp nativo FS
                // rileggi tones FS per append sicuro (evita race su altre chiavi)
                var existingTones = {}; // mappa tones corrente
                var prevFromFs = null; // entry tono da FS
                try { // try rileggi FS
                    var latestSnap = await global.db.collection('contents').doc(jobId).get(); // get latest
                    if (latestSnap.exists) { // doc presente
                        existingTones = (latestSnap.data() && latestSnap.data().tones) || {}; // tones FS
                        prevFromFs = existingTones[toneNorm] || existingTones[toneKey] || null; // entry
                    } // fine if exists
                } catch (readErr) { // lettura fallita
                    existingTones = (job.tones && typeof job.tones === 'object') ? job.tones : {}; // fallback memory
                    prevFromFs = existingTones[toneNorm] || toneEntry; // fallback
                    console.warn('[PRISM MOCK] regen: fallback tones da memory', readErr && readErr.message); // warn
                } // fine catch
                // base tono precedente (status/lock + versions)
                var prevTone = prevFromFs || toneEntry || { status: 'ON', lock_reason: '', versions: [] }; // prev
                var prevVersions = normalizeVersionsArray(prevTone.versions); // array versioni
                var resolvedNextVersion = computeNextToneVersion(prevVersions); // next n
                // entry versione: SOLO text (+ platform, language, regeneratedWith, instructions, createdAt)
                var versionEntry = buildToneVersionEntry({ // versions[n]
                    nextVersion: resolvedNextVersion, // version >= 1
                    text: contenutoGenerato, // solo text (niente content)
                    platform: platform, // piattaforma bozza
                    language: languageNorm, // lingua bozza
                    instructions: instructions, // istruzioni raw (trim+slice in helper)
                    createdAt: now // Timestamp FS
                }); // fine versionEntry
                prevVersions.push(versionEntry); // append storico
                // tono aggiornato: niente text/version/type root — solo versions
                var updatedTone = { // tones[toneKey]
                    status: 'ON', // ON dopo generazione
                    lock_reason: '', // unlock
                    versions: prevVersions // storico bozze (ultima = attiva)
                }; // fine updatedTone
                // merge tones map completa (evita wipe altre chiavi con set merge)
                var mergedTones = {}; // clone shallow tones
                Object.keys(existingTones).forEach(function (k) { // copia chiavi
                    mergedTones[k] = existingTones[k]; // keep
                }); // fine forEach
                mergedTones[toneNorm] = updatedTone; // overwrite solo tono regen
                // payload merge: tones + contesto job platform/language (blueprint §4.2)
                var mergePayload = { // payload merge sicuro
                    tones: mergedTones, // mappa toni completa aggiornata
                    platform: versionEntry.platform, // aggiorna contents.platform
                    language: versionEntry.language, // aggiorna contents.language
                    status: 'completed', // status completed
                    updatedAt: now, // Timestamp updatedAt
                    isMock: true, // marca mock
                    workerState: { // worker done
                        currentStep: 'done', // currentStep done
                        step: 'done', // alias step
                        progress: 1, // progress 100%
                        updatedAt: now // Timestamp worker
                    } // fine workerState
                }; // fine mergePayload
                await writeContentDoc(jobId, mergePayload); // write FS merge
                // aggiorna memory completed (createdAt ISO per JSON status)
                var memEntry = { // entry memory-friendly
                    version: versionEntry.version, // n
                    text: versionEntry.text, // solo text
                    platform: versionEntry.platform, // platform
                    language: versionEntry.language, // language
                    regeneratedWith: versionEntry.regeneratedWith, // total|instructions
                    instructions: versionEntry.instructions, // istruzioni
                    createdAt: new Date().toISOString() // ISO in memory/API
                }; // fine memEntry
                var memVersions = prevVersions.slice(0, -1).concat([memEntry]); // swap last con ISO
                var memTone = { status: 'ON', lock_reason: '', versions: memVersions }; // tono memory
                var mem = mockJobsById.get(jobId) || job; // mem
                mem.status = 'completed'; // completed
                mem.platform = versionEntry.platform; // job platform
                mem.language = versionEntry.language; // job language
                mem.updatedAt = new Date().toISOString(); // iso
                mem.workerState = { // done
                    currentStep: 'done', // done
                    step: 'done', // alias
                    progress: 1, // 100%
                    updatedAt: new Date().toISOString(), // iso
                    message: 'Generazione tono mock completata' // label
                }; // fine worker
                mem.tones = mem.tones || {}; // ensure
                mem.tones[toneNorm] = memTone; // tone
                mem.fsReady = true; // ready
                mockJobsById.set(jobId, mem); // save
                console.log('[PRISM MOCK] regen completed', jobId, toneNorm, 'v' + resolvedNextVersion, versionEntry.platform, versionEntry.language); // log
            } catch (err) { // fail
                console.error('[PRISM MOCK] regen flush fallito:', err && err.message); // error
                var fail = mockJobsById.get(jobId) || job; // base
                fail.status = 'failed'; // failed
                fail.error = { message: (err && err.message) || 'Mock regen failed', step: 'generation' }; // err
                mockJobsById.set(jobId, fail); // save
            } // fine catch
        }, 1200 + Math.floor(Math.random() * 800)); // 1.2–2.0s

        // risposta immediata: success true (UI ignora testo e usa polling+FS)
        return jsonResponse(200, { // 200
            success: true, // ok
            contenutoGenerato: contenutoGenerato, // testo (disponibile subito, FS async)
            jobId: jobId, // id
            toneKey: toneNorm // tono
        }); // fine response
    } // fine handleRegenerateTone

    /**
     * Router interno: se URL/method matchano API PRISM → mock, altrimenti null.
     * @param {string} url
     * @param {string} method
     * @param {object} body
     * @returns {Promise<Response|null>}
     */
    async function routeMockRequest(url, method, body) {
        // prepare-shaping
        if (method === 'POST' && isPrepareShapingUrl(url)) { // match prepare
            return handlePrepareShaping(body || {}); // handle
        } // fine prepare
        // regenerate
        if (method === 'POST' && isRegenerateToneUrl(url)) { // match regen
            return handleRegenerateTone(body || {}); // handle
        } // fine regen
        // status
        if (method === 'GET') { // GET
            var parsed = parseJobStatusUrl(url); // parse
            if (parsed) { // match status
                return handleJobStatus(parsed.userId, parsed.jobId); // handle
            } // fine if parsed
        } // fine GET
        return null; // non gestito → passare al fetch reale
    } // fine routeMockRequest

    /**
     * Installa interceptor fetch. Se mock OFF, delega sempre al fetch precedente.
     */
    function installFetchInterceptor() {
        // evita doppia install
        if (fetchInterceptorInstalled) return; // già fatto
        // fetch deve esistere
        if (typeof global.fetch !== 'function') { // no fetch
            console.error('[PRISM MOCK] fetch assente — interceptor non installato'); // error
            return; // abort
        } // fine guard
        // aggiorna riferimento (dashboard potrebbe aver wrappato fetch)
        previousFetch = global.fetch.bind(global); // bind latest
        // wrap
        global.fetch = async function prismMockFetchWrapper(input, init) { // wrapper
            // risolvi url/method subito (serve anche per i log)
            var url = resolveFetchUrl(input); // url
            var method = resolveFetchMethod(input, init); // method
            var mockOn = isPrismMockEnabled(); // rileggi flag a ogni fetch
            // se mock OFF → passthrough totale (zero interferenza)
            if (!mockOn) { // flag off
                return previousFetch(input, init); // reale
            } // fine if off
            // body default
            var body = {}; // body default
            if (method === 'POST' || method === 'PUT' || method === 'PATCH') { // body methods
                body = await resolveFetchJsonBody(input, init); // parse
            } // fine if body
            // prova route mock
            try { // try mock
                var mocked = await routeMockRequest(url, method, body); // route
                if (mocked) { // gestito
                    console.log('%c[PRISM MOCK] INTERCEPT ' + method + ' ' + url, 'color:#16a34a;font-weight:bold;'); // log ok
                    return mocked; // Response mock
                } // fine if mocked
            } catch (err) { // errore handler
                console.error('[PRISM MOCK] errore handler:', err && err.message); // error
                return jsonResponse(500, { // 500
                    error: 'Internal Server Error', // msg
                    requestId: 'mock_' + Date.now() // requestId
                }); // fine 500
            } // fine catch
            // se sembra una API PRISM ma non matchata → warning esplicito
            var lowerUrl = String(url || '').toLowerCase(); // lower
            if (
                lowerUrl.indexOf('prepare-shaping') !== -1 || // prepare
                lowerUrl.indexOf('regenerate-tone') !== -1 || // regen
                lowerUrl.indexOf('/jobs/status/') !== -1 // status
            ) { // API PRISM non intercettata
                console.error('[PRISM MOCK] ATTIVO ma URL non routato → passthrough reale:', method, url); // critical
            } // fine warn
            // non-API PRISM → fetch reale anche con mock ON
            return previousFetch(input, init); // passthrough
        }; // fine wrapper
        fetchInterceptorInstalled = true; // marca installato
        // diagnostica sempre visibile in console
        console.log('[PRISM MOCK] window.PRISM_USE_MOCK =', global.PRISM_USE_MOCK, '| enabled =', isPrismMockEnabled()); // debug flag
        // banner console
        if (isPrismMockEnabled()) { // se attivo
            console.warn('%c[PRISM MOCK] ATTIVO — prepare-shaping / jobs/status / regenerate-tone usano mock (jobId mock_*)', 'color:#f59e0b;font-weight:bold;'); // banner
        } else { // off
            console.warn('%c[PRISM MOCK] DISATTIVATO — le chiamate vanno al backend reale. Imposta PRISM_USE_MOCK=true nel .env e ricarica /dashboard.', 'color:#ef4444;font-weight:bold;'); // warn
        } // fine banner
    } // fine installFetchInterceptor

    // -------------------------------------------------------------------------
    // API pubblica namespace (debug / cleanup opzionale)
    // -------------------------------------------------------------------------
    PrismMock.isEnabled = isPrismMockEnabled; // esporta flag check
    PrismMock.createMockJobId = createMockJobId; // esporta id factory
    PrismMock.isMockJobId = isMockJobId; // esporta id check
    PrismMock.getMemoryJobs = function () { return mockJobsById; }; // debug map
    PrismMock.install = installFetchInterceptor; // install manuale

    /**
     * Cleanup opzionale: cancella da memory i job mock (non tocca FS di default).
     */
    PrismMock.clearMemoryJobs = function () { // clear memory
        mockJobsById.clear(); // svuota Map
        console.log('[PRISM MOCK] memory jobs cleared'); // log
    }; // fine clearMemoryJobs

    // -------------------------------------------------------------------------
    // Autostart: installa dopo che dashboard.js ha wrappato fetch
    // (questo file va caricato DOPO dashboard.js nella pagina)
    // -------------------------------------------------------------------------
    installFetchInterceptor(); // install immediata

})(typeof window !== 'undefined' ? window : globalThis); // fine IIFE
