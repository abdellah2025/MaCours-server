const admin = require("firebase-admin");

/**
 * À utiliser TOUJOURS après verifyAuth (a besoin de req.uid déjà posé).
 * Reproduit les `if (adminSnap.data()?.isAdmin !== true) throw new
 * HttpsError("permission-denied", ...)` de l'ancien functions/enrollments.js
 * — même vérification, juste posée comme middleware Express plutôt
 * qu'inline dans chaque handler `onCall`.
 */
async function requireAdmin(req, res, next) {
  if (!req.uid) {
    // Ne devrait jamais arriver si verifyAuth est bien monté avant — un
    // garde-fou explicite plutôt qu'un crash silencieux sur req.uid undefined.
    return res.status(401).json({ error: "Authentification requise." });
  }
  try {
    const snap = await admin.firestore().doc(`users/${req.uid}`).get();
    if (snap.data()?.isAdmin !== true) {
      return res.status(403).json({ error: "Réservé au Super Admin." });
    }
    next();
  } catch (err) {
    console.error("requireAdmin: vérification impossible:", err.message);
    return res.status(500).json({ error: "Vérification impossible." });
  }
}

module.exports = { requireAdmin };
