// server.cjs
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const admin = require("firebase-admin");
const { v4: uuidv4 } = require("uuid");

const enrollmentsRouter = require("./routes/enrollments.cjs");
const adminStatsRouter = require("./routes/adminStats.cjs");
const cronRouter = require("./routes/cron.cjs");

const app = express();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://be-ensamaine.web.app",
  "https://2beensamaine.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS: origin non autorisée — " + origin));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200,
  })
);

// ─── NEW: limites relevées pour les payloads JSON (métadonnées d'upload,
// pas les binaires — les binaires passent en multipart/form-data via multer,
// jamais par express.json). Demandé explicitement, on garde 1gb en garde-fou. ───
app.use(express.json({ limit: "1gb" }));
app.use(express.urlencoded({ limit: "1gb", extended: true }));

// ─── Multer : upload "classique" (images, pdfs, petits fichiers) ────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — au-delà, utiliser /upload/multipart/*
});

// ─── NEW: Multer dédié aux chunks — un seul chunk en mémoire à la fois,
// jamais le fichier entier. C'est ça qui règle le problème mémoire/timeout
// pour les vidéos 500Mo+. ─────────────────────────────────────────────────
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max par chunk
});

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

app.use("/api/enrollments", enrollmentsRouter);
app.use("/api/admin", adminStatsRouter);
app.use("/api/cron", cronRouter);

const s3 = new S3Client({
  region: process.env.R2_REGION || "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

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

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "2beensamaine-backend",
    timestamp: new Date().toISOString(),
  });
});

// ─── POST /upload (inchangé — petits fichiers : images, pdfs, thumbnails) ───
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

// ════════════════════════════════════════════════════════════════════════
// NEW — Upload multipart (chunké) pour les gros fichiers (vidéos 500Mo+).
// Le front découpe le fichier en chunks de ~8MB et les envoie un par un.
// Le serveur ne bufferise jamais qu'un seul chunk en mémoire ; c'est R2
// (compatible S3 Multipart Upload) qui assemble les parts côté stockage.
// Flux : /init → n × /part → /complete  (ou /abort en cas d'erreur/annulation)
// ════════════════════════════════════════════════════════════════════════

app.post("/upload/multipart/init", async (req, res) => {
  try {
    const uid = await verifyTokenIfPresent(req);
    if (!uid) return res.status(401).json({ error: "Authentification requise" });

    const { fileName, folder, contentType } = req.body;
    if (!fileName) return res.status(400).json({ error: "fileName manquant" });

    const safeName = String(fileName).replace(/\s+/g, "_");
    const key = `${folder || "uploads"}/${Date.now()}_${uuidv4()}_${safeName}`;

    const out = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        ContentType: contentType || "application/octet-stream",
      })
    );

    return res.json({ key, uploadId: out.UploadId });
  } catch (err) {
    console.error("Erreur /upload/multipart/init :", err);
    return res.status(500).json({ error: err.message || "Init échouée" });
  }
});

app.post(
  "/upload/multipart/part",
  chunkUpload.single("chunk"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Chunk manquant" });
      const { key, uploadId, partNumber } = req.body;
      if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: "key, uploadId ou partNumber manquant" });
      }

      const out = await s3.send(
        new UploadPartCommand({
          Bucket: process.env.R2_BUCKET,
          Key: key,
          UploadId: uploadId,
          PartNumber: Number(partNumber),
          Body: req.file.buffer,
        })
      );

      return res.json({ ETag: out.ETag, PartNumber: Number(partNumber) });
    } catch (err) {
      console.error("Erreur /upload/multipart/part :", err);
      return res.status(500).json({ error: err.message || "Upload du chunk échoué" });
    }
  }
);

app.post("/upload/multipart/complete", async (req, res) => {
  try {
    const { key, uploadId, parts } = req.body;
    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: "key, uploadId ou parts manquant" });
    }

    const sortedParts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sortedParts },
      })
    );

    return res.json({ key });
  } catch (err) {
    console.error("Erreur /upload/multipart/complete :", err);
    return res.status(500).json({ error: err.message || "Finalisation échouée" });
  }
});

app.post("/upload/multipart/abort", async (req, res) => {
  try {
    const { key, uploadId } = req.body;
    if (!key || !uploadId) return res.status(400).json({ error: "key ou uploadId manquant" });

    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        UploadId: uploadId,
      })
    );
    return res.json({ aborted: true });
  } catch (err) {
    console.error("Erreur /upload/multipart/abort :", err);
    return res.status(500).json({ error: err.message || "Abandon échoué" });
  }
});

// ─── GET /media (inchangé) ────────────────────────────────────────────────
app.get("/media", async (req, res) => {
  try {
    const fileKey = req.query.file;
    if (!fileKey) {
      return res.status(400).json({ error: "Paramètre 'file' manquant" });
    }
    const isPublic = String(process.env.PUBLIC_MEDIA).toLowerCase() === "true";
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
    const url = await getSignedUrl(s3, getCmd, { expiresIn: 300 });
    return res.json({ url, expiresIn: 300 });
  } catch (err) {
    console.error("Erreur /media :", err);
    return res.status(500).json({ error: err.message || "Erreur serveur" });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
console.log("Bucket   =", process.env.R2_BUCKET);
console.log("Endpoint =", process.env.R2_ENDPOINT);
console.log("PUBLIC_MEDIA =", process.env.PUBLIC_MEDIA);

const server = app.listen(PORT, () =>
  console.log(`🚀 Serveur en écoute sur le port ${PORT}`)
);

// NEW — Timeouts relevés : évite les coupures sur les uploads longs
// (Render/Node coupe par défaut au bout de 2 min d'inactivité HTTP).
server.timeout = 15 * 60 * 1000;        // 15 min par requête
server.keepAliveTimeout = 65 * 1000;    // > timeout des load balancers habituels
server.headersTimeout = 66 * 1000;      // doit être > keepAliveTimeout
