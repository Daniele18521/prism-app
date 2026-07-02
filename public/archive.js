/**
 * ARCHIVE ENGINE FOR PRISM
 */

let allResults = []; // Store locale per il filtraggio live
let selectedForComparison = [];
let currentPage = 1;
const recordsPerPage = 10;

/**
 * Recupera i dati da Firestore filtrando per data e company_id
 */
async function fetchArchive() {
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    const resultsContainer = document.getElementById('results-container');

    if (!dateFrom || !dateTo) {
        if (typeof window.showPrismError === 'function') {
            return window.showPrismError('Seleziona un intervallo di date.');
        }
        return;
    }

    resultsContainer.innerHTML = "<p style='text-align:center; color:var(--text-dim)'>⚡ Interrogazione spettro in corso...</p>";

    try {
        const start = new Date(dateFrom);
        start.setHours(0,0,0,0);
        const end = new Date(dateTo);
        end.setHours(23,59,59,999);

        // Assumiamo che currentUserSessionData sia popolato come nella dashboard
        const companyId = window.FIREBASE_ENV.projectId; // O recuperato via Auth

        const snapshot = await window.db.collection("contents")
            .where("created_at", ">=", start)
            .where("created_at", "<=", end)
            .orderBy("created_at", "desc")
            .get();

        allResults = [];
        snapshot.forEach(doc => {
            allResults.push({ id: doc.id, ...doc.data() });
        });

        renderList(1);
    } catch (error) {
        console.error("Errore ricerca:", error);
        resultsContainer.innerHTML = "<p style='color:#ef4444'>Errore nel recupero dati.</p>";
        if (typeof window.showPrismError === 'function') {
            window.showPrismError('Errore nel recupero dati dall\'archivio. Riprova.');
        }
    }
}

/**
 * Renderizza la lista con paginazione
 */
function renderList(page, filteredData = null) {
    currentPage = page;
    const dataToRender = filteredData || allResults;
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = "";

    const start = (page - 1) * recordsPerPage;
    const end = start + recordsPerPage;
    const paginatedItems = dataToRender.slice(start, end);

    if (paginatedItems.length === 0) {
        resultsContainer.innerHTML = "<p style='text-align:center; color:var(--text-dim)'>Nessun contenuto trovato.</p>";
        return;
    }

    paginatedItems.forEach(item => {
        const date = item.created_at?.toDate().toLocaleDateString('it-IT') || 'N/A';
        const topic = item.testo?.input?.topic || 'Senza Argomento';
        const user = item.user_id || 'Sistema';

        const card = document.createElement('div');
        card.className = 'topic-card';
        card.innerHTML = `
            <div class="card-header" onclick="toggleCard('${item.id}')">
                <div>
                    <div class="topic-title">${topic}</div>
                    <div class="topic-meta">Creato il ${date} da User: ${user}</div>
                </div>
                <i class="fas fa-chevron-down" id="icon-${item.id}"></i>
            </div>
            <div class="card-content" id="content-${item.id}">
                <div class="tones-subgrid">
                    ${renderTones(item)}
                </div>
            </div>
        `;
        resultsContainer.appendChild(card);
    });

    renderPagination(dataToRender.length);
}

/**
 * Renderizza i bottoni dei toni con badge storico
 */
function renderTones(item) {
    const tones = item.testo?.tones || {};
    const storico = item.testo?.storico || {};
    
    return Object.keys(tones).map(tKey => {
        const hasHistory = storico[tKey] && storico[tKey].length > 0;
        return `
            <div class="tone-item" onclick="openVersionManagement('${item.id}', '${tKey}')">
                <label style="color:var(--accent-blue)">${tKey.replace('_', ' ').toUpperCase()}</label>
                <div style="font-size:10px; color:var(--text-dim); margin-top:5px;">Ultima v.${tones[tKey].version}</div>
                ${hasHistory ? `<span class="history-badge"><i class="fas fa-history"></i> ${storico[tKey].length + 1}</span>` : ''}
            </div>
        `;
    }).join('');
}

/**
 * Gestisce l'apertura delle versioni e la selezione per il confronto
 */
