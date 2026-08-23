const admin = require("firebase-admin");

// Pourcentage conservé par la plateforme sur chaque inscription activée —
// identique à l'ancien functions/enrollments.js. Toujours pas confirmé
// côté produit, ajustez une fois validé.
const PLATFORM_SHARE = 0.2;

function creatorEntitlementKey(creatorId) {
  return `creator_${creatorId}`;
}
function entitlementKeyFor(enrollment) {
  return enrollment.scope === "creator"
    ? creatorEntitlementKey(enrollment.creatorId)
    : enrollment.courseId;
}

// ─────────────────────────────────────────────────────────────────────────
// POURQUOI CE FICHIER EXISTE : le plan Spark n'a pas de Cloud Functions,
// donc pas de trigger onDocumentWritten qui réagit automatiquement à un
// changement Firestore. La seule alternative fiable est d'appeler cette
// logique EXPLICITEMENT, juste après l'écriture, depuis chaque route qui
// fait passer un enrollment à "active" — au lieu de laisser Firestore
// "prévenir" le serveur tout seul.
//
// Ça change une chose par rapport à l'ancien trigger : celui-ci comparait
// `before`/`after` pour deviner s'il s'agissait d'un octroi ou d'une
// révocation. Ici, chaque route SAIT déjà laquelle des deux elle fait —
// donc grantEntitlement()/revokeEntitlement() sont appelées explicitement,
// pas déduites. Le garde-fou d'idempotence (entitlementSyncedForStatus)
// reste utile : un retry réseau côté client sur un POST peut arriver deux
// fois, et il ne faut jamais compter les gains/le nombre d'abonnés deux
// fois pour la même activation.
// ─────────────────────────────────────────────────────────────────────────

async function grantEntitlement(enrollmentRef) {
  const db = admin.firestore();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(enrollmentRef);
    if (!snap.exists) return;
    const fresh = snap.data();
    if (fresh.entitlementSyncedForStatus === fresh.status) return; // déjà synchronisé
    if (fresh.status !== "active") return; // garde-fou : n'accorde que si vraiment actif

    const isCreatorScope = fresh.scope === "creator";
    const entKey = entitlementKeyFor(fresh);
    const studentRef = db.doc(`users/${fresh.studentId}`);
    const creatorRef = db.doc(`users/${fresh.creatorId}`);
    const courseRef = !isCreatorScope && fresh.courseId ? db.doc(`modules/${fresh.courseId}`) : null;
    const netAmount = Number(fresh.price || 0) * (1 - PLATFORM_SHARE);

    tx.update(studentRef, { [`activeEntitlements.${entKey}`]: fresh.accessExpiresAt });
    if (courseRef) tx.update(courseRef, { enrolledCount: admin.firestore.FieldValue.increment(1) });
    tx.update(creatorRef, {
      subscriberCount: admin.firestore.FieldValue.increment(1),
      creatorEarnings: admin.firestore.FieldValue.increment(netAmount),
    });
    tx.update(enrollmentRef, { entitlementSyncedForStatus: "active" });
  });
}

/**
 * Fournie pour symétrie et pour une future action admin "annuler/
 * rembourser un accès actif" — RIEN dans les routes livrées aujourd'hui
 * n'appelle cette fonction. L'expiration à 30 jours d'un accès déjà actif
 * ne passe jamais par une révocation active : elle se gère par simple
 * comparaison de date à la LECTURE (VideoPage.jsx / media-access-check.js
 * comparent déjà accessExpiresAt à Date.now() à chaque vérification), donc
 * aucun job ne "coupe" quoi que ce soit à J+30 — la clé reste présente
 * dans activeEntitlements mais son timestamp est dans le passé, ce qui
 * suffit. Cette fonction ne sert que si vous ajoutez un jour une action
 * qui retire un accès qui était actif AVANT son expiration naturelle.
 */
async function revokeEntitlement(enrollmentRef) {
  const db = admin.firestore();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(enrollmentRef);
    if (!snap.exists) return;
    const fresh = snap.data();
    if (fresh.entitlementSyncedForStatus === fresh.status) return;
    if (fresh.status === "active") return; // garde-fou : ne révoque que si plus actif

    const isCreatorScope = fresh.scope === "creator";
    const entKey = entitlementKeyFor(fresh);
    const studentRef = db.doc(`users/${fresh.studentId}`);
    const creatorRef = db.doc(`users/${fresh.creatorId}`);
    const courseRef = !isCreatorScope && fresh.courseId ? db.doc(`modules/${fresh.courseId}`) : null;
    const netAmount = Number(fresh.price || 0) * (1 - PLATFORM_SHARE);

    tx.update(studentRef, { [`activeEntitlements.${entKey}`]: admin.firestore.FieldValue.delete() });
    if (courseRef) tx.update(courseRef, { enrolledCount: admin.firestore.FieldValue.increment(-1) });
    tx.update(creatorRef, {
      subscriberCount: admin.firestore.FieldValue.increment(-1),
      creatorEarnings: admin.firestore.FieldValue.increment(-netAmount),
    });
    tx.update(enrollmentRef, { entitlementSyncedForStatus: fresh.status });
  });
}

module.exports = { grantEntitlement, revokeEntitlement, creatorEntitlementKey };
