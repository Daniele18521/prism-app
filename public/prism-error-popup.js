/**
 * PRISM — Popup di errore personalizzato
 * Sostituisce alert() nativo con un modale coerente con il design system PRISM.
 */
(function initPrismErrorPopup() {
    if (window.showPrismError) return;

    const STYLE_ID = 'prism-error-popup-styles';
    const OVERLAY_ID = 'prism-error-overlay';

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: fixed;
                inset: 0;
                z-index: 100000;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 24px;
                background: rgba(5, 5, 5, 0.88);
                backdrop-filter: blur(10px);
                animation: prism-error-fade-in 0.22s ease-out;
            }
            #${OVERLAY_ID}.visible { display: flex; }
            .prism-error-dialog {
                width: 100%;
                max-width: 440px;
                background: #0d0d0d;
                border: 1px solid #262626;
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.04);
                animation: prism-error-slide-up 0.28s ease-out;
            }
            .prism-error-rainbow {
                height: 3px;
                background: linear-gradient(to right, #3b82f6, #f59e0b, #ef4444, #a855f7, #ec4899, #06b6d4);
            }
            .prism-error-body {
                padding: 28px 28px 22px;
            }
            .prism-error-header {
                display: flex;
                align-items: flex-start;
                gap: 14px;
                margin-bottom: 16px;
            }
            .prism-error-icon {
                flex-shrink: 0;
                width: 42px;
                height: 42px;
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(239, 68, 68, 0.12);
                border: 1px solid rgba(239, 68, 68, 0.25);
                color: #f87171;
                font-size: 18px;
            }
            .prism-error-title {
                font-family: 'Inter', -apple-system, sans-serif;
                font-size: 16px;
                font-weight: 700;
                color: #fff;
                margin: 0 0 4px;
                letter-spacing: 0.2px;
            }
            .prism-error-subtitle {
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 1px;
                color: #71717a;
                margin: 0;
            }
            .prism-error-message {
                font-family: 'Inter', -apple-system, sans-serif;
                font-size: 14px;
                line-height: 1.65;
                color: #e4e4e7;
                white-space: pre-wrap;
                word-break: break-word;
                margin: 0;
            }
            .prism-error-actions {
                padding: 0 28px 24px;
                display: flex;
                justify-content: flex-end;
            }
            .prism-error-btn {
                background: #2563eb;
                color: #fff;
                border: none;
                padding: 11px 22px;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                cursor: pointer;
                transition: background 0.2s;
                font-family: 'Inter', -apple-system, sans-serif;
            }
            .prism-error-btn:hover { background: #1d4ed8; }
            .prism-error-btn:focus-visible {
                outline: 2px solid #3b82f6;
                outline-offset: 2px;
            }
            @keyframes prism-error-fade-in {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes prism-error-slide-up {
                from { opacity: 0; transform: translateY(12px) scale(0.98); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    function ensureOverlay() {
        let overlay = document.getElementById(OVERLAY_ID);
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('role', 'alertdialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.innerHTML = `
            <div class="prism-error-dialog" onclick="event.stopPropagation()">
                <div class="prism-error-rainbow"></div>
                <div class="prism-error-body">
                    <div class="prism-error-header">
                        <div class="prism-error-icon" aria-hidden="true">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </div>
                        <div>
                            <p class="prism-error-subtitle">PRISM</p>
                            <h2 class="prism-error-title" id="prism-error-title">Attenzione</h2>
                        </div>
                    </div>
                    <p class="prism-error-message" id="prism-error-message"></p>
                </div>
                <div class="prism-error-actions">
                    <button type="button" class="prism-error-btn" id="prism-error-close-btn">Ho capito</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', hidePrismError);
        document.getElementById('prism-error-close-btn').addEventListener('click', hidePrismError);
        document.addEventListener('keydown', onKeyDown);

        return overlay;
    }

    let onCloseCallback = null;

    function onKeyDown(event) {
        if (event.key === 'Escape') hidePrismError();
    }

    function hidePrismError() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay || !overlay.classList.contains('visible')) return;
        overlay.classList.remove('visible');
        const cb = onCloseCallback;
        onCloseCallback = null;
        if (typeof cb === 'function') cb();
    }

    /**
     * @param {string} message - Testo dell'errore da mostrare
     * @param {{ title?: string, onClose?: function }} [options]
     */
    function showPrismError(message, options) {
        injectStyles();
        const overlay = ensureOverlay();
        const opts = options || {};
        const title = opts.title || 'Attenzione';
        const text = (message || 'Si è verificato un errore imprevisto.').trim();

        document.getElementById('prism-error-title').textContent = title;
        document.getElementById('prism-error-message').textContent = text;
        onCloseCallback = typeof opts.onClose === 'function' ? opts.onClose : null;

        overlay.classList.add('visible');
        const btn = document.getElementById('prism-error-close-btn');
        if (btn) btn.focus();
    }

    window.showPrismError = showPrismError;
    window.hidePrismError = hidePrismError;
})();
