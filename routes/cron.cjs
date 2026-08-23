const express = require("express");
const { expireStaleEnrollments } = require("../jobs/expireStaleEnrollments.cjs");

const router = express.Router();

/**
 * Protégée par un SECRET PARTAGÉ, pas par un token Firebase — cette route
 * est appelée par un service de cron externe (cron-job.org ou équivalent),
 * jamais par un utilisateur connecté. Générez une chaîne aléatoire longue
 * (ex. `openssl rand -hex 32`) et mettez-la dans la variable d'environnement
 * CRON_SECRET sur Render — jamais en dur dans le code.
 *
 * Configuration côté cron-job.org : URL =
 * https://<votre-service>.onrender.com/api/cron/expire-stale-enrollments,
 * méthode POST, header personnalisé "x-cron-secret: <la même valeur>",
 * intervalle 15 min.
 */
router.post("/expire-stale-enrollments", async (req, res) => {
  const provided = req.headers["x-cron-secret"];
  if (!process.env.CRON_SECRET) {
    console.error("POST /cron/expire-stale-enrollments: CRON_SECRET absent des variables d'environnement.");
    return res.status(500).json({ error: "Non configuré." });
  }
  if (!provided || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Non autorisé." });
  }

  try {
    const result = await expireStaleEnrollments();
    console.log(
      `expire-stale-enrollments: ${result.expired} inscription(s) expirée(s), ` +
        `${result.strikedCreators} créateur(s) impacté(s).`,
    );
    res.json(result);
  } catch (err) {
    console.error("POST /cron/expire-stale-enrollments:", err);
    res.status(500).json({ error: "Une erreur est survenue." });
  }
});

module.exports = router;