window.openVersionManagement = function(docId, toneKey) {
    const item = allResults.find(r => r.id === docId);
    const current = item.testo.tones[toneKey];
    const history = item.testo.storico?.[toneKey] || [];
    
    const modal = document.getElementById('version-modal');
    const list = document.getElementById('version-list');
    selectedForComparison = []; // Reset
    document.getElementById('compare-trigger-btn').style.display = 'none';

    list.innerHTML = "";
    
    // Uniamo tutto per una lista unica
    const allVersions = [{...current, isCurrent: true}, ...history];

    allVersions.forEach((v, idx) => {
        const date = v.timestamp ? new Date(v.timestamp).toLocaleString('it-IT') : 'Data non disp.';
        const div = document.createElement('div');
        div.className = 'version-list-item';
        div.innerHTML = `
            <div onclick="showFullContent('${v.text.replace(/'/g, "\\'")}')">
                <span style="color:var(--accent-blue)">v.${v.version}</span> - ${date} 
                <br><small style="color:var(--text-dim)">${v.isCurrent ? 'Versione Attuale' : 'Precedente'}</small>
            </div>
            <input type="checkbox" class="compare-checkbox" onchange="toggleCompareSelection(this, '${docId}', '${toneKey}', ${v.version})">
        `;
        list.appendChild(div);
    });

    modal.style.display = 'flex';
};

/**
 * Logica Selezione Confronto
 */
window.toggleCompareSelection = function(checkbox, docId, toneKey, version) {
    const item = allResults.find(r => r.id === docId);
    let vData;
    if (item.testo.tones[toneKey].version === version) vData = item.testo.tones[toneKey];
    else vData = item.testo.storico[toneKey].find(h => h.version === version);

    if (checkbox.checked) {
        selectedForComparison.push(vData);
    } else {
        selectedForComparison = selectedForComparison.filter(s => s.version !== version);
    }

    const btn = document.getElementById('compare-trigger-btn');
    btn.style.display = selectedForComparison.length === 2 ? 'block' : 'none';
    if (selectedForComparison.length > 2) {
        checkbox.checked = false;
        selectedForComparison.pop();
        if (typeof window.showPrismError === 'function') {
            window.showPrismError('Puoi confrontare solo 2 versioni alla volta.');
        }
    }
};

/**
 * Apre il modale di confronto side-by-side
 */
window.openComparison = function() {
    const render = document.getElementById('compare-render');
    render.innerHTML = selectedForComparison.map(v => `
        <div class="compare-pane">
            <div class="compare-meta">Versione ${v.version} - ${v.timestamp || ''}</div>
            <div style="font-size:13px; line-height:1.6; color:#ccc">${v.text}</div>
        </div>
    `).join('');
    document.getElementById('compare-modal').style.display = 'flex';
};

window.showFullContent = function(text) {
    document.getElementById('single-content-render').innerHTML = `<div style="line-height:1.8">${text}</div>`;
    document.getElementById('content-modal').style.display = 'flex';
};

/**
 * Filtro Live (min 3 caratteri)
 */
window.liveFilter = function() {
    const term = document.getElementById('topicFilter').value.toLowerCase();
    if (term.length < 3) {
        renderList(1);
        return;
    }
    const filtered = allResults.filter(r => r.testo?.input?.topic?.toLowerCase().includes(term));
    renderList(1, filtered);
};

window.toggleCard = function(id) {
    document.getElementById(`content-${id}`).classList.toggle('active');
    document.getElementById(`icon-${id}`).classList.toggle('fa-chevron-up');
};

function renderPagination(totalItems) {
    const pages = Math.ceil(totalItems / recordsPerPage);
    const container = document.getElementById('pagination-controls');
    container.innerHTML = "";
    for (let i = 1; i <= pages; i++) {
        container.innerHTML += `<button onclick="renderList(${i})" class="search-btn" style="background:${i === currentPage ? 'var(--accent-blue)' : '#111'}">${i}</button>`;
    }
}

window.closeModal = function(id) { document.getElementById(id).style.display = 'none'; };