const express = require("express");
const admin = require("firebase-admin");
const { verifyAuth } = require("../middleware/verifyAuth.cjs");
const { requireAdmin } = require("../middleware/requireAdmin.cjs");
const { grantEntitlement, revokeEntitlement } = require("../lib/entitlementSync.cjs");

const router = express.Router();
const db = () => admin.firestore();

const PROVISIONAL_WINDOW_MS = 24 * 60 * 60 * 1000; // Étape 0
const ACCESS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // durée par défaut après Étape 2 / octroi admin

// Petit utilitaire pour propager un code HTTP précis depuis l'intérieur
// d'une runTransaction() (qui ne peut que rejeter, pas répondre) jusqu'au
// catch du handler qui, lui, a accès à `res`.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// NOUVEAU — durée d'accès flexible pour /admin-grant (cf. cahier des
// charges §15 : jours / 1 mois / 2 mois / etc.). `durationDays` est
// optionnel : s'il est absent, invalide ou <= 0, on retombe sur les 30
// jours historiques (ACCESS_DURATION_MS) — comportement inchangé par
// défaut. Volontairement PAS appliqué à /submit ni /admin-validate : ces
// deux routes finalisent une inscription dont la durée est déjà déterminée
// par le plan choisi par l'étudiant (planId/planName) à la soumission ;
// seul l'octroi direct par l'admin (bypass, sans inscription préalable)
// a besoin d'une durée ajustable au cas par cas.
function resolveDurationMs(durationDays) {
  const d = Number(durationDays);
  if (!Number.isFinite(d) || d <= 0) return ACCESS_DURATION_MS;
  return Math.round(d) * 24 * 60 * 60 * 1000;
}

