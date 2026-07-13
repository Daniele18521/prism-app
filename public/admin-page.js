/**
 * PRISM Admin — Gestione prompt con versionamento Firestore
 * Collection: Prompt / subcollection: versions
 */

const PROMPT_SECTIONS = [
    { id: 'system', label: 'System Instructions', singleton: true },
    {
        id: 'toni',
        label: 'Toni',
        defaults: ['confidente', 'metodologico', 'sferzante', 'narratore', 'provocatore', 'visionario', 'promotore']
    },
    { id: 'piattaforma', label: 'Piattaforma' }
];

let currentUser = null;
let currentUserProfile = null;
let promptsCache = [];
let activeUtility = 'prompts';

function normalizePromptName(sectionId, name) {
    const trimmed = String(name || '').trim();
    if (sectionId === 'toni') return trimmed.toLowerCase();
    return trimmed;
}

function slugify(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function formatTimestamp(ts) {
    if (!ts) return '—';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('it-IT', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getUserLabel() {
    if (!currentUser) return 'unknown';
    return currentUser.email || currentUser.displayName || currentUser.uid;
}

function bindTabPreservation(textarea) {
    if (!textarea || textarea.dataset.tabBound === '1') return;
    textarea.dataset.tabBound = '1';
    textarea.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + '\t' + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 1;
    });
}

async function loadAllPrompts() {
    const snap = await window.db.collection('Prompt').get();
    promptsCache = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    promptsCache.sort((a, b) => {
        const sectionOrder = PROMPT_SECTIONS.findIndex((s) => s.id === a.section) - PROMPT_SECTIONS.findIndex((s) => s.id === b.section);
        if (sectionOrder !== 0) return sectionOrder;
        return (a.name || '').localeCompare(b.name || '', 'it');
    });
}

async function loadVersions(promptId) {
    const snap = await window.db
        .collection('Prompt')
        .doc(promptId)
        .collection('versions')
        .get();
    const versions = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    versions.sort((a, b) => (b.version || 0) - (a.version || 0));
    return versions;
}

function getSectionMeta(sectionId) {
    return PROMPT_SECTIONS.find((s) => s.id === sectionId) || { id: sectionId, label: sectionId };
}

function renderSectionDefaults(section, items) {
    if (!section.defaults || !section.defaults.length) return '';
    const existingSlugs = new Set(items.map((p) => p.name_slug || slugify(p.name)));
    const missing = section.defaults.filter((name) => !existingSlugs.has(slugify(name)));
    if (!missing.length) return '';

    return `
        <div class="section-defaults">
            ${missing.map((name) => `
                <button type="button" class="btn-tone-default" onclick="createPromptByName('${section.id}', '${name}')">
                    <i class="fas fa-plus"></i> ${escapeHtml(name)}
                </button>
            `).join('')}
        </div>
    `;
}

async function createPromptDocument(sectionId, rawName) {
    const section = getSectionMeta(sectionId);
    const name = normalizePromptName(sectionId, rawName);

    if (!name) {
        showPrismError('Inserisci un nome per il prompt.');
        return null;
    }

    if (section.singleton) {
        const existing = promptsCache.find((p) => p.section === sectionId);
        if (existing) {
            showPrismError('System Instructions ammette un solo prompt.');
            return null;
        }
    }

    const nameSlug = slugify(name);
    const duplicate = promptsCache.find((p) => p.section === sectionId && p.name_slug === nameSlug);
    if (duplicate) {
        showPrismError('Esiste già un prompt con questo nome nella sezione selezionata.');
        return null;
    }

    const now = firebase.firestore.FieldValue.serverTimestamp();
    const userLabel = getUserLabel();
    const docRef = await window.db.collection('Prompt').add({
        section: sectionId,
        section_label: section.label,
        name,
        name_slug: nameSlug,
        created_at: now,
        updated_at: now,
        created_by: userLabel,
        updated_by: userLabel,
        current_version: 0
    });

    promptsCache.push({
        id: docRef.id,
        section: sectionId,
        section_label: section.label,
        name,
        name_slug: nameSlug,
        created_by: userLabel,
        updated_by: userLabel,
        current_version: 0
    });

    return docRef.id;
}

function groupPromptsBySection() {
    const grouped = {};
    PROMPT_SECTIONS.forEach((section) => {
        grouped[section.id] = [];
    });
    promptsCache.forEach((prompt) => {
        const key = prompt.section || 'system';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(prompt);
    });
    Object.keys(grouped).forEach((key) => {
        grouped[key].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'it'));
    });
    return grouped;
}

