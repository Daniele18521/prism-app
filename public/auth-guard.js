/**
 * PRISM - Security Guard & Context Provider
 * Questo script protegge le pagine private (Dashboard) intercettando lo stato Auth.
 * Recupera il profilo utente da Firestore e popola il contesto aziendale globale.
 */

// Definiamo un oggetto globale in cui salvare i dettagli dell'utente e della company una volta verificati
window.PRISM_USER_CONTEXT = {
    uid: null,             // ID univoco dell'utente fornito da Firebase Authentication
    email: null,           // Email dell'utente autenticato
    role: null,            // Ruolo organizzativo dell'utente ('owner' o 'member')
    user_profile: null,    // Profilo operativo ('admin', 'copywriter', 'viewer')
    companyId: null,       // ID della Company associata (collegamento con camelCase companyId)
    companyName: ""        // Nome esteso della Company da mostrare nell'interfaccia
};

// Monitoriamo lo stato dell'autenticazione in tempo reale tramite il listener nativo di Firebase Auth
firebase.auth().onAuthStateChanged(async (user) => {
    // Se l'utente non è autenticato o la sessione è scaduta, lo blocchiamo
    if (!user) {
        // Stampiamo un messaggio di avviso in console per scopi di monitoraggio
        console.warn("🔒 [GUARD] Utente non autenticato. Reindirizzamento al Login.");
        // Reindirizziamo immediatamente il browser dell'utente alla pagina di login
        window.location.href = "/login";
        // Interrompiamo l'esecuzione dello script per ragioni di sicurezza
        return;
    }

    // Stampiamo in console l'avvenuto rilevamento della sessione attiva
    console.log("🔑 [GUARD] Sessione Firebase Auth rilevata per:", user.email);

    try {
        // Interroghiamo direttamente Cloud Firestore recuperando il documento associato all'utente
        const userDocRef = window.db.collection("users").doc(user.uid);
        // Eseguiamo la lettura asincrona del documento utente
        const userDoc = await userDocRef.get();

        // Se l'utente esiste in Auth ma non ha un documento corrispondente in Firestore
        if (!userDoc.exists) {
            // Segnaliamo in console l'incoerenza dei dati
            console.error("❌ [GUARD] Errore: Profilo utente inesistente su Firestore.");
            // Eseguiamo il logout forzato dell'utenza per evitare stati inconsistenti
            firebase.auth().signOut();
            // Rimandiamo l'utente alla schermata di login includendo un parametro di errore nell'URL
            window.location.href = "/login?error=profile_not_found";
            // Interrompiamo l'esecuzione della funzione
            return;
        }

        // Estraiamo i dati del profilo utente letti dal documento Firestore
        const userData = userDoc.data();

        // Verifichiamo la presenza del campo companyId (in formato camelCase come da specifiche)
        if (!userData.companyId) {
            // Segnaliamo l'errore di associazione aziendale nei log di console
            console.error("❌ [GUARD] Errore: L'utente non è associato a nessuna Company/Insegna.");
            // Eseguiamo il logout preventivo dell'utente
            firebase.auth().signOut();
            // Reindirizziamo l'utente con l'apposito codice d'errore nell'URL
            window.location.href = "/login?error=no_company_assigned";
            // Interrompiamo l'esecuzione
            return;
        }

        // Recuperiamo il documento della Company associata utilizzando il nuovo campo companyId
        const companyDoc = await window.db.collection("companies").doc(userData.companyId).get();
        // Definiamo un nome di default per il workspace se il record non dovesse risultare leggibile
        let companyName = "Singolo Professionista";
        
        // Se la lettura della Company è andata a buon fine, ne estraiamo il nome reale
        if (companyDoc.exists) {
            // Sostituiamo il nome generico con il valore memorizzato nel database
            companyName = companyDoc.data().name || companyName;
        }

        // 🎯 POPOLIAMO IL CONTESTO GLOBALE REALE DI PRISM CON I NUOVI CAMPI
        window.PRISM_USER_CONTEXT = {
            uid: user.uid,                               // UID dell'utente autenticato
            email: userData.email || user.email,         // Email dell'utente
            role: userData.role || "member",             // Ruolo amministrativo ('owner' o 'member')
            user_profile: userData.user_profile || "copywriter", // Profilo operativo ('admin', 'copywriter', 'viewer')
            companyId: userData.companyId,               // Associazione aziendale corretta (camelCase)
            companyName: companyName                     // Nome del workspace associato
        };

        // Logghiamo l'avvenuta creazione del contesto per agevolare lo sviluppo lato client
        console.log("🎯 [GUARD] Contesto Aziendale Caricato con successo:", window.PRISM_USER_CONTEXT);

        // 🚀 DISPACCIAMENTO EVENTO PERSONALIZZATO
        // Creiamo un evento JavaScript customizzato per informare la Dashboard che i dati sono pronti
        const contextReadyEvent = new CustomEvent("prismContextReady", { detail: window.PRISM_USER_CONTEXT });
        // Spediamo l'evento a livello di oggetto window per l'ascolto da parte dei controller della dashboard
        window.dispatchEvent(contextReadyEvent);

    } catch (error) {
        // Catturiamo e logghiamo l'errore in caso di fallimento della connessione o delle Security Rules
        console.error("🚨 [GUARD] Errore critico durante la verifica del profilo su Firestore:", error);
        // Mostriamo una notifica d'avviso temporanea sul browser dell'utente
        alert("Errore di sincronizzazione con il database delle utenze. Riprova più tardi.");
        // Rimuoviamo la sessione Firebase non allineata
        firebase.auth().signOut();
        // Spostiamo la navigazione sulla pagina di login per consentire un nuovo caricamento pulito
        window.location.href = "/login";
    }
});