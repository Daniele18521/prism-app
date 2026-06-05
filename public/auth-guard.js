/**
 * PRISM - Security Guard & Context Provider
 * Questo script protegge le pagine private (Dashboard) intercettando lo stato Auth.
 * Recupera il profilo utente da Firestore e popola il contesto aziendale globale.
 */

// Definiamo un oggetto globale in cui salvare i dettagli dell'utente e della company una volta verificati
window.PRISM_USER_CONTEXT = {
    uid: null,
    email: null,
    role: null,
    companyId: null,
    companyName: ""
};

// Monitoriamo lo stato dell'autenticazione in tempo reale
firebase.auth().onAuthStateChanged(async (user) => {
    if (!user) {
        console.warn("🔒 [GUARD] Utente non autenticato. Reindirizzamento al Login.");
        window.location.href = "/login";
        return;
    }

    console.log("🔑 [GUARD] Sessione Firebase Auth rilevata per:", user.email);

    try {
        // Interroghiamo direttamente Cloud Firestore usando l'istanza globale window.db
        const userDocRef = window.db.collection("users").doc(user.uid);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            console.error("❌ [GUARD] Errore: Profilo utente inesistente su Firestore.");
            // Se l'utente esiste in Auth ma non ha un documento associato nelle collezioni,
            // lo buttiamo fuori o lo rimandiamo al login per forzare la creazione del profilo.
            firebase.auth().signOut();
            window.location.href = "/login?error=profile_not_found";
            return;
        }

        const userData = userDoc.data();

        // Verifichiamo che l'utente abbia una Company associata nella struttura dati
        if (!userData.company_id) {
            console.error("❌ [GUARD] Errore: L'utente non è associato a nessuna Company/Insegna.");
            firebase.auth().signOut();
            window.location.href = "/login?error=no_company_assigned";
            return;
        }

        // Recuperiamo i dettagli della Company di appartenenza (sia essa reale o utente singolo)
        const companyDoc = await window.db.collection("companies").doc(userData.company_id).get();
        let companyName = "Singolo Professionista";
        
        if (companyDoc.exists) {
            companyName = companyDoc.data().name || companyName;
        }

        // 🎯 POPOLIAMO IL CONTESTO GLOBALE REALE DI PRISM
        window.PRISM_USER_CONTEXT = {
            uid: user.uid,
            email: userData.email || user.email,
            role: userData.role || "user",
            companyId: userData.company_id,
            companyName: companyName
        };

        console.log("🎯 [GUARD] Contesto Aziendale Caricato con successo:", window.PRISM_USER_CONTEXT);

        // 🚀 DISPACCIAMENTO EVENTO PERSONALIZZATO
        // Visto che Firestore è asincrono, avvisiamo la dashboard che il contesto è pronto per lavorare!
        const contextReadyEvent = new CustomEvent("prismContextReady", { detail: window.PRISM_USER_CONTEXT });
        window.dispatchEvent(contextReadyEvent);

    } catch (error) {
        console.error("🚨 [GUARD] Errore critico durante la verifica del profilo su Firestore:", error);
        // Fallback di sicurezza in caso di blocco delle regole del database o crash di rete
        alert("Errore di sincronizzazione con il database delle utenze. Riprova più tardi.");
        firebase.auth().signOut();
        window.location.href = "/login";
    }
});