function renderPromptCard(prompt, versions) {
    const latest = versions[0] || null;
    const previous = versions.slice(1);
    const isNew = !latest;
    const cardId = prompt.id;

    const historyHtml = previous.length
        ? previous.map((v) => `
            <div class="version-item">
                <button type="button" class="version-toggle" onclick="toggleVersionBody('${cardId}', ${v.version})">
                    <span><i class="fas fa-chevron-right version-chevron" id="chevron-${cardId}-${v.version}"></i> Versione ${v.version}</span>
                    <span class="version-toggle-meta">${formatTimestamp(v.created_at)} · ${escapeHtml(v.created_by || '—')}</span>
                </button>
                <div class="version-body" id="version-body-${cardId}-${v.version}">
                    <div class="version-motivation"><strong>Motivazione:</strong> ${escapeHtml(v.motivation || '—')}</div>
                    <pre class="version-text">${escapeHtml(v.text || '')}</pre>
                </div>
            </div>
        `).join('')
        : '<p class="empty-history">Nessuna versione precedente.</p>';

    return `
        <article class="prompt-card" data-prompt-id="${cardId}">
            <div class="prompt-card-header">
                <h3>${escapeHtml(prompt.name)}</h3>
                <span class="prompt-version-badge">${latest ? `v${latest.version}` : 'Nuovo'}</span>
            </div>
            <div class="prompt-meta">
                <span><i class="fas fa-plus-circle"></i> Creato: ${formatTimestamp(prompt.created_at)} · ${escapeHtml(prompt.created_by || '—')}</span>
                <span><i class="fas fa-pen"></i> Aggiornato: ${formatTimestamp(prompt.updated_at)} · ${escapeHtml(prompt.updated_by || '—')}</span>
            </div>
            <textarea
                id="prompt-text-${cardId}"
                class="prompt-textarea"
                spellcheck="false"
                placeholder="Inserisci il testo del prompt. Usa Tab per indentare."
            ></textarea>
            ${isNew ? '' : `
                <div class="motivation-row">
                    <label for="motivation-${cardId}">Motivazione aggiornamento <span class="required">*</span> <span class="char-hint" id="motivation-count-${cardId}">0/100</span></label>
                    <input
                        type="text"
                        id="motivation-${cardId}"
                        class="motivation-input"
                        maxlength="100"
                        placeholder="Descrivi perché stai aggiornando questo prompt (max 100 caratteri)"
                        oninput="updateMotivationCount('${cardId}')"
                    >
                </div>
            `}
            <div class="prompt-actions">
                <button type="button" class="btn-primary" onclick="savePrompt('${cardId}', ${isNew})">
                    ${isNew ? '<i class="fas fa-save"></i> Salva prima versione' : '<i class="fas fa-sync-alt"></i> Aggiorna prompt'}
                </button>
            </div>
            ${isNew ? '' : `
                <div class="version-history">
                    <h4>Versioni precedenti</h4>
                    ${historyHtml}
                </div>
            `}
        </article>
    `;
}

