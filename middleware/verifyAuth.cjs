const admin = require("firebase-admin");

/**
 * Remplace ce que `onCall` faisait automatiquement (exposer `request.auth`)
 * — ici il faut vérifier le token Firebase à la main, exactement comme
 * checkVideoAccess() le fait déjà pour votre route /media. Attache
 * `req.uid` en cas de succès ; toute route protégée le lit ensuite.
 *
 * Le client doit envoyer le header :
 *   Authorization: Bearer <idToken>
 * (obtenu via `await auth.currentUser.getIdToken()`) — voir
 * src/lib/apiClient.js côté front.
 */
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Authentification requise." });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    console.error("verifyAuth: token invalide:", err.message);
    return res.status(401).json({ error: "Token invalide ou expiré." });
  }
}

module.exports = { verifyAuth };
