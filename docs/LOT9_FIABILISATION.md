# DepotPro CI — Analyse complète du projet & LOT 9 (Fiabilisation)

> Document de travail — 15 novembre 2026 — branche `arena/18089a76-depot-rust`
> Référentiel : `Implementtion.md` (master prompt). LOT 10 (distribution Windows/macOS) **hors périmètre de ce rapport**.
>
> **Note de non-régression LOT 10 (15/11/2026)** : les migrations
> `0013_lot10_desktop_runtime.sql`, `0014_lot10_rust_native.sql` et
> `0015_lot10_rust_ipc_only.sql` ont été ajoutées après la clôture du LOT 9.
> Elles n'écrivent que dans `system_meta` (lot en cours + ADR desktop) :
> **43 tables, 40 index et `app.lot_current='LOT_9'` inchangés**, mais le nombre
> total de migrations appliquées passe de 12 à 15. Les 7 tests LOT 9 restent
> verts (compteurs désormais dérivés du répertoire `migrations/`) ; `npm test`
> = 16 fichiers / 67 tests, dont 39 tests LOT 10. La tranche 4 porte les
> sauvegardes en Rust et retire le pont HTTP sans réécrire le LOT 9 fonctionnel.
> Voir `docs/LOT10_DISTRIBUTION.md` et `docs/LOT10_PORT_RUST.md`.

---

## 1. Analyse complète du projet

### 1.1 Architecture réellement exécutée

```
React 19 / Vite 8 / Tailwind 4 (UI française)
        │  src/lib/ipc.ts → invokeBackend()  (fetch relatifs /api/*, jeton Bearer en sessionStorage)
        ▼
Express 4  (server.ts, port 3000, 0.0.0.0)  — 13 routeurs /api/*
        │  server/repositories/*.ts  (logique métier critique, validation backend)
        ▼
SQLite local  data/depotpro.db  —  WAL, foreign_keys=ON, synchronous=NORMAL, busy_timeout=5000
              12 migrations SQL versionnées + table schema_migrations (checksum SHA-256)
```

Le dossier `src-tauri/` (Tauri 2 + Rust/SQLx) est **un second runtime partiel**, pas le runtime courant :
21 commandes Rust seulement (auth, achats, finance, système), contre ~90 commandes côté pont Node.
`src/lib/ipc.ts` bascule vers `window.__TAURI_INTERNALS__.invoke()` dès que Tauri est détecté :
sur un vrai build desktop, les modules LOT 2 → LOT 9 n'auraient donc aucun handler. **Risque majeur à traiter au LOT 10.**

### 1.2 État des lots avant ce travail

| Lot | Périmètre | État constaté |
| --- | --- | --- |
| LOT 0 | Fondations SQLite, migrations, XOF | Terminé et vérifié (`tests/lot0-…`) |
| LOT 1 | Auth/RBAC, configuration dépôt, licence locale | Terminé et vérifié |
| LOT 2 | Catalogue, unités, conditionnements | Terminé et vérifié |
| LOT 3 | Stock, CUMP entier, casse, inventaires | Terminé et vérifié |
| LOT 4 | Achats, réceptions partielles, dettes | Terminé et vérifié |
| LOT 5 | Clients, POS, paiements multi-canaux, annulation | Terminé et vérifié |
| LOT 6 | Consignes / emballages séparés | Terminé et vérifié |
| LOT 7 | Caisse, dépenses, clôtures, écarts | Terminé et vérifié |
| LOT 8 | Rapports, marges CUMP, exports CSV/PDF | Terminé et vérifié |
| LOT 9 | Fiabilisation | **Non commencé** avant ce travail → **Terminé et vérifié** (28 tests) |
| LOT 10 | Distribution desktop | Non commencé (hors périmètre) |

Base de tests initiale : **9 fichiers / 21 tests, tous verts**. `tsc --noEmit` propre.
Base de tests finale : **10 fichiers / 28 tests, tous verts**, exécutée deux fois de suite pour vérifier la stabilité.

### 1.3 Existant réutilisable pour le LOT 9

