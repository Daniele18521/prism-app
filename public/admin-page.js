/**
 * PRISM Admin — Inserimento prompt su Firestore
 * Struttura: Prompt/config { system_instructions, toni{}, piattaforma{} }
 */

const PROMPT_DOC_ID = 'config';

const PROMPT_TREE = {
    system_instructions: {
        label: 'System Instructions',
        description: 'Istruzioni di sistema (stringa singola)'
    },
    toni: {
        label: 'Toni',
        items: [
            { key: 'confidente', label: 'Confidente' },
            { key: 'metodologico', label: 'Metodologico' },
            { key: 'sferzante', label: 'Sferzante' },
            { key: 'narratore', label: 'Narratore' },
            { key: 'provocatore', label: 'Provocatore' },
            { key: 'visionario', label: 'Visionario' },
            { key: 'promotore', label: 'Promotore' }
        ]
    },
    piattaforma: {
        label: 'Piattaforma',
        items: [
            { key: 'facebook', label: 'Facebook' },
            { key: 'linkedin', label: 'Linkedin' },
            { key: 'x', label: 'X' }
        ]
    }
};

let currentUser = null;
let promptData = null;

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

function getPromptRef() {
    return window.db.collection('Prompt').doc(PROMPT_DOC_ID);
}

function readSystemInstructions(data) {
    const raw = data?.system_instructions;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw.text === 'string') return raw.text;
    return '';
}

function readNestedPrompt(data, section, key) {
    const sectionData = data?.[section];
    if (!sectionData || typeof sectionData !== 'object') return '';
    const raw = sectionData[key];
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw.text === 'string') return raw.text;
    return '';
}

function isPromptInserted(data, section, key) {
    if (section === 'system_instructions') {
        return Boolean(readSystemInstructions(data).trim());
    }
    return Boolean(readNestedPrompt(data, section, key).trim());
}

async function loadPromptConfig() {
    const snap = await getPromptRef().get();
    promptData = snap.exists ? snap.data() : {};
    return promptData;
}

function renderPromptField(section, key, label, value, inserted) {
    const fieldId = section === 'system_instructions'
        ? 'field-system_instructions'
        : `field-${section}-${key}`;

    return `
        <article class="prompt-card ${inserted ? 'prompt-inserted' : ''}" data-section="${section}" data-key="${key || ''}">
            <div class="prompt-card-header">
                <h4>${escapeHtml(label)}</h4>
                ${inserted
                    ? '<span class="inserted-badge"><i class="fas fa-check-circle"></i> Inserito</span>'
                    : '<span class="pending-badge"><i class="fas fa-circle"></i> Da inserire</span>'}
            </div>
            ${inserted
                ? `<pre class="prompt-readonly">${escapeHtml(value)}</pre>`
                : `<textarea
                        id="${fieldId}"
                        class="prompt-textarea"
                        spellcheck="false"
                        placeholder="Inserisci il testo del prompt. Usa Tab per indentare."
                   ></textarea>
                   <div class="prompt-actions">
                       <button type="button" class="btn-primary" onclick="insertPrompt('${section}', '${key || ''}')">
                           <i class="fas fa-save"></i> Inserisci su Firestore
                       </button>
                   </div>`}
        </article>
    `;
}

async function renderPromptsPanel() {
    const container = document.getElementById('admin-content');
    if (!container) return;

    container.innerHTML = '<div class="loading-state"><i class="fas fa-spinner fa-spin"></i> Caricamento...</div>';

    try {
        await loadPromptConfig();

        let html = `
            <div class="panel-header">
                <h2>Gestione prompt</h2>
                <p class="panel-subtitle">Inserisci i prompt nella struttura gerarchica Firestore <code>Prompt/${PROMPT_DOC_ID}</code>. Ogni voce può essere salvata una sola volta.</p>
            </div>
        `;

        const systemValue = readSystemInstructions(promptData);
        const systemInserted = isPromptInserted(promptData, 'system_instructions', null);

        html += `
            <section class="prompt-section">
                <h3>${escapeHtml(PROMPT_TREE.system_instructions.label)}</h3>
                ${renderPromptField('system_instructions', '', PROMPT_TREE.system_instructions.label, systemValue, systemInserted)}
            </section>
        `;

        ['toni', 'piattaforma'].forEach((sectionKey) => {
            const section = PROMPT_TREE[sectionKey];
            html += `<section class="prompt-section"><h3>${escapeHtml(section.label)}</h3><div class="prompt-grid">`;

            section.items.forEach((item) => {
                const value = readNestedPrompt(promptData, sectionKey, item.key);
                const inserted = isPromptInserted(promptData, sectionKey, item.key);
                html += renderPromptField(sectionKey, item.key, item.label, value, inserted);
            });

            html += '</div></section>';
        });

        container.innerHTML = html;
        container.querySelectorAll('.prompt-textarea').forEach(bindTabPreservation);
    } catch (err) {
        console.error('[ADMIN] Errore render:', err);
        container.innerHTML = `<div class="error-state">Errore: ${escapeHtml(err.message)}</div>`;
    }
}

window.insertPrompt = async function insertPrompt(section, key) {
    const fieldId = section === 'system_instructions'
        ? 'field-system_instructions'
        : `field-${section}-${key}`;
    const textarea = document.getElementById(fieldId);

    if (!textarea) return;

    const text = textarea.value;
    if (!text.trim()) {
        showPrismError('Il testo del prompt non può essere vuoto.');
        return;
    }

    await loadPromptConfig();

    if (section === 'system_instructions') {
        if (isPromptInserted(promptData, 'system_instructions', null)) {
            return showPrismError('System Instructions è già stato inserito.');
        }
    } else if (isPromptInserted(promptData, section, key)) {
        return showPrismError('Questo prompt è già stato inserito.');
    }

    const btn = textarea.closest('.prompt-card')?.querySelector('.btn-primary');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvataggio...';
    }

    try {
        const now = firebase.firestore.FieldValue.serverTimestamp();
        const userLabel = getUserLabel();
        const ref = getPromptRef();

        const payload = {
            updated_at: now,
            updated_by: userLabel
        };

        if (section === 'system_instructions') {
            payload.system_instructions = text;
        } else {
            payload[section] = {
                ...(promptData?.[section] || {}),
                [key]: text
            };
        }

        const snap = await ref.get();
        if (!snap.exists) {
            payload.created_at = now;
            payload.created_by = userLabel;
            await ref.set(payload);
        } else {
            await ref.set(payload, { merge: true });
        }

        await renderPromptsPanel();
    } catch (err) {
        console.error('[ADMIN] Errore inserimento:', err);
        showPrismError('Errore durante l\'inserimento: ' + err.message);
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-save"></i> Inserisci su Firestore';
        }
    }
};

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
        if ((userData.user_profile || 'copywriter') !== 'admin') {
            showPrismError('Accesso riservato agli amministratori.');
            setTimeout(() => { window.location.href = '/dashboard'; }, 1800);
            return;
        }

        document.getElementById('admin-gate').style.display = 'none';
        document.getElementById('admin-layout').style.display = 'block';
        renderPromptsPanel();
    } catch (err) {
        console.error('[ADMIN] Errore auth:', err);
        showPrismError('Errore di autenticazione.');
        setTimeout(() => { window.location.href = '/login'; }, 1800);
    }
});
