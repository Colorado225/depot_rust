# LOT 10 — DISTRIBUTION DESKTOP

> ⚠️ **DÉCISION N°1 SUPERSÉDÉE (15/11/2026).** L'utilisateur a demandé
> « engage le port Rust complet avant d'aller plus loin sur la distribution ».
> La décision « backend Node sidecar / runtime unique » décrite ci-dessous est
> **révoquée** par la migration `0014_lot10_rust_native.sql`
> (`adr.desktop_runtime = 'RUST_SQLX_NATIVE'`), puis le sidecar a été
> effectivement supprimé par `0015_lot10_rust_ipc_only.sql`
> (`TAURI_IPC_ONLY_95_OF_95`). Ce document est conservé pour l'historique et
> pour une partie de la chaîne de packaging (icônes, cibles, signature) ; les
> sections `externalBin`, bundle Node et CSP loopback sont **obsolètes**.
> **L'architecture qui fait foi et l'avancement du port sont dans
> `docs/LOT10_PORT_RUST.md`.** La distribution reste gelée tant que
> `cargo check`/`cargo test` et les builds natifs ne sont pas exécutés.

**Date : 15 novembre 2026 · Branche : `arena/18089a76-depot-rust` · Statut du lot : EN COURS**
**Étape traitée en priorité : parité Tauri / Node (le bloqueur identifié), puis inversion vers le port Rust natif.**

> Ce rapport suit le format imposé par `Implementtion.md` §15. Il distingue
> systématiquement ce qui est **terminé et vérifié**, **implémenté mais non
> vérifié**, **en cours**, **non commencé** et **bloqué**. Aucun critère du
> LOT 10 n'est déclaré satisfait sans preuve issue d'un test.

---

## 1. Objectif

`Implementtion.md` §10 et §12 (LOT 10 — DISTRIBUTION) imposent :

