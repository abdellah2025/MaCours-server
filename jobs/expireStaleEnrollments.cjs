const admin = require("firebase-admin");

const STRIKE_LIMIT = 3;
const CREATOR_BLOCK_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

/**
 * Remplace la Cloud Function planifiée expireStaleEnrollments (le plan
 * Spark n'a pas de Cloud Scheduler). Cette fonction fait le travail ; ce
 * qui la DÉCLENCHE est un choix séparé — voir routes/cron.cjs et la note
 * en bas de ce fichier sur node-cron vs. un ping externe.
 *
 * Logique inchangée par rapport à l'original : révoque tout
 * provisional/creator_approved dont accessExpiresAt est dépassé, et
 * n'inflige un "strike" au créateur QUE pour les creator_approved (il
 * avait validé, l'admin n'a pas confirmé à temps) — jamais pour un simple
 * provisional jamais touché, jamais pour un rejet explicite.
 */
async function expireStaleEnrollments() {
  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  const staleSnap = await db
    .collection("enrollments")
    .where("status", "in", ["provisional", "creator_approved"])
    .where("accessExpiresAt", "<=", now)
    .get();

  if (staleSnap.empty) {
    return { expired: 0, strikedCreators: 0 };
  }

  // Agrégé D'ABORD (par creatorId) pour ne faire qu'UNE seule écriture par
  // créateur ensuite : un batch Firestore interdit deux écritures sur le
  // même document dans le même batch, et plusieurs inscriptions du même
  // créateur peuvent expirer au même passage.
  const strikesByCreator = new Map();
  const docs = staleSnap.docs;

  for (let i = 0; i < docs.length; i += 500) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + 500);
    chunk.forEach((docSnap) => {
      const data = docSnap.data();
      batch.update(docSnap.ref, {
        status: "expired",
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (data.status === "creator_approved" && data.creatorId) {
        strikesByCreator.set(data.creatorId, (strikesByCreator.get(data.creatorId) || 0) + 1);
      }
    });
    await batch.commit();
  }

  for (const [creatorId, newStrikes] of strikesByCreator.entries()) {
    const creatorRef = db.doc(`users/${creatorId}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(creatorRef);
      if (!snap.exists) return;
      const current = snap.data().creatorStrikeCount || 0;
      const total = current + newStrikes;

      if (total >= STRIKE_LIMIT) {
        // Compteur remis à zéro après le blocage — un créateur qui a purgé
        // ses 30 jours repart avec 3 essais neufs plutôt qu'un compteur qui
        // ne redescend jamais. Choix d'implémentation, comme documenté à
        // l'origine dans docs/ENROLLMENTS_AND_ACCESS.md.
        tx.update(creatorRef, {
          creatorStrikeCount: 0,
          creatorBlockedUntil: admin.firestore.Timestamp.fromMillis(Date.now() + CREATOR_BLOCK_DURATION_MS),
        });
      } else {
        tx.update(creatorRef, { creatorStrikeCount: total });
      }
    });
  }

  return { expired: docs.length, strikedCreators: strikesByCreator.size };
}

module.exports = { expireStaleEnrollments };

// ─────────────────────────────────────────────────────────────────────────
// COMMENT DÉCLENCHER CECI TOUTES LES 15 MIN, SANS CLOUD SCHEDULER :
//
// Option A — node-cron DANS ce même process Express (server.cjs) :
//   simple, mais NE SE DÉCLENCHE PAS si le service Render gratuit s'est
//   mis en veille (il s'endort après 15 min sans requête HTTP entrante —
//   un cron interne au process ne tourne évidemment plus si le process
//   lui-même est éteint).
//
// Option B (RECOMMANDÉE sur le plan gratuit Render) — un service de cron
//   EXTERNE et gratuit (cron-job.org, ou l'onglet "Cron Jobs" de Render
//   qui est un service distinct — vérifiez son propre tarif) qui appelle
//   toutes les 15 min la route protégée POST /api/cron/expire-stale-
//   enrollments (voir routes/cron.cjs). Avantage supplémentaire : ce ping
//   externe réveille aussi le service s'il dormait, ce qui réduit
//   accessoirement les cold starts pour vos vrais utilisateurs.
//
// Les deux options peuvent cohabiter sans risque : expireStaleEnrollments()
// ne fait rien si rien n'a expiré, donc un déclenchement en double
// (node-cron ET un ping externe qui arriveraient au même moment) est sans
// conséquence — pas besoin de choisir une seule des deux si vous préférez
// les garder toutes les deux en filet de sécurité.
// ─────────────────────────────────────────────────────────────────────────
