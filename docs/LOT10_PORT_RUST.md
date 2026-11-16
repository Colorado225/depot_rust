# LOT 10 — Rapport d’avancement : tranches 1-4, registre 95/95, pont HTTP retiré

> **Règle de preuve** (`Implementtion.md` §15) : « Aucun scénario critique ne
> doit être déclaré réussi sans preuve issue d’un test ». Ce rapport distingue
> strictement **Terminé et vérifié**, **Implémenté mais non vérifié**,
> **En cours**, **Non commencé** et **Bloqué**. Le **LOT 10 reste ouvert** :
> `95/95` est un état du registre de commandes, pas une parité fonctionnelle
> prouvée en coquille Tauri native.

---

## 1. Objectif

L’utilisateur a corrigé la trajectoire du LOT 10 : **engager le port Rust complet
avant d’aller plus loin sur la distribution**. La phase 1 « backend Node en
sidecar + 95 commandes par HTTP loopback » a été vérifiée puis **rejetée** comme
architecture finale ; `docs/LOT10_DISTRIBUTION.md` est **SUPERSÉDÉ**.

Objectif de cette étape (tranche 4) : porter les 9 dernières commandes
`sauvegarde/restauration`, porter les exports CSV/PDF, retirer toute béquille
Node du desktop et ne conserver Node/Express que comme **référence web /
preview**. Distribution §10 gelée jusqu’à `cargo check` / `cargo test` et aux
builds natifs.

Architecture retenue (`Implementtion.md` §3, ADR `0014` puis `0015`) :

```
React / TS / Vite / Tailwind / shadcn
        ↓ tauriInvoke(command, { input })
Tauri 2 Commands  (95 registre + 5 services)
        ↓
Domain Services Rust  (backup, pdf_export, cump, money…)
        ↓
Repositories SQLx  (dépôts compilés)
        ↓
SQLite locale  (schema_migrations + SHA-256, WAL, FK)
```

- Aucun sidecar, aucun `externalBin`, aucun bundle `server.mjs`, aucun port
  `127.0.0.1:3000`, aucun `get_backend_origin` dans la coquille.
- `COMMAND_HTTP_MAP` ne subsiste dans `src/lib/ipc.ts` que pour les URL
  relatives du navigateur. En Tauri, une commande hors `RUST_COMMAND_SET`
  échoue par `NOT_IMPLEMENTED_IN_RUST`, quel que soit le mode de recette.
- Le mode parité est **`strict` par défaut** ; `setRustParityMode` ne peut plus
  réactiver de repli HTTP.

---

## 2. Fichiers créés, modifiés et supprimés

### 2.1 Créés

| Fichier | Rôle |
| --- | --- |
| `src-tauri/src/domain/backup.rs` | SHA-256, base64, manifestes, marqueur de restauration, inspection SQLite en lecture seule |
| `src-tauri/src/domain/pdf_export.rs` | Générateur PDF 1.4 autonome (port de `server/domain/pdfExport.ts`) |
| `src-tauri/src/repositories/backup_repo.rs` | 9 commandes LOT 9 + diagnostics/self-tests + timer AUTO + import USB |
| `src-tauri/src/repositories/report_export_repo.rs` | 6 jeux CSV/PDF, BOM, audit `REPORT_EXPORTED` |
| `src-tauri/src/commands/backups.rs` | 9 handlers du registre + 4 services binaires, RBAC |
| `src-tauri/src/runtime.rs` | Diagnostic `TAURI_IPC_ONLY`, `sidecar: false`, 95/95 |
| `migrations/0015_lot10_rust_ipc_only.sql` | ADR finales (8 clés `system_meta`), `app.lot_in_progress` |
| `tests/lot10-rust-tranche4.test.ts` | 7 tests de la tranche 4 |
| `docs/LOT10_PORT_RUST.md` | Ce rapport |

### 2.2 Modifiés