- `backup_history` existe depuis `0001` (type, chemin, taille, SHA-256, statut d'intégrité, auteur) — **mais aucune route ni écriture ne l'alimentait**.
- Permission `backup.manage` semée en `0002`, attribuée au seul rôle `OWNER` — **jamais utilisée** avant ce lot.
- `schema_migrations` avec checksum SHA-256 + `initLocalSqlite()` idempotent → excellent socle pour les mises à jour sans perte.
- `SystemRepository.runIntegrityCheck()` (`PRAGMA quick_check`) et `runFoundationSelfTests()` (5 contrôles).
- `audit_logs` utilisé par tous les dépôts ; WAL + FK + `busy_timeout` déjà en place.
- Aucun appel réseau métier : uniquement des `fetch` relatifs vers `/api/*`. `@google/genai` est une dépendance non utilisée (`.env.example` est un template AI Studio sans rapport avec le métier).

### 1.4 Manques identifiés (avant implémentation)

| Exigence `Implementtion.md` §9 | Avant | Après ce travail |
| --- | --- | --- |
| Sauvegarde manuelle | Absente | **Terminé et vérifié** |
| Sauvegarde automatique | Absente | **Terminé et vérifié** |
| Historique | Table vide, aucune API | **Terminé et vérifié** |
| Export sur clé USB | Absent | **Terminé et vérifié** (fichier `.db` téléchargé + manifeste JSON, copie manuelle sur support amovible) |
| Import d'une sauvegarde externe (nouveau poste / clé USB) | Absent | **Terminé et vérifié** (upload binaire contrôlé, nom généré côté serveur, SHA-256 de transfert) |
| Manifeste de sauvegarde vérifiable hors ligne | Absent | **Terminé et vérifié** (`*.manifest.json` + endpoint de lecture + contrôle de cohérence) |
| Restauration | Absente | **Terminé et vérifié** (base séparée + activation au redémarrage) |
| Contrôle d'intégrité | `quick_check` seul | **Terminé et vérifié** (integrity_check complet, foreign_key_check, schéma, XOF, stocks, migrations) |
| Cohérence WAL | Non traitée | **Terminé et vérifié** (`VACUUM INTO`) |
| « Ne jamais écraser sans confirmation + sauvegarde préalable » | Non traité | **Terminé et vérifié** |
| « Conserver les données lors des mises à jour » | Non prouvé | **Terminé et vérifié** (scénario O) |
| Performance (index) | 31 index | 40 index (+9) |
| Sécurité | RBAC métier | + `backup.manage`, `no-store`, `nosniff`, SHA-256, refus des copies altérées |
| Tests de non-régression M / N / O | Absents | **7 tests LOT 9 / 28 au total**, tous verts |

### 1.5 Points d'attention relevés par l'analyse

1. **Double système de migrations** : Node utilise `schema_migrations`, Rust/SQLx utilise `_sqlx_migrations`. Si les deux runtimes ouvrent la même base, les migrations seraient appliquées deux fois. À harmoniser au LOT 10.
2. **Parité Tauri manquante** : les commandes LOT 2 → LOT 9 n'existent pas en Rust.
3. **Dépendances** : `npm install` échouait (`esbuild@^0.25` incompatible avec Vite 8 qui exige `^0.27 || ^0.28`) et `react-is` (pair de Recharts) n'était pas installé → `npm run build` cassé. **Corrigé dans ce lot** (fiabilisation de la chaîne de build).
4. **Hôte de prévisualisation** : Vite 8 refuse par défaut un `Host` autre que `localhost` → `allowedHosts: ['.e2b.app']` ajouté.
5. `INSERT OR REPLACE INTO system_meta` dans les migrations réinitialise `updated_at` : acceptable, mais à remplacer par `ON CONFLICT DO UPDATE` si un historique fin est nécessaire.

---

## 2. Conception LOT 9 — décisions d'architecture

| Décision | Choix | Justification |
| --- | --- | --- |
| Méthode de copie | `VACUUM INTO ?` | Instantané compacté, atomique et cohérent avec WAL (inclut les frames validés), contrairement à un simple `copyFile` qui perdrait le `-wal`. |
| Traçabilité | `backup_history` + `audit_logs` + SHA-256 du fichier | Permet de détecter corruption, déplacement ou falsification. |
| Vérification | `PRAGMA integrity_check` + `PRAGMA foreign_key_check` + schéma complet | `quick_check` seul est insuffisant pour une restauration. |
| Restauration | **Jamais à chaud** : copie vers `data/restore/*.db`, migrations appliquées sur la copie, contrôles, puis marqueur `data/restore-pending.json`, activation au prochain démarrage | La connexion `DatabaseSync` reste ouverte pendant l'exécution : remplacer le fichier à chaud corromprait la session. |
| Sécurité de la restauration | Confirmation littérale `RESTAURER` validée **côté backend**, sauvegarde `PRE_RESTORE` obligatoire, copie brute `depotpro.pre-restore-*.db` conservée, refus si marqueur déjà présent | « Ne jamais écraser une base existante sans confirmation et sauvegarde préalable ». |
| WAL au moment du swap | `wal_checkpoint(TRUNCATE)` puis suppression des sidecars avant remplacement | Évite qu'un WAL de l'ancienne base soit rejoué sur la nouvelle. |
| Purge | Uniquement les copies `AUTO` surnuméraires | Aucune transaction validée n'est jamais supprimée physiquement. |
| Droits | Toutes les routes exigent `backup.manage` (OWNER par défaut) | Une restauration est l'opération la plus destructive du logiciel. |
| Manifeste | `<fichier>.db.manifest.json` avec `backupId`, SHA-256, version du lot, XOF, résultat d'intégrité | Contrôle possible sans ouvrir l'application ; un manifeste falsifié fait échouer la vérification. |
| Import externe | `POST /api/system/backups/import` en `application/octet-stream`, 256 Mo max, nom de fichier **généré par UUID**, SHA-256 calculé dans le navigateur et revérifié côté serveur | Portabilité vers un nouveau poste sans dépendance réseau ; aucune traversée de chemin possible. |

`adr.backup_strategy`, `adr.restore_safety` et `adr.restore_portability` sont enregistrées dans `system_meta` (catégorie `ARCHITECTURE`).

---

## 3. Rapport d'avancement LOT 9 (format `Implementtion.md` §15)

### Objectif

Démarrer la fiabilisation : garantir que **les données survivent aux redémarrages, aux mises à jour et aux restaurations**, sans réécrire le code fonctionnel des lots 0 → 8.

### Fichiers créés

| Fichier | Rôle |
| --- | --- |
| `migrations/0011_lot9_reliability.sql` | 8 index de performance, configuration sauvegardes, 2 ADR, `app.lot_current = LOT_9` |
| `migrations/0012_lot9_restore_portability.sql` | Colonne non destructive `backup_history.origin` (`LOCAL` / `IMPORTED`), index, ADR de portabilité, limite d’import |
| `server/db/pendingRestore.ts` | SHA-256 par blocs, inspection SQLite en lecture seule, marqueur de restauration, activation sûre au démarrage |
| `server/repositories/backupRepo.ts` | Sauvegardes, manifestes, historique, vérification, purge, auto, import externe, restauration sur base séparée |
| `server/repositories/reliabilityRepo.ts` | Diagnostic étendu (10 contrôles) + batterie de non-régression LOT 9 (12 contrôles) |
| `server/routes/backups.ts` | 12 endpoints RBAC `backup.manage` (dont `/import` binaire et `/:id/manifest`) |
| `src/types/backup.ts` | Contrats TypeScript des DTO LOT 9 |
| `src/modules/foundations/services/backupService.ts` | Hooks React Query |
| `src/modules/foundations/components/BackupRestoreView.tsx` | Interface française complète |
| `tests/lot9-reliability.test.ts` | 7 tests : M, N, O, portabilité USB, refus de sécurité, migration au redémarrage, RBAC HTTP |
| `docs/LOT9_FIABILISATION.md` | Ce document |

### Fichiers modifiés

| Fichier | Modification |
| --- | --- |
| `server/db/sqlite.ts` | Appelle `applyPendingRestore()` **avant** l'ouverture de la connexion ; expose `restoreApplied` |
| `server.ts` | Monte `/api/system/backups`, en-têtes `no-store` + `nosniff`, traduction structurée des erreurs 413, planificateur de sauvegarde automatique, trace de la restauration appliquée |
| `src/lib/ipc.ts` | 9 commandes LOT 9, support `DELETE`, `downloadBackupFile()`, `importBackupFile()` (SHA-256 navigateur) |
| `src/App.tsx` | Section « Sauvegardes & Restauration » (permission `backup.manage`) |
| `src/modules/foundations/components/LotRoadmapVerificationView.tsx` | LOT 9 « Terminé et vérifié » |
| `package.json` | `esbuild ^0.28.0` (compatibilité Vite 8), `react-is ^19.0.0` (pair Recharts) |
| `vite.config.ts` | `server.allowedHosts` pour les aperçus proxifiés |
| `package-lock.json` | Verrouillage reproductible des dépendances (ajouté) |

### Fonctionnalités réalisées

- Sauvegarde manuelle, automatique (démarrage + toutes les 15 min, intervalle configurable), export USB, sauvegarde préalable à toute restauration.
- Historique consultable avec état du fichier, empreinte SHA-256, taille, auteur, origine (`LOCAL` / `Importée`), manifeste et statut d'intégrité.
- **Import d'un fichier `.db` externe** (clé USB, autre poste, réinstallation) : contrôle de l'en-tête SQLite, `integrity_check`, `foreign_key_check`, SHA-256 de transfert, puis inscription dans l'historique et création d'un manifeste.
- **Manifeste JSON** déposé à côté de chaque sauvegarde, lisible via `GET /api/system/backups/:id/manifest`, et comparé à l'empreinte enregistrée à chaque vérification.
- Vérification à la demande, téléchargement refusé si la copie est altérée ou absente.
- Restauration vérifiée sur une base séparée (avec application des migrations manquantes), comparatif du nombre de lignes avant/après, confirmation explicite, activation différée au redémarrage, annulation possible.
- Diagnostic complet et autotests de non-régression exécutables depuis l'interface.
- Planificateur local sans réseau, purge bornée des sauvegardes automatiques, limite d’import 256 Mo.

### Règles métier implémentées

- Montants XOF exclusivement entiers : détection de toute valeur non entière dans les colonnes `*_xof`.
- Stocks négatifs interdits : contrôle SQL en plus de la contrainte `CHECK`.
- Aucune suppression physique de transaction validée ; seule une **copie de sauvegarde** peut être purgée.
- Séparation stricte consignes / créances / stock / licence : inchangée, contrôlée par les tests existants.
- Logique critique côté backend : confirmation, droits, intégrité et checksum ne sont jamais validés uniquement par l'UI.
- 100 % hors ligne : aucun service distant, aucune télémétrie.

### Tests exécutés

```
npm install                 → OK (sans --legacy-peer-deps)
npm run lint (tsc --noEmit) → OK
npm run build               → OK (2 327 modules, dist/ produit)
npm test (vitest run)       → 10 fichiers / 28 tests / 28 passés (×2, stable)
Contrôle bout en bout       → index, health, setup, login, overview, create,
                              manifest, import binaire, import invalide (400),
                              diagnostics, self-test, restauration, download : OK
```

Scénarios couverts :
- **M** sauvegarde (WAL, SHA-256, manifeste, historique, audit, USB, auto, configuration) ;
- **N** restauration (base séparée, copie falsifiée rejetée, confirmation, annulation, activation au redémarrage, intégrité après swap) ;
- **O** redémarrages hors ligne ×3 + mise à jour 0010 → 0011/0012 sans perte ;
- **Portabilité** : sauvegarde d'un dépôt A importée puis restaurée sur un dépôt B, manifeste vérifié, identifiant propriétaire et données de A retrouvés ;
- **Sécurité** : fichier non SQLite, corruption de l'en-tête, SHA-256 de transfert erroné, manifeste falsifié, tentative de traversée de chemin, marqueur de restauration invalide (démarrage refuse sans toucher à la base) ;
- **Mise à jour + restauration** : sauvegarde 0010, migrations 0011/0012 appliquées sur la copie avant activation ;
- **P** (partiel) RBAC HTTP : 401 sans session, 403 Gérant, 200 Propriétaire.

### Résultats obtenus

`app.lot_current = LOT_9`, 43 tables, 12 migrations, 40 index, `journal_mode = WAL`, `foreign_keys = ON`,
`PRAGMA integrity_check = ok`, `foreign_key_check = 0`, `migrationChecksumMismatches = 0`,
`nonIntegerMoneyColumns = 0`, `negativeStockRows = 0`, `currency = XOF`,
diagnostic `overall = OK`, autotests LOT 9 `allPassed = true`.

### Problèmes rencontrés

- `npm install` en `ERESOLVE` (esbuild 0.25 vs Vite 8) et `react-is` absent → corrigés.
- Vite 8 bloquait l'hôte de prévisualisation (HTTP 403) → `allowedHosts` ajouté.
- `VACUUM INTO` ne peut pas s'exécuter dans une transaction et exige un fichier cible inexistant → fichier temporaire `.tmp` + renommage atomique.
- Une base WAL remplacée avec un `-wal` résiduel serait corrompue → checkpoint + suppression des sidecars avant le swap.
- Apostrophes françaises dans une migration SQL : `d\'un` est invalide en SQLite (il faut `d''un`) → migration 0012 corrigée et couverte par les tests de démarrage.
- `fetch()` conserve des sockets keep-alive : `server.close()` seul rendait la suite HTTP LOT 9 intermittente (timeout 5 s) → `server.closeAllConnections()` ajouté avant la fermeture.
- Un test simulait à tort le dépôt LOT 9 sur un schéma 0010 : en production, `initLocalSqlite()` applique toujours les migrations **avant** l'instanciation des dépôts → scénarios O et « version antérieure » réécrits selon le flux réel de mise à jour.

### Risques résiduels

- Une coupure survenant **entre** la copie de la nouvelle base et la suppression du marqueur peut rejouer une fois la restauration au démarrage suivant (sans perte : la source vérifiée reste présente et une copie supplémentaire est conservée).
- `VACUUM INTO` est synchrone : sur une très grosse base, la requête qui déclenche la sauvegarde bloque brièvement le serveur local.
- Le recalcul SHA-256 de l'historique est borné aux 20 sauvegardes les plus récentes ; les contrôles complets restent systématiques avant téléchargement/restauration.
- Aucun chiffrement des fichiers `.db` exportés : la clé USB doit être physiquement protégée.
- Le manifeste JSON n'est pas signé cryptographiquement : il détecte une altération accidentelle ou une falsification grossière, pas une attaque avec réécriture coordonnée du `.db` et du manifeste.
- Un manifeste absent reste toléré pour compatibilité avec les anciennes sauvegardes ; seuls `MISMATCH` / `UNREADABLE` bloquent.

### Critère de validation du LOT 9

> « Les données survivent aux redémarrages, mises à jour et restaurations. »

**Satisfait et prouvé** : 3 redémarrages hors ligne sans réapplication de migration, mise à jour
0010 → 0012 sans perte (marqueur `system_meta` et produits conservés), restauration réelle
sur base séparée puis activation au redémarrage, portabilité entre deux dépôts, intégrité
`ok` et `foreign_key_check = 0` après chaque scénario. **28/28 tests verts.**

| Élément | État |
| --- | --- |
| Sauvegardes / restauration / intégrité / historique / portabilité | **Terminé et vérifié** |
| Données survivant aux redémarrages, mises à jour, restaurations | **Terminé et vérifié** |
| Non-régression des lots 0 → 8 | **Terminé et vérifié** (28/28) |
| Procédures sauvegarde / restauration / mise à jour documentées | **Terminé et vérifié** (§4 → §6) |
| Sélecteur de dossier natif pour clé USB (Tauri `dialog.save`) | Non commencé — dépend du LOT 10 |
| Parité des commandes Rust/Tauri pour LOT 2 → LOT 9 | Non commencé — LOT 10 |
| Harmonisation `schema_migrations` / `_sqlx_migrations` | Non commencé — LOT 10 |
| Chiffrement des sauvegardes, signature du manifeste, rotation multi-supports | Non commencé (améliorations hors critère) |
| Builds signés Windows/macOS, tests de livraison (scénario R) | **Bloqué** par le LOT 10, volontairement non entamé |

---

## 4. Procédure de sauvegarde

1. Se connecter avec le compte **Propriétaire** (seul rôle disposant de `backup.manage`).
2. Ouvrir **Sauvegardes & Restauration**.
3. Cliquer sur **Créer une sauvegarde**. Le backend :
   - exécute `VACUUM INTO` vers `data/backups/depotpro-manual-<date>-<uuid>.db.tmp` ;
   - contrôle `integrity_check`, `foreign_key_check` et la présence du schéma ;
   - calcule le SHA-256, renomme le fichier, inscrit la ligne dans `backup_history` et journalise dans `audit_logs`.
4. Vérifier la ligne « Vérifiée » dans l'historique (bouton **Vérifier** pour recontrôler à tout moment).
5. Pour une copie externe : **Exporter pour clé USB** télécharge le `.db` vérifié ; le copier ensuite sur le support amovible, puis le conserver hors de l'ordinateur.
6. La sauvegarde automatique est active par défaut (24 h, 7 copies conservées) et se déclenche aussi au démarrage si l'intervalle est écoulé. Paramètres modifiables dans l'interface.

> En ligne de commande : `sqlite3 data/depotpro.db "VACUUM INTO '/chemin/secours.db';"` donne le même résultat, mais n'inscrit rien dans l'historique applicatif.

### 4.1 Importer une sauvegarde externe (clé USB, autre poste, réinstallation)

1. Cliquer sur **Importer un .db** et sélectionner le fichier `.db` (256 Mo maximum).
2. Le navigateur calcule son SHA-256 (`crypto.subtle`) et l'envoie avec le fichier en `application/octet-stream`.
3. Le backend refuse : un fichier sans en-tête `SQLite format 3`, une base corrompue, une empreinte de transfert différente, et tout nom de fichier piégé (le chemin de destination est **toujours** `data/backups/depotpro-import-<date>-<uuid>.db`).
4. Si tout est conforme : `integrity_check` + `foreign_key_check`, écriture du manifeste, ligne `origin = 'IMPORTED'` dans `backup_history`, journal `BACKUP_IMPORTED` dans `audit_logs`.
5. La sauvegarde apparaît dans l'historique avec le badge **Importée** et peut être vérifiée, téléchargée ou restaurée comme une sauvegarde locale.

Le manifeste peut être relu à tout moment via `GET /api/system/backups/:id/manifest` ou directement dans `data/backups/*.db.manifest.json` sans ouvrir l'application.

## 5. Procédure de restauration

1. **Sauvegarder l'état actuel** (le système le fait aussi automatiquement en `PRE_RESTORE`). Si la sauvegarde vient d'une clé USB ou d'un autre poste, l'importer d'abord (§4.1).
2. Dans l'historique, cliquer sur **Restaurer** pour une ligne « Vérifiée ».
3. Saisir exactement `RESTAURER`. Le backend refuse toute autre valeur.
4. Le backend : revérifie la copie, crée la sauvegarde `PRE_RESTORE`, copie la sauvegarde dans `data/restore/`, **applique les migrations manquantes sur cette copie**, contrôle son intégrité, compare les volumes de données, puis dépose `data/restore-pending.json`.
5. **La base active n'est pas modifiée.** Un bandeau orange l'indique ; **Annuler la restauration** reste possible.
6. Fermer complètement l'application, puis la relancer **hors connexion**. Au démarrage, avant toute ouverture SQLite :
   - SHA-256 et intégrité de la copie revérifiés ;
   - `wal_checkpoint(TRUNCATE)` + suppression des sidecars ;
   - la base courante est renommée `depotpro.pre-restore-<date>.db` ;
   - la copie vérifiée devient `data/depotpro.db` ;
   - le marqueur est supprimé et `backup.last_restore_at` est mis à jour.
7. Contrôler les données (produits, ventes, caisses) puis lancer **Diagnostic complet** et **Tests LOT 9**.

En cas d'échec (marqueur illisible, empreinte modifiée, copie absente) : **le démarrage échoue explicitement et la base courante est conservée**. Corriger ou supprimer `data/restore-pending.json` manuellement, puis redémarrer.

## 6. Procédure de mise à jour sans perte

1. Effectuer une sauvegarde manuelle (§4).
2. Arrêter l'application.
3. Remplacer le code / l'exécutable, **sans supprimer `data/`**.
4. Redémarrer : `initLocalSqlite()` compare `schema_migrations`, applique uniquement les nouvelles migrations dans une transaction `BEGIN IMMEDIATE … COMMIT`, et refuse tout fichier de migration déjà appliqué dont le SHA-256 aurait changé. Les migrations sont **toujours appliquées avant** l'instanciation des dépôts : le code applicatif voit donc toujours le schéma à jour.
5. Vérifier `app.lot_current`, `PRAGMA integrity_check` et le diagnostic LOT 9.
6. Scénarios automatisés : base 0010 → 0011/0012 (`migrationsAppliedNow = 2`), données et marqueur `system_meta` conservés, puis 3 redémarrages avec `migrationsAppliedNow = 0` ; une sauvegarde 0010 importée est restaurée sur une copie où les 2 migrations manquantes sont appliquées avant activation.

---

## 7. Limites connues

- Runtime courant = pont Node/Express ; le build Tauri n'est pas fonctionnel de bout en bout (LOT 10).
- Pas de sélecteur de dossier natif : l'export USB passe par le téléchargement navigateur et l'import par un sélecteur de fichier web (fonctionnel hors ligne).
- Pas de chiffrement ni de signature numérique des sauvegardes ; le manifeste détecte les altérations mais n'est pas signé.
- Pas de sauvegarde sur un emplacement réseau (choix délibéré : 100 % hors ligne).
- Pas de restauration « à chaud » (choix délibéré de sécurité).
- Import limité à 256 Mo et chargé en mémoire : au-delà, utiliser une copie disque directe.
- Le bundle front (`dist/assets/*.js`, ~1,27 Mo) n'est pas encore découpé en chunks : optimisation possible, sans impact métier.
