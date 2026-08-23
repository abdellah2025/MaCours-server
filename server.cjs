// server.cjs
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

// ─── NEW: routes migrées depuis Cloud Functions (plan Spark, pas de Blaze) ───
// Chaque fichier fait `require("firebase-admin")` et appelle admin.firestore()/
// admin.auth() UNIQUEMENT à l'intérieur de ses handlers (jamais au chargement
// du module) — donc peu importe que ces `require` soient exécutés avant ou
// après le bloc d'initialisation Firebase Admin plus bas, tant que ce bloc
// s'exécute AVANT qu'une vraie requête HTTP n'arrive, ce qui est toujours le
// cas ici (l'initialisation est synchrone, au démarrage du process).
const enrollmentsRouter = require("./routes/enrollments.cjs");
const adminStatsRouter = require("./routes/adminStats.cjs");
const cronRouter = require("./routes/cron.cjs");

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();

// ─── CORS (global — couvre TOUTES les réponses, y compris 401/400/500) ───────
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://be-ensamaine.web.app",
  "https://2beensamaine.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Autoriser les requêtes sans Origin (Postman, mobile, curl…)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS: origin non autorisée — " + origin));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200, // Compatibilité IE11
  })
);

app.use(express.json());

// ─── Multer (fichiers en mémoire) ────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ─── Firebase Admin ──────────────────────────────────────────────────────────
let db = null;
let auth = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    auth = admin.auth();
    console.log("Firebase Admin initialized ✅");
  } catch (e) {
    console.error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON ❌", e.message);
  }
} else {
  console.warn("⚠️  FIREBASE_SERVICE_ACCOUNT_JSON absent — vérification token désactivée");
}

// ─── NEW: routes enrollments / admin / cron ──────────────────────────────────
// Toutes les routes de enrollmentsRouter et adminStatsRouter font
// admin.auth()/admin.firestore() en interne — si FIREBASE_SERVICE_ACCOUNT_JSON
// est absent (bloc juste au-dessus), aucune admin.App n'existe et ces routes
// répondront par une erreur 500 explicite au lieu de planter le process ;
// c'est un pré-requis pour toute cette fonctionnalité, pas optionnel comme
// pour /media plus bas.
app.use("/api/enrollments", enrollmentsRouter);
app.use("/api/admin", adminStatsRouter);
app.use("/api/cron", cronRouter);

// ─── Cloudflare R2 (compatible S3) ───────────────────────────────────────────
const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

// ─── Helper : vérification optionnelle du token Firebase ─────────────────────
async function verifyTokenIfPresent(req) {
  if (!auth) return null;
  const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    const decoded = await auth.verifyIdToken(token);
    return decoded.uid;
  } catch (e) {
    console.warn("Token invalide :", e.message);
    return null;
  }
}

// ─── Health-check ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "2beensamaine-backend",
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /upload ─────────────────────────────────────────────────────────────
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier reçu" });
    }

    const folder = req.body.folder || "uploads";
    const safeName = req.file.originalname.replace(/\s+/g, "_");
    const key = `${folder}/${Date.now()}_${uuidv4()}_${safeName}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      })
    );

    return res.json({ key });
  } catch (err) {
    console.error("Erreur /upload :", err);
    return res.status(500).json({ error: err.message || "Upload échoué" });
  }
});

// ─── GET /media ───────────────────────────────────────────────────────────────
app.get("/media", async (req, res) => {
  try {
    const fileKey = req.query.file;
    if (!fileKey) {
      return res.status(400).json({ error: "Paramètre 'file' manquant" });
    }

    // Comparaison robuste : "true" / "True" / "TRUE" → tous acceptés
    const isPublic =
      String(process.env.PUBLIC_MEDIA).toLowerCase() === "true";

    if (!isPublic) {
      const uid = await verifyTokenIfPresent(req);
      if (!uid) {
        return res.status(401).json({ error: "Authentification requise" });
      }
    }

    const getCmd = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: fileKey,
    });

    const url = await getSignedUrl(s3, getCmd, { expiresIn: 300 }); // 5 min
    return res.json({ url, expiresIn: 300 });
  } catch (err) {
    console.error("Erreur /media :", err);
    return res.status(500).json({ error: err.message || "Erreur serveur" });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
console.log("Bucket   =", process.env.R2_BUCKET);
console.log("Endpoint =", process.env.R2_ENDPOINT);
console.log("PUBLIC_MEDIA =", process.env.PUBLIC_MEDIA);
app.listen(PORT, () => console.log(`🚀 Serveur en écoute sur le port ${PORT}`));