| Fichier | Changement |
| --- | --- |
| `src-tauri/src/lib.rs` | 100 handlers, `pub mod runtime`, pool Rust, migrations embarquées, minuterie Tokio AUTO |
| `src-tauri/src/commands/mod.rs` | Déclare `backups` ; documente l’exclusion des 4 squelettes legacy |
| `src-tauri/src/domain/mod.rs`, `repositories/mod.rs` | Déclarent `backup`, `pdf_export`, `backup_repo`, `report_export_repo` |
| `src-tauri/tauri.conf.json` | `externalBin` retiré, seule ressource `../migrations/`, CSP sans loopback |
| `src-tauri/parity/commands.json`, `src/lib/rustCommands.generated.ts` | **95/95**, `complete: true`, aucun `A_PORTER`, `fallback: null` |
| `scripts/gen-rust-ledger.mjs` | `TRANCHE_4` → `commands::backups`, `fallback: null` |
| `scripts/check_rust.py` | Module `backups`, `SERVICE_COMMANDS`, contrôles no-sidecar / CSP / IPC / runtime / PDF / doublons / interdictions `argon2` et `rusqlite` |
| `scripts/verify-delivery.mjs` | Contrôle 15 migrations (`node:sqlite`), config Tauri, no-sidecar, 95/95, scripts de signature |
| `src/lib/ipc.ts` | `getBackendOrigin() = ''`, `invokeRustService`, helpers base64/blob/SHA-256, IPC strict |
| `package.json`, `.env.example`, `.gitignore` | Scripts `backend:*` retirés ; Node = preview web uniquement |
| `server.ts`, `server/db/sqlite.ts`, `server/security/desktopCors.ts` | Commentaires : CORS preview web, plus de sidecar desktop |
| `src/types/errors.ts` | `NOT_IMPLEMENTED_IN_RUST` conservé comme garde-fou |
| `src/modules/foundations/components/LotRoadmapVerificationView.tsx` | Roadmap LOT 10 → 95/95 |
| `docs/LOT9_FIABILISATION.md`, `docs/LOT10_DISTRIBUTION.md` | Notes de non-régression 15 migrations ; sections obsolètes signalées |
| `tests/lot10-*.test.ts` | Compteurs 86 → 95, 198 → 241 requêtes, retrait du pont HTTP |

### 2.3 Supprimés

| Fichier | Raison |
| --- | --- |
| `src-tauri/src/bridge.rs` | Démarrage/attente du sidecar Node |
| `scripts/build-backend.mjs` | Bundle Node embarqué |
| `src-tauri/binaries/`, `build-backend/` | Artefacts sidecar générés |

Les 4 squelettes historiques `commands/{auth,finance,purchases,system}.rs`
restent dans le dépôt **à titre de référence uniquement** : ils ne sont pas
déclarés dans `commands/mod.rs` (contrôlé par `check_rust.py`), donc jamais
compilés ni enregistrés.

---

## 3. Fonctionnalités réalisées et règles métier

### 3.1 Registre de parité : 95/95

| Tranche | Commandes | Module Rust | État |
| --- | ---: | --- | --- |
| 1 — Fondations, auth/RBAC, paramètres, restauration différée | 23 | `commands/foundation.rs` | `RUST` |
| 2 — Catalogue, stocks, fournisseurs, achats | 30 | `commands/operations.rs` | `RUST` |
| 3 — Clients, POS, consignes, caisse, rapports | 33 | `commands/commercial.rs` | `RUST` |
| 4 — Sauvegardes LOT 9, diagnostics, restauration | 9 | `commands/backups.rs` | `RUST` |
| **Total registre** | **95** | `src-tauri/parity/commands.json` | **`complete: true`** |

Cinq commandes de service hors registre remplacent d’anciens `fetch` de
fichiers : `backup_get_manifest`, `backup_download_file`,
`backup_import_file`, `reports_export_file`, `get_desktop_runtime_status`.
`lib.rs` enregistre donc **100 handlers** ; `check_rust.py` les reconnaît
explicitement et refuse tout handler non déclaré, tout doublon et tout repli.

### 3.2 Sauvegardes et portabilité LOT 9

- `VACUUM INTO ?` sur une copie compactée, jamais sur la base active ;
- SHA-256 par blocs, manifeste `depotpro-backup-manifest` v1 en `0o600` ;
- `inspect_manifest` : `OK` / `ABSENT` / `MISMATCH` / `UNREADABLE`, seuls
  `MISMATCH` et `UNREADABLE` bloquent ;
- `inspect_sqlite_file` via SQLx en **lecture seule** : magic header,
  `integrity_check`, `foreign_key_check`, tables, `schema_migrations` ;
- configuration bornée (`1..720` h, `1..365` rétention), historique
  `backup_history`, audit `BACKUP_*`, purge AUTO bornée ;
- import USB : 256 Mo, magic SQLite, empreinte WebCrypto revérifiée en Rust,
  fichier temporaire privé, `USB_EXPORT` / `IMPORTED`, nettoyage sur échec ;
- vérification/téléchargement : recalcul SHA-256, contrôles SQLite, refus si
  corruption, renvoi base64 ;
- restauration : confirmation `RESTAURER`, **copie `PRE_RESTORE` obligatoire**,
  copie staged, migrations appliquées sur cette copie, snapshots des 17 tables
  témoins, `wal_checkpoint(TRUNCATE)`, `journal_mode=DELETE`, marqueur
  `restore-pending.json`, audit `BACKUP_RESTORE_PREPARED` ;
