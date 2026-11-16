/**
 * LOT 11.6 — Base de prévisualisation strictement séparée.
 *
 * Problème constaté : la recette web (`npm run dev`, aperçu navigateur)
 * utilisait la même base que le futur poste installé, `data/depotpro.db`.
 * Un essai de migration ou une manipulation de données en recette modifiait
 * donc les données commerciales réelles, et réciproquement.
 *
 * Règle appliquée ici : quand le processus n'est PAS le poste installé, la base
 * vit dans `data/preview/` et le chiffrement est refusé (pas de clé de
 * production dans un aperçu jetable). Une variable explicite
 * `DEPOTPRO_DATA_DIR` reste prioritaire : l'opérateur qui pointe un dossier
 * sait ce qu'il fait.
 *
 * Le garde-fou est volontairement *fail-closed* : si le mode ne peut pas être
 * déterminé, on refuse d'ouvrir la base de production plutôt que de risquer
 * d'écrire dedans.
 */
import path from 'node:path';

/** Sous-dossier de prévisualisation, à l'intérieur du dossier de données. */
export const PREVIEW_SUBDIR = 'preview';

export interface DataPathDecision {
  /** Dossier de données effectif. */
  dataDir: string;
  /** Chemin complet de la base. */
  dbPath: string;
  /** `true` si l'on est en mode prévisualisation (base jetable). */
  preview: boolean;
  /** Explication lisible, affichée par `/api/system/health`. */
  reason: string;
}

/**
 * `true` quand le processus est un aperçu (dev web, recette, CI) et non le
 * poste installé. La coquille Tauri passe `DEPOTPRO_DESKTOP=1`.
 */
export function isPreviewMode(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.DEPOTPRO_DESKTOP === '1') return false;
  if (env.DEPOTPRO_PREVIEW === '0') return false;
  if (env.DEPOTPRO_PREVIEW === '1') return true;
  // Poste installé : aucune variable n'est posée par la coquille Tauri dans le
  // cas desktop, mais NODE_ENV=production sur un serveur n'est PAS un poste
  // installé. Le seul signal fiable est l'absence de mode desktop combinée à
  // l'exécution sous Node (le desktop n'embarque aucun sidecar). On choisit
  // donc la prudence : tout processus Node qui n'est pas explicitement
  // desktop est une prévisualisation.
  return env.DEPOTPRO_DESKTOP !== '1';
}

/**
 * Décide du dossier de données et de la base à ouvrir.
 *
 * Ordre de priorité :
 *   1. `DEPOTPRO_DATA_DIR` explicite → respecté tel quel (recette maîtrisée) ;
 *   2. dossier par défaut `<cwd>/data` en mode desktop ;
 *   3. `<cwd>/data/preview` en mode aperçu.
 */
export function resolveDataPaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): DataPathDecision {
  const explicitDir = env.DEPOTPRO_DATA_DIR;
  const baseDir = path.resolve(cwd, 'data');

  if (explicitDir && explicitDir.trim().length > 0) {
    const dataDir = path.resolve(explicitDir);
    // Un dossier explicite n'est jamais la base de production par accident :
    // il est pris tel quel, la responsabilité est à l'opérateur.
    return {
      dataDir,
      dbPath: path.join(dataDir, 'depotpro.db'),
      preview: path.resolve(dataDir) === path.resolve(baseDir) ? false : isPreviewMode(env),
      reason: `dossier de données imposé par DEPOTPRO_DATA_DIR (${dataDir}).`,
    };
  }

  if (isPreviewMode(env)) {
    const dataDir = path.join(baseDir, PREVIEW_SUBDIR);
    return {
      dataDir,
      dbPath: path.join(dataDir, 'depotpro.db'),
      preview: true,
      reason:
        "mode prévisualisation : la base vit dans data/preview/ et n'est jamais la base du poste installé.",
    };
  }

  return {
    dataDir: baseDir,
    dbPath: path.join(baseDir, 'depotpro.db'),
    preview: false,
    reason: 'mode poste installé (DEPOTPRO_DESKTOP=1) : base de production.',
  };
}

/**
 * Refuse d'ouvrir la base de production depuis un processus d'aperçu.
 * Séparé de `resolveDataPaths` pour pouvoir être testé seul et réutilisé par
 * la coquille desktop.
 */
export function assertNotProductionInPreview(dbPath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!isPreviewMode(env)) return;
  const productionPath = path.resolve(process.cwd(), 'data', 'depotpro.db');
  if (path.resolve(dbPath) === productionPath) {
    throw new Error(
      `Refus d'ouvrir la base du poste installé (${productionPath}) depuis un processus de prévisualisation. ` +
        'Utilisez data/preview/ ou posez DEPOTPRO_DATA_DIR pour une recette isolée.'
    );
  }
}