async function renderPromptsPanel() {
    const container = document.getElementById('utility-content');
    if (!container) return;

    container.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Caricamento prompt...</div>';

    try {
        await loadAllPrompts();
        const grouped = groupPromptsBySection();

        let html = `
            <div class="panel-header">
                <div>
                    <h2>Gestione prompt</h2>
                    <p class="panel-subtitle">Modifica i prompt di sistema, toni e piattaforme. Ogni aggiornamento crea una nuova versione.</p>
                </div>
            </div>
        `;

        for (const section of PROMPT_SECTIONS) {
            const items = grouped[section.id] || [];
            const canAdd = !(section.singleton && items.length >= 1);
            const defaultsHtml = renderSectionDefaults(section, items);

            html += `
                <section class="prompt-section" data-section="${section.id}">
                    <div class="section-header">
                        <h3>${escapeHtml(section.label)}</h3>
                        ${canAdd ? `<button type="button" class="btn-ghost" onclick="openAddPromptModal('${section.id}')"><i class="fas fa-plus"></i> Aggiungi prompt</button>` : ''}
                    </div>
                    ${defaultsHtml}
                    <div class="section-body" id="section-body-${section.id}">
                        ${items.length === 0
                            ? `<p class="empty-section">${section.id === 'toni'
                                ? 'Nessun prompt in questa sezione. Aggiungine uno per iniziare (nomi in minuscolo: confidente, metodologico, sferzante, narratore, provocatore, visionario, promotore).'
                                : 'Nessun prompt in questa sezione. Aggiungine uno per iniziare.'}</p>`
                            : '<div class="prompt-cards-loading"><i class="fas fa-spinner fa-spin"></i> Caricamento...</div>'}
                    </div>
                </section>
            `;
        }

        container.innerHTML = html;

        for (const section of PROMPT_SECTIONS) {
            const items = grouped[section.id] || [];
            const sectionBody = document.getElementById(`section-body-${section.id}`);
            if (!sectionBody || items.length === 0) continue;

            const cardsHtml = [];
            const textByPromptId = {};
            for (const prompt of items) {
                const versions = await loadVersions(prompt.id);
                textByPromptId[prompt.id] = versions[0] ? versions[0].text : '';
                cardsHtml.push(renderPromptCard(prompt, versions));
            }
            sectionBody.innerHTML = cardsHtml.join('');

            sectionBody.querySelectorAll('.prompt-textarea').forEach((textarea) => {
                const promptId = textarea.id.replace('prompt-text-', '');
                textarea.value = textByPromptId[promptId] || '';
                bindTabPreservation(textarea);
            });
        }
    } catch (err) {
        console.error('[ADMIN] Errore render prompt:', err);
        container.innerHTML = `<div class="error-state">Errore nel caricamento dei prompt: ${escapeHtml(err.message)}</div>`;
    }
}

function updateMotivationCount(promptId) {
    const input = document.getElementById(`motivation-${promptId}`);
    const counter = document.getElementById(`motivation-count-${promptId}`);
    if (!input || !counter) return;
    counter.textContent = `${input.value.length}/100`;
}

window.toggleVersionBody = function toggleVersionBody(promptId, version) {
    const body = document.getElementById(`version-body-${promptId}-${version}`);
    const chevron = document.getElementById(`chevron-${promptId}-${version}`);
    if (!body) return;
    body.classList.toggle('open');
    if (chevron) chevron.classList.toggle('open');
};

window.openAddPromptModal = function openAddPromptModal(sectionId) {
    const section = getSectionMeta(sectionId);
    document.getElementById('addPromptSection').value = sectionId;
    document.getElementById('addPromptSectionLabel').textContent = section.label;
    document.getElementById('addPromptName').value = '';
    document.getElementById('add-prompt-modal').classList.add('visible');
    document.getElementById('addPromptName').focus();
};

window.closeAddPromptModal = function closeAddPromptModal() {
    document.getElementById('add-prompt-modal').classList.remove('visible');
};

window.createPromptByName = async function createPromptByName(sectionId, rawName) {
    try {
        const created = await createPromptDocument(sectionId, rawName);
        if (!created) return;
        await renderPromptsPanel();
    } catch (err) {
        console.error('[ADMIN] Errore creazione prompt:', err);
        showPrismError('Impossibile creare il prompt: ' + err.message);
    }
};