// ── POST /api/enrollments/submit ────────────────────────────────────────
// Équivalent de submitEnrollment. accessExpiresAt calculé ICI, côté
// serveur — jamais transmis par le client, sinon n'importe qui pourrait
// s'auto-attribuer 10 ans d'accès.
router.post("/submit", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { courseId, creatorId: creatorIdInput, scope, planId, planName, price, currency } =
      req.body || {};
    const isCreatorScope = scope === "creator";

    let creatorId = creatorIdInput || null;
    let courseName = null;
    let resolvedPrice = Number(price ?? 0);

    if (!isCreatorScope) {
      if (!courseId) return res.status(400).json({ error: "courseId manquant." });
      const courseSnap = await db().doc(`modules/${courseId}`).get();
      if (!courseSnap.exists) return res.status(404).json({ error: "Cours introuvable." });
      const course = courseSnap.data();
      creatorId = course.creatorId;
      courseName = course.title || "";
      if (price == null) resolvedPrice = Number(course.price ?? 0);
    } else if (!creatorId) {
      return res.status(400).json({ error: "creatorId manquant pour un accès global (ALL_ACCESS)." });
    }

    const [studentSnap, creatorSnap] = await Promise.all([
      db().doc(`users/${uid}`).get(),
      db().doc(`users/${creatorId}`).get(),
    ]);
    if (!creatorSnap.exists) return res.status(404).json({ error: "Créateur introuvable." });
    const student = studentSnap.exists ? studentSnap.data() : {};
    const creator = creatorSnap.data();

    const enrollmentRef = db().collection("enrollments").doc();
    await enrollmentRef.set({
      studentId: uid,
      studentName: student.username || "",
      studentEmail: student.email || "",
      scope: isCreatorScope ? "creator" : "course",
      courseId: isCreatorScope ? null : courseId,
      courseName: isCreatorScope ? null : courseName,
      creatorId,
      creatorName: creator.username || "",
      planId: planId || null,
      planName: planName || null,
      price: resolvedPrice,
      currency: currency || "MAD",
      status: "provisional",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      accessExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + PROVISIONAL_WINDOW_MS),
      creatorValidation: null,
      adminValidation: null,
      rejection: null,
      revocation: null,
      isAdminBypass: false,
      entitlementSyncedForStatus: null,
    });

    res.json({ enrollmentId: enrollmentRef.id });
  } catch (err) {
    console.error("POST /enrollments/submit:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/enrollments/:id/creator-validate ──────────────────────────
// Équivalent de creatorValidateEnrollment (Étape 1). Refuse si le créateur
// est sanctionné (règle des 3 essais) — double haie avec le Dashboard qui
// cache/désactive déjà ce bouton côté UI.
router.post("/:id/creator-validate", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const ref = db().doc(`enrollments/${req.params.id}`);

    const creatorSnap = await db().doc(`users/${uid}`).get();
    const blockedUntil = creatorSnap.data()?.creatorBlockedUntil;
    if (blockedUntil && blockedUntil.toMillis() > Date.now()) {
      return res.status(403).json({
        error: `Validation suspendue jusqu'au ${blockedUntil.toDate().toLocaleDateString("fr-FR")} ` +
          `(3 validations non confirmées par l'admin dans les temps).`,
      });
    }

    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, "Inscription introuvable.");
      const enrollment = snap.data();

      if (enrollment.creatorId !== uid) {
        throw httpError(403, "Cette inscription ne concerne pas vos cours.");
      }
      if (enrollment.status !== "provisional") {
        throw httpError(409, "Cette inscription n'est plus en attente de validation.");
      }
      if (enrollment.accessExpiresAt.toMillis() < Date.now()) {
        throw httpError(409, "La fenêtre de 24h est dépassée — l'étudiant doit soumettre une nouvelle demande.");
      }

      tx.update(ref, {
        status: "creator_approved",
        creatorValidation: { validatedBy: uid, validatedAt: admin.firestore.FieldValue.serverTimestamp() },
      });
    });

    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("POST /enrollments/:id/creator-validate:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/enrollments/:id/admin-validate ────────────────────────────
// Équivalent de adminValidateEnrollment (Étape 2, admin uniquement).
// creator_approved -> active, accessExpiresAt prolongé à 30 jours. Appelle
// ensuite grantEntitlement() explicitement — ce qui remplace le trigger
// onEnrollmentWrite, impossible sans Blaze.
router.post("/:id/admin-validate", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const uid = req.uid;
    const ref = db().doc(`enrollments/${req.params.id}`);

    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, "Inscription introuvable.");
      const enrollment = snap.data();

      if (enrollment.status !== "creator_approved") {
        throw httpError(409, "Cette inscription doit d'abord être validée par le créateur (Étape 1).");
      }

      tx.update(ref, {
        status: "active",
        adminValidation: { validatedBy: uid, validatedAt: admin.firestore.FieldValue.serverTimestamp() },
        accessExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + ACCESS_DURATION_MS),
      });
    });

    await grantEntitlement(ref);

    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("POST /enrollments/:id/admin-validate:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/enrollments/:id/reject ────────────────────────────────────
// Équivalent de rejectEnrollment. Créateur (sur ses propres provisional)
// ou admin (à tout stade non final). Ne compte jamais comme un des 3
// essais — seul un timeout après creator_approved en est un (voir
// jobs/expireStaleEnrollments.cjs).
router.post("/:id/reject", verifyAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const userSnap = await db().doc(`users/${uid}`).get();
    const isAdmin = userSnap.data()?.isAdmin === true;
    const ref = db().doc(`enrollments/${req.params.id}`);

    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, "Inscription introuvable.");
      const enrollment = snap.data();

      const isOwningCreator = enrollment.creatorId === uid;
      if (!isAdmin && !isOwningCreator) {
        throw httpError(403, "Cette inscription ne concerne pas vos cours.");
      }
      if (!["provisional", "creator_approved"].includes(enrollment.status)) {
        throw httpError(409, "Cette inscription ne peut plus être rejetée.");
      }

      tx.update(ref, {
        status: "rejected",
        rejection: { rejectedBy: uid, rejectedAt: admin.firestore.FieldValue.serverTimestamp() },
      });
    });

    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("POST /enrollments/:id/reject:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/enrollments/:id/revoke ────────────────────────────────────
// NOUVEAU (cahier des charges §16 — révocation d'un accès actif par
// l'admin). N'existait dans aucun fichier fourni. Symétrique de
// /admin-validate : passe le statut à "revoked" dans une transaction, PUIS
// appelle revokeEntitlement() — qui existait déjà dans
// lib/entitlementSync.cjs, exportée, mais jamais appelée nulle part
// jusqu'ici. revokeEntitlement() lit le statut FRAIS du document (donc
// après la transaction ci-dessous) et, le voyant différent de "active",
// décrémente subscriberCount/creatorEarnings/enrolledCount et retire la
// clé dans activeEntitlements — sans jamais toucher à user_stats : les
// données pédagogiques de l'étudiant (vidéos, quiz, progression) sont
// conservées, conformément à la consigne "ne pas supprimer l'historique".
router.post("/:id/revoke", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const uid = req.uid;
    const ref = db().doc(`enrollments/${req.params.id}`);

    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, "Inscription introuvable.");
      const enrollment = snap.data();

      if (enrollment.status !== "active") {
        throw httpError(409, "Seul un accès actif (status = 'active') peut être révoqué.");
      }

      tx.update(ref, {
        status: "revoked",
        revocation: { revokedBy: uid, revokedAt: admin.firestore.FieldValue.serverTimestamp() },
      });
    });

    await revokeEntitlement(ref);

    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("POST /enrollments/:id/revoke:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/enrollments/admin-grant ───────────────────────────────────
// Équivalent de adminGrantAccess (bypass admin). Crée directement un
// enrollment "active", sans passer par la double validation, puis appelle
// grantEntitlement(). MODIFIÉ : accepte maintenant `durationDays` en plus
// des champs existants — voir resolveDurationMs() ci-dessus. Tous les
// champs déjà présents (studentId, courseId, creatorId, scope, price,
// planName) sont inchangés ; `durationDays` est simplement lu en plus,
// donc un appel qui ne l'envoie pas garde exactement le comportement
// actuel (30 jours).
router.post("/admin-grant", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const uid = req.uid;
    const { studentId, courseId, creatorId: creatorIdInput, scope, price, planName, durationDays } =
      req.body || {};
    if (!studentId) return res.status(400).json({ error: "studentId manquant." });

    const isCreatorScope = scope === "creator";
    let creatorId = creatorIdInput || null;
    let courseName = null;

    if (!isCreatorScope) {
      if (!courseId) return res.status(400).json({ error: "courseId manquant." });
      const courseSnap = await db().doc(`modules/${courseId}`).get();
      if (!courseSnap.exists) return res.status(404).json({ error: "Cours introuvable." });
      creatorId = courseSnap.data().creatorId;
      courseName = courseSnap.data().title || "";
    } else if (!creatorId) {
      return res.status(400).json({ error: "creatorId manquant pour un accès global (ALL_ACCESS)." });
    }

    const [studentSnap, creatorSnap] = await Promise.all([
      db().doc(`users/${studentId}`).get(),
      db().doc(`users/${creatorId}`).get(),
    ]);
    if (!studentSnap.exists) return res.status(404).json({ error: "Étudiant introuvable." });
    if (!creatorSnap.exists) return res.status(404).json({ error: "Créateur introuvable." });

    const enrollmentRef = db().collection("enrollments").doc();
    const accessExpiresAt = admin.firestore.Timestamp.fromMillis(
      Date.now() + resolveDurationMs(durationDays),
    );

    await enrollmentRef.set({
      studentId,
      studentName: studentSnap.data().username || "",
      studentEmail: studentSnap.data().email || "",
      scope: isCreatorScope ? "creator" : "course",
      courseId: isCreatorScope ? null : courseId,
      courseName: isCreatorScope ? null : courseName,
      creatorId,
      creatorName: creatorSnap.data().username || "",
      planId: null,
      planName: planName || "Accès direct (Admin)",
      price: Number(price ?? 0),
      currency: "MAD",
      status: "active",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      accessExpiresAt,
      creatorValidation: null,
      adminValidation: { validatedBy: uid, validatedAt: admin.firestore.FieldValue.serverTimestamp() },
      rejection: null,
      revocation: null,
      isAdminBypass: true,
      entitlementSyncedForStatus: null,
    });

    await grantEntitlement(enrollmentRef);

    res.json({ enrollmentId: enrollmentRef.id });
  } catch (err) {
    console.error("POST /enrollments/admin-grant:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

module.exports = router;
