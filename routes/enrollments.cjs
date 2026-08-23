const express = require("express");
const admin = require("firebase-admin");
const { verifyAuth } = require("../middleware/verifyAuth.cjs");
const { requireAdmin } = require("../middleware/requireAdmin.cjs");
const { grantEntitlement } = require("../lib/entitlementSync.cjs");

const router = express.Router();
const db = () => admin.firestore();

const PROVISIONAL_WINDOW_MS = 24 * 60 * 60 * 1000; // Étape 0
const ACCESS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // après Étape 2

// Petit utilitaire pour propager un code HTTP précis depuis l'intérieur
// d'une runTransaction() (qui ne peut que rejeter, pas répondre) jusqu'au
// catch du handler qui, lui, a accès à `res`.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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

// ── POST /api/enrollments/admin-grant ───────────────────────────────────
// Équivalent de adminGrantAccess (bypass admin). Crée directement un
// enrollment "active" de 30 jours, sans passer par la double validation,
// puis appelle grantEntitlement() — mêmes deux lignes que /admin-validate,
// volontairement pas factorisées au-delà de grantEntitlement() elle-même :
// les deux routes ont des conditions d'entrée trop différentes (l'une
// modifie un enrollment existant, l'autre en crée un) pour qu'un partage
// plus poussé clarifie plutôt qu'il n'obscurcisse.
router.post("/admin-grant", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const uid = req.uid;
    const { studentId, courseId, creatorId: creatorIdInput, scope, price, planName } = req.body || {};
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
    const accessExpiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + ACCESS_DURATION_MS);

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