- activation différée par `db/restore.rs` **avant** l’ouverture du pool :
  SHA-256 staged, intégrité, FK, schéma, copie `depotpro.pre-restore-*.db`,
  rollback fichier, `BACKUP_RESTORE_APPLIED` ; annulation tracée.

### 3.3 Diagnostics, self-tests et minuterie

Les **10 contrôles** de `reliabilityRepo.ts` sont reproduits (`wal-fk`,
`integrity-check`, `foreign-key-check`, `schema-tables`,
`migration-checksums`, `currency-xof`, `xof-integers`, `no-negative-stock`,
`backup-rbac`, `backup-history`), plus `tx-rollback` et `offline-ready`.
Le timer n’est plus Node : `lib.rs` lance une tâche Rust (5 s puis 15 min)
vers `backup_repo::auto_backup_if_due`.

### 3.4 Exports de rapports

Six jeux (`margins`, `sales`, `receivables`, `payables`, `expenses`,
`consignments`), BOM UTF-8, séparateur `;`, `formatXofText`, audit
`REPORT_EXPORTED`, nom horodaté. Le PDF 1.4 Rust (A4 paysage, WinAnsi,
`xref`/`startxref`) remplace `pdfExport.ts` sans dépendance externe.

### 3.5 Transport binaire Tauri

`invokeRustService`, `base64ToBytes`, `bytesToBase64`, `bytesToBlob`,
`saveBlob`, `sha256Hex` : en Tauri, exports, téléchargements et imports USB
passent par IPC `{ filename, mimeType, contentBase64 }`, sans HTTP. La limite
256 Mo et le SHA-256 de transfert sont revérifiés côté Rust.

---

## 4. Tests exécutés et résultats

| Preuve | Résultat |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | **OK** |
| `npm test` | **16 fichiers / 67 tests / 67 réussis** (28 historiques dont 7 LOT 9 + 39 LOT 10) |
| `npm run build` | **OK** — 2 330 modules, 1 277,60 kB JS / 37,34 kB CSS, avertissement de chunk non bloquant |
| `npm run rust:check` | **OK** — `95/95` ; tree-sitter complet sur **46 fichiers `.rs` (42 compilés)** ; **99 handlers + 100 enregistrées** ; **314 requêtes** avec `#? == #.bind()`, 0 décalage |
| `tests/lot10-rust-sql.test.ts` | **241 requêtes SQL littérales** préparées sans erreur contre les **15 migrations** ; `integrity ok`, FK 0, **43 tables**, `LOT_9` |
| `npm run delivery:check` | **6/6** — frontend hors ligne, 15 migrations / 43 tables / `TAURI_IPC_ONLY_95_OF_95`, coquille/icônes/CSP, aucun sidecar, 95/95 IPC strict, scripts de signature présents |
| Preview web live | `http://0.0.0.0:3000` : `/api/system/health` = 15 migrations / 43 tables / `LOT_9` / `offlineReady` ; login `patron` ; 8 ADR `adr.desktop_*` conformes à `0015` ; preview proxifié `*.e2b.app` = 200 |
| Non-régression LOT 9 | 7/7 tests LOT 9 ; compteurs dérivés du dossier `migrations/`, donc `0013`/`0014`/`0015` ne cassent aucun test |

`check_rust.py` valide en outre l’absence de `bridge.rs`, `sqlx::migrate!`,
`_sqlx_migrations`, `rusqlite`, `argon2`, `externalBin`, `backend:build`,
`127.0.0.1` dans la CSP, `get_backend_origin` côté client et de tout
squelette legacy déclaré ; il vérifie `VACUUM INTO`, `RESTORE_CONFIRMATION`,
`PRE_RESTORE`, `apply_migrations`, `backup_history` et le générateur PDF.

---

## 5. Problèmes rencontrés

1. **Décision inversée** : la phase 1 (sidecar Node, CORS, 95 commandes HTTP)
   fonctionnait mais violait la RÈGLE ABSOLUE du §3 → rejetée, `0014`/`0015`
   font foi, `docs/LOT10_DISTRIBUTION.md` marqué SUPERSÉDÉ.
2. **`rusqlite` dans une première ébauche** de `domain/backup.rs` → réécrite
   entièrement avec SQLx + `sha2` + base64 maison, sans dépendance nouvelle.
3. **Générateur PDF** : une closure `add_object` empruntant `objects` a été
   remplacée par `push_object(&mut objects, …)` ; `unwrap_or(&Vec::new())`
   remplacé par une sentinelle `let empty: Vec<Value>`.
4. **Types préventifs** : `div_ceil` → `((len + 2) / 3)`, `text_field` →
   `row.get().and_then(Value::as_str)`, `fs::metadata` → `map_err(AppError::…)`,
   sentinelle `"null"` → `Option<String>`, `rows.len()` avant déplacement,
   `restore_reason`, `write_private_bytes`. Ces points restent non prouvés par
   `cargo`.
