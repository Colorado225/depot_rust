/**
 * LOT 11 — Garde-fous de permissions du système de fichiers.
 *
 * Le poste est mono-utilisateur (décision du 16/11/2026), mais plusieurs
 * comptes OS peuvent coexister (administrateur, technicien, compte de secours)
 * et un dossier copié perd ses ACL d'origine. On force donc :
 *   - répertoire de données / sauvegardes / restauration : 0700
 *   - base SQLite, sidecars WAL, sauvegardes, marqueurs    : 0600
 *
 * Ces appels sont sans effet sur Windows (ACL héritées du profil) : le
 * durcissement Windows reste un point ouvert du LOT 11 (§6.2, lot 11.2).
 */
import fs from 'node:fs';

const isUnix = process.platform !== 'win32';

/** Crée le répertoire s'il manque et force 0700 (Unix uniquement). */
export function ensurePrivateDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (isUnix) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Un répertoire verrouillé par un autre processus n'empêche pas le démarrage.
    }
  }
}

/** Force 0600 sur un fichier existant (Unix uniquement). */
export function restrictFile(filePath: string): void {
  if (!isUnix) return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Fichier absent ou verrouillé : la protection est appliquée au prochain accès.
  }
}

/** Force 0600 sur la base et ses sidecars WAL (appelé après ouverture SQLite). */
export function restrictDatabaseFiles(dbFilePath: string): void {
  restrictFile(dbFilePath);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    restrictFile(`${dbFilePath}${suffix}`);
  }
}