window.submitNewPrompt = async function submitNewPrompt() {
    const sectionId = document.getElementById('addPromptSection').value;

    try {
        const created = await createPromptDocument(sectionId, document.getElementById('addPromptName').value);
        if (!created) return;

        closeAddPromptModal();
        await renderPromptsPanel();
    } catch (err) {
        console.error('[ADMIN] Errore creazione prompt:', err);
        showPrismError('Impossibile creare il prompt: ' + err.message);
    }
};

window.savePrompt = async function savePrompt(promptId, isFirstVersion) {
    const textarea = document.getElementById(`prompt-text-${promptId}`);
    if (!textarea) return;

    const text = textarea.value;
    if (!text.trim()) {
        showPrismError('Il testo del prompt non può essere vuoto.');
        return;
    }

    let motivation = 'Creazione iniziale';
    if (!isFirstVersion) {
        const motivationInput = document.getElementById(`motivation-${promptId}`);
        motivation = motivationInput ? motivationInput.value.trim() : '';
        if (!motivation) {
            showPrismError('La motivazione di aggiornamento è obbligatoria (max 100 caratteri).');
            return;
        }
    }

    const prompt = promptsCache.find((p) => p.id === promptId);
    if (!prompt) {
        showPrismError('Prompt non trovato.');
        return;
    }

    const btn = document.querySelector(`[data-prompt-id="${promptId}"] .btn-primary`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvataggio...';
    }

    try {
        const userLabel = getUserLabel();
        const now = firebase.firestore.FieldValue.serverTimestamp();
        const newVersion = (prompt.current_version || 0) + 1;

        const batch = window.db.batch();
        const promptRef = window.db.collection('Prompt').doc(promptId);
        const versionRef = promptRef.collection('versions').doc(`v${String(newVersion).padStart(4, '0')}`);

        batch.set(versionRef, {
            version: newVersion,
            text,
            created_at: now,
            created_by: userLabel,
            motivation
        });

        batch.update(promptRef, {
            updated_at: now,
            updated_by: userLabel,
            current_version: newVersion
        });

        await batch.commit();

        prompt.current_version = newVersion;
        prompt.updated_by = userLabel;

        await renderPromptsPanel();
    } catch (err) {
        console.error('[ADMIN] Errore salvataggio prompt:', err);
        showPrismError('Errore durante il salvataggio: ' + err.message);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = isFirstVersion
                ? '<i class="fas fa-save"></i> Salva prima versione'
                : '<i class="fas fa-sync-alt"></i> Aggiorna prompt';
        }
    }
};

function selectUtility(utilityId) {
    activeUtility = utilityId;
    document.querySelectorAll('.utility-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.utility === utilityId);
    });

    if (utilityId === 'prompts') {
        renderPromptsPanel();
    }
}

function initAdminPage() {
    document.querySelectorAll('.utility-btn').forEach((btn) => {
        btn.addEventListener('click', () => selectUtility(btn.dataset.utility));
    });

    selectUtility('prompts');
}

firebase.auth().onAuthStateChanged(async (user) => {
    const cachedUid = sessionStorage.getItem('prism_user_uid');
    const finalUid = user ? user.uid : cachedUid;

    if (!finalUid) {
        window.location.href = '/login';
        return;
    }

    currentUser = user;

    try {
        const userDoc = await window.db.collection('users').doc(finalUid).get();
        if (!userDoc.exists) {
            window.location.href = '/login?error=profile_not_found';
            return;
        }

        const userData = userDoc.data();
        currentUserProfile = userData.user_profile || 'copywriter';

        if (currentUserProfile !== 'admin') {
            showPrismError('Accesso riservato agli amministratori.');
            setTimeout(() => { window.location.href = '/dashboard'; }, 1800);
            return;
        }

        document.getElementById('admin-gate').style.display = 'none';
        document.getElementById('admin-layout').style.display = 'flex';
        initAdminPage();
    } catch (err) {
        console.error('[ADMIN] Errore auth:', err);
        showPrismError('Errore di autenticazione.');
        setTimeout(() => { window.location.href = '/login'; }, 1800);
    }
});