5. **Double `use commands::backups`** dans `lib.rs` → fusionné.
6. **`catch` de `verify-delivery.mjs`** référençait une variable `status` non
   définie → corrigé (`{ name, status: 'ECHEC', detail }`).
7. **Compteurs figés** dans 4 fichiers de tests et la roadmap (`86/95`, `198`
   requêtes, `A_PORTER`, `complete:false`) → alignés sur 95/95, 241 requêtes,
   `complete:true`.
8. **Faux positif `argon2`** du nouveau contrôle : les chaînes de test
   `$argon2id$…` (refus scrypt) et les commentaires sont légitimes → le
   contrôle ne cible plus que la dépendance Cargo et l’usage effectif
   `argon2::` / `use argon2`.
9. **`cargo check` impossible** : `cargo`, `rustc`, `webkit2gtk-4.1`, `rsvg2`
   et `Cargo.lock` absents ; le sandbox n’accède pas à `static.rust-lang.org`.

---

## 6. Risques résiduels

> **`cargo check`, `cargo test`, `tauri build`, webview native, installateurs,
> signature Windows, notarisation macOS et tests d’installation restent
> NON EXÉCUTÉS dans ce sandbox.**

- Tree-sitter prouve la **syntaxe** ; `DatabaseSync.prepare()` prouve le **SQL**
  et les marqueurs. Ni l’un ni l’autre ne prouve les types SQLx, les coercions
  `Transaction`/`Executor`, la désérialisation Tauri de `input: Value`, ni
  l’enregistrement réel de 100 handlers par `generate_handler!`.
- Aucune commande Tauri n’a été invoquée depuis une webview native ; les tests
  Rust `#[cfg(test)]` (CUMP, scrypt, base64, PDF, backup, runtime) n’ont pas
  été lancés par `cargo test`.
- La parité des 95 commandes est **statique et contractuelle**, pas une parité
  fonctionnelle démontrée sur Windows/macOS.
- Le CORS desktop historique (`server/security/desktopCors.ts`, monté dans
  `server.ts`) subsiste pour le preview web / recette ; il n’est **pas**
  embarqué dans la coquille Tauri.
- Manifestes de sauvegarde non signés cryptographiquement (SHA-256 +
  cohérence du manifeste seulement) ; `node:sqlite` expérimental pour la
  référence web ; icônes provisoires.

---

## 7. Critères restant à satisfaire

| Exigence | État |
| --- | --- |
| Port Rust 95/95 + retrait du pont HTTP | **Implémenté, vérifié statiquement** |
| `cargo check` / `cargo test` sur poste outillé | **À exécuter** |
| Build Tauri natif Windows/macOS | **À exécuter** |
| Webview native : login, diagnostics, sauvegarde, import, restauration, exports | **À éprouver** |
| §10 : MSI/EXE, DMG/APP, métadonnées, assistant de première installation | **Partiellement préparé, non validé** |
| Signature Windows, Developer ID macOS + notarisation | **Scripts présents, NON EXÉCUTÉS** |
| Désinstallation sécurisée sans suppression des données commerciales | **À tester sur installateur réel** |
| **« Installateurs utilisables et validés »** | **NON SATISFAIT** |

### Prochaine étape (sur poste outillé)

```bash
rustup toolchain install stable
cd src-tauri && cargo check && cargo test
npm run lint && npm test && npm run rust:check && npm run delivery:check
npm run tauri:build    # Windows et macOS, puis signature / notarisation
```

`app.lot_current` reste **`LOT_9`**, `app.lot_in_progress` reste **`LOT_10`**.
Tant que ces preuves natives manquent, **le LOT 10 reste ouvert** et le
critère de distribution §10 ne peut pas être déclaré terminé.

---

## 8. Synthèse des statuts (§15)

- **Terminé et vérifié** : inversion de décision, registre 95/95, dispatch IPC
  strict, retrait du sidecar/HTTP loopback, 15 migrations, non-régression
  LOT 9, suite 16/67, contrôle statique Rust et SQL, `delivery:check` 6/6,
  preview web live.
- **Implémenté mais non vérifié** : 100 handlers Tauri, dépôts SQLx, runner de
  migrations, restauration différée, générateur PDF, base64/SHA-256,
  sauvegardes USB et diagnostics en Rust.
- **En cours** : aucune tranche de port en attente ; la validation native est
  l’étape active.
- **Non commencé** : builds natifs signés, signature, notarisation,
  installation et désinstallation sécurisée.
- **Bloqué** : toute compilation/exécution Rust native dans ce sandbox.
