const express = require("express");
const admin = require("firebase-admin");
const { verifyAuth } = require("../middleware/verifyAuth.cjs");
const { requireAdmin } = require("../middleware/requireAdmin.cjs");

const router = express.Router();

// ── GET /api/admin/platform-stats ───────────────────────────────────────
// INCHANGÉ. Équivalent de getPlatformStats. Volontairement une route
// serveur et pas des getDocs() directs côté client : ces requêtes ne
// filtrent ni par creatorId ni par studentId (where("status","==","active")
// par ex.), donc Firestore ne peut jamais prouver isEnrollmentCreator/
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

// ═══════════════════════════════════════════════════════════════════════
// NOUVEAU — Annuaire global des comptes (cahier des charges §6 : directory
// global, recherche, filtres, tri, niveau, statut). N'existait dans aucun
// fichier fourni. Même raisonnement que platform-stats ci-dessus : lecture
// non scopée par creatorId → passe par l'Admin SDK côté serveur, jamais
// par un getDocs() direct côté client.
//
// Champs renvoyés : uniquement ceux confirmés ailleurs dans votre projet
// (isAdmin, isCreator, excludeFromFinance — déjà lus dans platform-stats
// ci-dessus ; username/email/avatarUrl/lastActive — déjà utilisés par
// l'ancien Dashboard.jsx). `phone` et `level` sont lus AU CAS OÙ le champ
// existerait déjà sur vos documents `users` ; s'il n'existe pas, la valeur
// sera simplement `null` et le frontend masque déjà la colonne dans ce
// cas — aucune donnée n'est inventée.
// ═══════════════════════════════════════════════════════════════════════

router.get("/accounts", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const db = admin.firestore();
    const snap = await db.collection("users").get();
    const accounts = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        fullName: data.fullName || null,
        username: data.username || null,
        email: data.email || null,
        phone: data.phone || null,
        level: data.level || null,
        avatarUrl: data.avatarUrl || null,
        isAdmin: !!data.isAdmin,
        isCreator: !!data.isCreator,
        excludeFromFinance: !!data.excludeFromFinance,
        creatorStrikeCount: data.creatorStrikeCount || 0,
        creatorBlockedUntil: data.creatorBlockedUntil || null,
        subscriberCount: data.subscriberCount || 0,
        creatorEarnings: data.creatorEarnings || 0,
        createdAt: data.createdAt || null,
        lastActive: data.lastActive || null,
      };
    });
    res.json({ accounts });
  } catch (err) {
    console.error("GET /admin/accounts:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/admin/accounts/:id/role ───────────────────────────────────
// Promotion / retrait du rôle admin (cahier des charges §7). Protégée par
// verifyAuth + requireAdmin : seul un admin déjà authentifié côté serveur
// peut appeler cette route — jamais une simple valeur modifiée dans le
// navigateur (requireAdmin relit `users/{req.uid}.isAdmin` depuis
// Firestore à chaque appel, il ne fait jamais confiance à req.body).
router.post("/accounts/:id/role", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { isAdmin } = req.body || {};
    if (typeof isAdmin !== "boolean") {
      return res.status(400).json({ error: "Le champ 'isAdmin' doit être un booléen." });
    }
    if (req.params.id === req.uid && isAdmin === false) {
      return res.status(400).json({ error: "Vous ne pouvez pas retirer votre propre rôle admin." });
    }
    const ref = admin.firestore().doc(`users/${req.params.id}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Compte introuvable." });

    await ref.update({ isAdmin });
    res.json({ success: true });
  } catch (err) {
    console.error("POST /admin/accounts/:id/role:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

// ── POST /api/admin/accounts/:id/exclude ────────────────────────────────
// Exclusion des statistiques financières (cahier des charges §8). Utilise
// EXACTEMENT le champ `excludeFromFinance` déjà lu par /platform-stats
// ci-dessus — donc l'effet sur le revenu plateforme est immédiat, sans
// aucun autre changement backend nécessaire. Le calcul du revenu PAR
// CRÉATEUR (kpis.revenue dans hooks/useCreatorDashboard.js) est corrigé
// dans ce même livrable pour respecter ce même champ.
router.post("/accounts/:id/exclude", verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { excludeFromFinance } = req.body || {};
    if (typeof excludeFromFinance !== "boolean") {
      return res.status(400).json({ error: "Le champ 'excludeFromFinance' doit être un booléen." });
    }
    const ref = admin.firestore().doc(`users/${req.params.id}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Compte introuvable." });

    await ref.update({ excludeFromFinance });
    res.json({ success: true });
  } catch (err) {
    console.error("POST /admin/accounts/:id/exclude:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

module.exports = router;
