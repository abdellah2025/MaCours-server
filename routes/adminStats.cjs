const express = require("express");
const admin = require("firebase-admin");
const { verifyAuth } = require("../middleware/verifyAuth.cjs");
const { requireAdmin } = require("../middleware/requireAdmin.cjs");

const router = express.Router();

// ── GET /api/admin/platform-stats ───────────────────────────────────────
// Équivalent de getPlatformStats. Volontairement une route serveur et pas
// des getDocs() directs côté client : ces requêtes ne filtrent ni par
// creatorId ni par studentId (where("status","==","active") par ex.),
// donc Firestore ne peut jamais prouver isEnrollmentCreator/
// isEnrollmentStudent à partir de la requête elle-même ("les règles ne
// sont pas des filtres" — doc Firestore officielle). Passer par ce serveur
// (qui utilise l'Admin SDK, lequel contourne les règles) élimine cette
// classe de bug entièrement.
router.get("/platform-stats", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const db = admin.firestore();
    const [usersSnap, activeSnap, awaitingSnap] = await Promise.all([
      db.collection("users").get(),
      db.collection("enrollments").where("status", "==", "active").get(),
      db.collection("enrollments").where("status", "==", "creator_approved").get(),
    ]);

    const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const activeEnr = activeSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const awaitingEnr = awaitingSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const excluded = new Set(users.filter((u) => u.excludeFromFinance).map((u) => u.id));
    const revenue = activeEnr
      .filter((e) => !excluded.has(e.studentId))
      .reduce((a, e) => a + (Number(e.price) || 0), 0);

    res.json({
      revenue,
      studentsCount: new Set(activeEnr.map((e) => e.studentId)).size,
      creatorsCount: users.filter((u) => u.isCreator).length,
      totalUsers: users.length,
      // Timestamps volontairement exclus (createdAt/accessExpiresAt) — pas
      // besoin côté Dashboard, et évite tout souci de sérialisation JSON.
      awaiting: awaitingEnr.map((e) => ({
        id: e.id,
        studentId: e.studentId,
        studentName: e.studentName,
        studentEmail: e.studentEmail,
        creatorId: e.creatorId,
        creatorName: e.creatorName,
        courseId: e.courseId,
        courseName: e.courseName,
        scope: e.scope,
        price: e.price,
        currency: e.currency,
        isAdminBypass: e.isAdminBypass,
      })),
    });
  } catch (err) {
    console.error("GET /admin/platform-stats:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

module.exports = router;
