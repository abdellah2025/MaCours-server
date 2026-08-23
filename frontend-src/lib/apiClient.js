import { auth } from "../firebase";

// Ajustez si votre serveur a une autre URL — c'est la même base que celle
// déjà utilisée pour /media dans VideoPage.jsx.
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || "https://two-be-ensamaine-server-2.onrender.com";

/**
 * Remplace httpsCallable() maintenant que le backend vit sur Express/Render
 * (plan Spark, pas de Cloud Functions). Attache automatiquement le token
 * Firebase — même principe que VideoPage.jsx pour /media, généralisé ici à
 * toutes les routes protégées du serveur.
 *
 * Contrairement à httpsCallable (qui lève une exception avec .code/.message
 * structurés), ceci lève une simple Error dont .message est le texte déjà
 * prêt à afficher — vos `catch (err) { alert(err.message) }` existants
 * n'ont besoin d'aucun changement.
 */
async function apiCall(method, path, body) {
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : null;

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Erreur serveur (${res.status})`);
  }
  return data;
}

export const apiPost = (path, body) => apiCall("POST", path, body);
export const apiGet = (path) => apiCall("GET", path);