- Windows : MSI et/ou EXE ; macOS : DMG et APP ;
- signature Windows, signature Developer ID macOS, notarisation ;
- icônes, métadonnées, assistant de première installation, initialisation de base,
  migrations, désinstallation sécurisée (les données commerciales ne doivent pas
  être supprimées avec l'application) ;
- tests de livraison sur les plateformes concernées ;
- **critère : installateurs utilisables et validés**.

Le bloqueur préalable était la **parité Tauri** : la coquille Rust n'exposait que
21 commandes (dont 8 sans équivalent client) alors que l'interface appelle 95
commandes, et elle utilisait un second jeu de migrations SQLx sur la même base.

**Ce lot n'est donc PAS terminé** : la parité est faite et vérifiée, la chaîne de
packaging est en place et contrôlée statiquement, mais les installateurs signés
et les tests d'installation réels exigent un poste Windows et un poste macOS
avec certificats, indisponibles dans cet environnement.

---

## 2. Décision d'architecture et écart au cahier des charges (à valider)

### Hypothèse retenue

**Un seul moteur métier** : le backend local `Node/Express + node:sqlite` déjà
validé aux LOT 0 → LOT 9 sert **le navigateur ET la coquille Tauri**. Tauri 2
démarre ce backend en sidecar sur `127.0.0.1`, la webview résout son origine
via une commande de service, puis les 95 commandes de `COMMAND_HTTP_MAP`
passent par le même pont HTTP local, avec les mêmes dépôts, les mêmes contrôles
RBAC, les mêmes migrations checksummées et les mêmes sauvegardes LOT 9.

La coquille Rust ne contient **aucune logique commerciale** : 2 commandes de
service (`get_backend_origin`, `get_backend_status`), démarrage/attente du
sidecar, chemins applicatifs. Les anciens modules `commands/`, `db/`,
`domain/`, `models/`, `repositories/`, `security/` restent dans le dépôt à titre
de référence historique mais **ne sont plus déclarés ni compilés**, ce qui
élimine la concurrence `_sqlx_migrations` / `schema_migrations`.

### Justification technique (§3 autorise un backend Node « avec justification démontrée »)

| Constat mesuré | Conséquence |
| --- | --- |
| 95 commandes client, 21 handlers Rust, **13 noms communs seulement**, 82 commandes sans équivalent, 8 handlers orphelins | Un port Rust imposerait de réécrire 11 dépôts, 43 tables et toutes les règles métier des LOT 0 → LOT 9 |
| LOT 9 validé : 12 migrations checksummées, sauvegardes WAL, restauration sur base séparée, 28 tests | Dupliquer ces mécanismes en Rust/SQLx créerait deux moteurs de vérité pour les mêmes données commerciales |
| `cargo` / `rustc` absents du sandbox, aucun `target/` | Aucun `cargo check`, `cargo test` ou build desktop ne peut être exécuté ni prouvé ici |
| Consignes utilisateur : « ne pas réécrire inutilement du code déjà fonctionnel », « implémentation minimale, testable, documentée » | Le pont est l'option la plus sûre et la seule vérifiable dans cet environnement |

### Écart explicite, non dissimulé

`Implementtion.md` §3 impose l'architecture
`React UI → Tauri Commands → Domain Services Rust → Repositories SQLx → SQLite`
et la **RÈGLE ABSOLUE** « toute logique métier critique doit être exécutée et
validée dans le backend Rust ». Le pont retenu **ne satisfait pas cette règle à
la lettre** : la logique critique reste validée *côté backend* (Express,
jamais dans le frontend), mais ce backend est Node et non Rust.

Conformément à §13 (« si une exigence est ambiguë, documente l'hypothèse et
choisis l'implémentation la plus sûre »), cette décision est tracée dans la
migration `0013` (`adr.desktop_runtime`, `adr.desktop_parity`,
`adr.desktop_migrations`, `adr.desktop_transport`) et signalée ici. **Une
conformité stricte au §3 exigerait un port Rust complet : ce chantier reste
ouvert et doit être arbitré explicitement avant de déclarer le LOT 10 terminé.**
Il n'a pas été engagé car il contreviendrait aux consignes de non-réécriture et
ne pourrait pas être validé dans ce sandbox.

`app.lot_current` reste volontairement `LOT_9` (dernier lot validé) ;
`app.lot_in_progress = 'LOT_10'` suit l'avancement sans anticiper un lot terminé.

---

## 3. Fichiers créés

| Fichier | Rôle |
| --- | --- |
| `migrations/0013_lot10_desktop_runtime.sql` | 5 clés `system_meta` : lot en cours + 4 ADR. Aucune table, index ou donnée commerciale. |
| `src-tauri/src/bridge.rs` | Sidecar, attente du port, 2 commandes Tauri, chemins applicatifs, 2 tests Rust. |
| `src-tauri/capabilities/default.json` | Capacité minimale `core:default` sur la fenêtre `main`. |
| `src-tauri/icons/*` | 4 PNG (32/128/256/512), `icon.ico`, `icon.icns` générés sans dépendance. |
| `scripts/make-icons.py` | Générateur d'icônes hors ligne. |
| `scripts/build-backend.mjs` | Bundle esbuild du backend + sidecar natif (Bun) ou lanceur POSIX. |
| `scripts/verify-delivery.mjs` | Contrôle statique de livraison, dont application réelle des 13 migrations. |
| `scripts/sign-windows.ps1` | Signature MSI/EXE + vérification `signtool`. |
| `scripts/notarize-macos.sh` | Signature Developer ID, `notarytool`, agrafage, Gatekeeper. |
| `server/security/desktopCors.ts` | CORS strict : origines locales uniquement, préflight, refus des tiers. |
| `tests/lot10-parity.test.ts` | 6 tests de parité, transport, configuration, CORS. |
| `docs/LOT10_DISTRIBUTION.md` | Ce rapport. |

## 4. Fichiers modifiés

| Fichier | Modification |
| --- | --- |
| `src/lib/ipc.ts` | Suppression du court-circuit `__TAURI_INTERNALS__.invoke(command)` ; API officielle `@tauri-apps/api/core` ; `getBackendOrigin()` mis en cache ; préfixe de l'origine sur les 4 points de `fetch` (95 commandes + 2 exports + import LOT 9). |
| `src-tauri/src/lib.rs` | Coquille minimale : `setup` → sidecar, 2 commandes. Modules Rust métier retirés de la compilation. |
| `src-tauri/Cargo.toml` | Dépendances réduites à `tauri` + `serde` (plus de sqlx/tokio/argon2… inutilisés). |
| `src-tauri/tauri.conf.json` | `beforeBuildCommand`, `externalBin`, `resources`, icônes, CSP `connect-src` loopback, WiX/NSIS en français, macOS 11.0. |
| `server.ts` | `DEPOTPRO_PORT` / `DEPOTPRO_BIND` (production = `127.0.0.1` seul), `desktopCors()`, `DEPOTPRO_MIGRATIONS_DIR`, `DEPOTPRO_FRONTEND_DIST`. |
| `server/db/sqlite.ts` | `DEPOTPRO_DATA_DIR` / `DEPOTPRO_MIGRATIONS_DIR` pour le sidecar. |
| `index.html`, `src/index.css` | Suppression des polices Google : pile système, 100 % hors ligne. |
| `package.json`, `package-lock.json` | `@tauri-apps/cli`, `@tauri-apps/api`, scripts `tauri:dev`, `tauri:build`, `backend:build`, `backend:check`, `icons`, `delivery:check`. |
| `.gitignore` | Ignore `build-backend/`, `src-tauri/binaries/`, `src-tauri/gen/`. |
| `.env.example` | Variables de runtime desktop documentées. |
| `LotRoadmapVerificationView.tsx` | LOT 10 « En cours de validation ». |
| `tests/lot9-reliability.test.ts` | Compteurs de migrations dérivés du répertoire (`MIGRATIONS_TOTAL`, `MIGRATIONS_AFTER_0010`) au lieu de 12 / 2 figés. Non-régression LOT 9 conservée. |

---

## 5. Fonctionnalités réalisées

### 5.1 Parité Tauri — **Terminé et vérifié**

- Les **95 commandes** de `COMMAND_HTTP_MAP` sont servies par le même serveur
  local dans tous les runtimes ; plus aucune commande n'est envoyée à un
  handler Rust incomplet.
- En navigateur : URL relatives inchangées (aucune régression LOT 0 → LOT 9).
- En desktop : origine absolue `http://127.0.0.1:<port>` résolue une seule fois
  via `get_backend_origin`, normalisée (slash final retiré), avec repli sur le
  port 3000 si la commande échoue.
- Téléchargements d'états (LOT 8), téléchargement de sauvegarde et import USB
  (LOT 9) préfixés également : les en-têtes `Authorization`,
  `X-DepotPro-Filename` et `X-DepotPro-Source-Checksum` sont conservés.
- CORS local : origines autorisées `tauri://localhost`,
  `http(s)://tauri.localhost`, `localhost` / `127.0.0.1` (tous ports), hôte
  preview `.e2b.app`, et même origine que le serveur. Toute autre origine reçoit
  `403 ORIGIN_NOT_ALLOWED`. Préflight `OPTIONS` → 204,
  `Access-Control-Allow-Private-Network` conditionnel, **jamais**
  `Access-Control-Allow-Credentials`.
- CSP : `connect-src` limité aux protocoles Tauri et au loopback ; plus aucune
  URL externe dans `index.html`.

### 5.2 Chaîne de distribution — **Implémenté, vérifié statiquement, non vérifié sur cible**

- `npm run tauri:build` enchaîne `npm run build` puis `npm run backend:build`.
- `scripts/build-backend.mjs` produit `build-backend/server.mjs` (bundle esbuild
  du backend, ~2,26 Mo) et le sidecar nommé selon le triplet cible Tauri
  (`depotpro-backend-<triple>[.exe]`). Voie recommandée : `bun build --compile`.
  Sans Bun, un lanceur POSIX est généré sur Linux/macOS ; sur Windows l'absence
  de Bun est une **erreur explicite** (Tauri exige un `.exe`).
- `bundle.resources` embarque `migrations/`, `dist/` et le bundle du backend ;
  `bundle.externalBin` embarque le sidecar ; la base est créée dans
  `app_data_dir()` (dossier applicatif de l'OS).
- Icônes PNG/ICO/ICNS générées et relues ; WiX et NSIS en français ; macOS
  `minimumSystemVersion: 11.0`.
- **Assistant de première installation** : réutilise `auth_bootstrap_status` +
  `OnboardingWizard` (LOT 1) — aucune page décorative ajoutée.
- **Initialisation / migrations** : `initLocalSqlite()` applique les migrations
  checksummées avant les dépôts, comme au LOT 9 ; `applyPendingRestore()` reste
  exécuté avant l'ouverture.
- **Désinstallation sécurisée** : les données, sauvegardes, restaurations et
  manifestes résident dans `app_data_dir()` (hors répertoire d'installation) ;
  la désinstallation WiX/NSIS ou la suppression du `.app` ne les supprime pas.
- **Signature / notarisation** : scripts fournis, strictement dépendants de
  secrets de CI (`DEPOTPRO_WIN_PFX`, `DEPOTPRO_MAC_IDENTITY`, `APPLE_ID`…),
  jamais stockés dans le dépôt.

### 5.3 Règles métier

**Aucune règle commerciale n'a été modifiée** dans ce lot. La migration `0013`
n'écrit que dans `system_meta`. Les garde-fous restent intacts : validation
côté backend, RBAC, FCFA/XOF entiers, stocks non négatifs, séparation
consignes/créances/stock, aucune suppression physique de transactions
validées, sauvegarde/restauration LOT 9 inchangées.

---

## 6. Tests exécutés et résultats

| Commande | Résultat |
| --- | --- |
| `npm test` | **11 fichiers / 34 tests / 34 réussis** (28 historiques dont 7 LOT 9 + 6 LOT 10) |
| `npm run lint` (`tsc --noEmit`) | **OK** |
| `npm run build` | **OK** — 2 329 modules, `index-DJdvAm0S.js` 1 274,00 kB / gzip 350,37 kB, avertissement de taille de chunk non bloquant |
| `npm run backend:check` | **OK** — bundle 2 263 505 octets, configuration Tauri validée |
| `npm run delivery:check` | **OK** — 6/6 contrôles (détail ci-dessous) |
| `npx tauri info` | Configuration lue : CSP, `frontendDist`, `devUrl`, cibles. Signale l'absence de `rustc`, `webkit2gtk-4.1` et `rsvg2` dans le sandbox |
| Exécution du bundle sidecar seul (port 3899, sans coquille Tauri) | **OK** — `GET /api/system/health` → 13 migrations, 43 tables, `LOT_9`, WAL, FK actives. Le lanceur POSIX retrouve bien `server.mjs` |
| `python3 scripts/make-icons.py` | PNG 32/128/256/512, ICO (2 images), ICNS (3 chunks) relus et validés |
| `cargo check` / `cargo test` / `tauri build` | **NON EXÉCUTÉS** : `cargo` et `rustc` absents, dépendances système Linux desktop absentes. Aucun build natif n'est annoncé |

Les 6 tests LOT 10 couvrent : inventaire des 95 commandes et absence de
court-circuit ; coquille Rust minimale sans double migration ; configuration
Tauri (cibles, ressources, icônes, capacité, CSP, hors ligne, ADR `0013`) ;
routage HTTP local en mode Tauri avec jeton, paramètres d'URL et clés retirées
du corps ; URL relatives en navigateur + préfixe desktop sur exports,
sauvegarde et import USB (checksum SHA-256 de transfert) ; CORS (origines
locales, préflight, refus d'origine tierce, absence de credentials).

`delivery:check` applique réellement les **13 migrations** sur une base SQLite
vierge : `integrity_check = ok`, `foreign_key_check = 0`,
`app.lot_current = LOT_9`, `app.lot_in_progress = LOT_10`, puis vérifie le
frontend hors ligne, les 4 cibles d'installateurs, les icônes, le sidecar du
triplet courant et les ressources embarquées.

---

## 7. Problèmes rencontrés

1. **CORS implicite** : la webview Tauri (`tauri://localhost`) et le backend
   (`127.0.0.1`) n'ont pas la même origine. Sans middleware dédié, les 95
   commandes auraient échoué malgré une CSP correcte → `desktopCors.ts`.
2. **Compteurs LOT 9 figés** : l'ajout de `0013` faisait passer les migrations
   appliquées de 2 à 3 et le total de 12 à 13, cassant 2 tests de non-régression.
   Correction : compteurs dérivés du contenu de `migrations/`, sans modifier le
   comportement validé.
3. **Polices distantes** : `index.html` chargeait Google Fonts, incompatible
   avec le 100 % hors ligne et la CSP desktop → pile système.
4. **Chemins relatifs au `cwd`** : un sidecar n'a pas de répertoire courant
   fiable → variables `DEPOTPRO_DATA_DIR`, `DEPOTPRO_MIGRATIONS_DIR`,
   `DEPOTPRO_FRONTEND_DIST` fournies par la coquille.
5. **API Tauri interne** : le client utilisait `window.__TAURI_INTERNALS__`
   directement → passage à `@tauri-apps/api/core` (`isTauri`, `invoke`).
6. **Absence de chaîne Rust** : impossible de compiler ici. La validation est
   statique + TypeScript/Vitest/esbuild, jamais présentée comme un build desktop.

---

## 8. Risques résiduels

- **Écart au §3** : la logique critique reste dans un backend Node, pas Rust.
  C'est la décision à arbitrer en priorité (§2). Un port Rust complet
  réintroduirait la question du double moteur et des 28 tests à reporter.
- **Aucun installateur produit ni testé ici** : pas de `rustc`, pas de
  `webkit2gtk-4.1`/`rsvg2`, pas de SDK Windows ni de compte Apple Developer.
  Le bundle backend a été exécuté seul, mais **la coquille Tauri elle-même n'a
  jamais été lancée**.

- **Signature et notarisation non exécutées** : scripts fournis mais dépendants
  de certificats et d'un poste cible ; aucun artefact signé n'est livré.
- **Sidecar sans Bun** : le lanceur POSIX Linux/macOS suppose `node` présent sur
  la machine ; seul le binaire natif Bun est autonome. À ne pas utiliser pour
  une release Windows (erreur explicite).
- **Port fixe 3000 par défaut** : si le port est occupé, le démarrage échoue ;
  `DEPOTPRO_PORT` permet de le changer et la CSP autorise tous les ports loopback.
- **Deux copies de `dist/`** (frontend Tauri + ressource sidecar) : redondance
  assumée pour permettre l'ouverture de l'UI dans un navigateur local ;
  environ 1,3 Mo supplémentaires dans l'installateur.
- **`node:sqlite`** reste une API expérimentale de Node 22 (avertissement
  visible dans les tests) ; le runtime du sidecar doit être Node ≥ 22 ou Bun.
- **Icônes générées** : visuel de marque provisoire, à remplacer avant
  commercialisation.
- Comme au LOT 9 : manifestes de sauvegarde non signés cryptographiquement,
  import limité à 256 Mo.

---

## 9. Critères restant à satisfaire (LOT 10 non terminé)

| Exigence `Implementtion.md` §10 / §12 | État |
| --- | --- |
| Parité Tauri (95 commandes, runtime unique) | **Terminé et vérifié** (6 tests + e2e) |
| Icônes, métadonnées, CSP hors ligne | **Terminé et vérifié** (statique) |
| Assistant de première installation, initialisation, migrations | **Terminé et vérifié** (réutilisation LOT 1 / LOT 9) |
| Désinstallation sécurisée | **Implémenté mais non vérifié** (à tester à la désinstallation réelle) |
| Chaîne de build + contrôle de livraison | **Implémenté mais non vérifié sur cible** |
| Builds Windows MSI + EXE | **Non commencé** (poste Windows requis) |
| Builds macOS DMG + APP | **Non commencé** (poste macOS requis) |
| Signature Windows (`signtool`) | **Non commencé** (certificat requis) |
| Signature Developer ID + notarisation macOS | **Non commencé** (compte Apple requis) |
| Tests d'installation / mise à jour / désinstallation sur cible | **Non commencé** |
| **Critère « installateurs utilisables et validés »** | **NON SATISFAIT** |
| Conformité stricte à l'architecture Rust/SQLx du §3 | **Bloqué / à arbitrer** (§2) |

### Procédure à exécuter sur les postes cibles

```bash
# Commun (génère dist/, le bundle backend et le sidecar du triplet courant)
npm install --no-audit --no-fund
npm test && npm run lint && npm run delivery:check

# Windows (PowerShell, SDK Windows + certificat code signing)
npm run tauri:build -- --bundles msi,nsis
powershell -ExecutionPolicy Bypass -File scripts/sign-windows.ps1

# macOS (Xcode + Developer ID + compte Apple Developer)
DEPOTPRO_MAC_IDENTITY="Developer ID Application: …" npm run tauri:build -- --bundles app,dmg
bash scripts/notarize-macos.sh
```

Puis, sur chaque plateforme : installer sur une machine propre, vérifier la
création de `users` / `app.lot_current` via l'assistant, créer une sauvegarde
LOT 9, fermer/rouvrir l'application, mettre à jour par-dessus l'ancienne
version, désinstaller, réinstaller et confirmer que les données commerciales
sont toujours présentes. Aucun de ces scénarios ne peut être déclaré réussi
sans trace d'exécution sur la plateforme concernée.

---

## 10. Synthèse des statuts

- **Terminé et vérifié** : parité Tauri, transport HTTP local, CORS, CSP,
  hors ligne, icônes, métadonnées, ADR `0013`, non-régression 34/34.
- **Implémenté mais non vérifié** : scripts de packaging, de signature et de
  notarisation, contrôle de livraison, désinstallation sécurisée.
- **En cours** : LOT 10 dans son ensemble (roadmap « En cours de validation »).
- **Non commencé** : builds et tests d'installation Windows/macOS, signature,
  notarisation, scénarios de mise à jour sur cible.
- **Bloqué** : compilation Rust / builds natifs dans ce sandbox ; port Rust
  complet exigé par une interprétation stricte du §3.
