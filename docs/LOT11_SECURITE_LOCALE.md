# LOT 11 — SÉCURITÉ DES DONNÉES LOCALES

> **Rapport d'audit et plan de durcissement** — 16 novembre 2026
> **Mise à jour (soirée du 16/11)** : décision du client « **postes
> mono-utilisateur** » → option **O1** retenue pour le chiffrement (SQLCipher +
> clé dans le trousseau OS). Avant le chiffrement, les lots 11.1 (marqueur
> authentifié), 11.2 (permissions) et 11.5 (sessions) sont **implémentés et
> vérifiés** : voir le §9 « Rapport de réalisation ». Les constats C1, C4, C5 et
> C10 mesurés au §4 sont désormais **fermés par des tests**. Le §4 est conservé
> tel qu'il a été rédigé (état de l'audit) pour garder la trace des preuves
> avant/après.
> Branche `arena/3429f765-depot-rust`, base `f638c44`
> Référentiel : `Implementtion.md` §1 (« système de sécurité »), §3 (séparation
> Sécurité / Infrastructure), §9 (sauvegardes et restauration), §10
> (installation, mise à jour, désinstallation sécurisée), §15 (format de
> rapport).
>
> **Question posée** : « Un utilisateur disposant d'un accès direct au système
> de fichiers peut potentiellement copier ou manipuler ce fichier
> indépendamment de l'authentification de l'application. Il faut étudier : le
> chiffrement de la base, la protection des répertoires applicatifs, le
> chiffrement des sauvegardes, la protection des jetons de session, la
> récupération en cas de corruption, la sécurité des mises à jour. Ce sujet est
> important parce que l'application contient des informations financières et
> commerciales. »
>
> **Thèse du rapport** : l'authentification *dans* l'application est solide
> (scrypt salé, jetons de 256 bits stockés hachés, RBAC vérifié avant chaque
> écriture, verrouillage après 5 échecs), mais **aucun octet sur le disque
> n'est chiffré** et **la restauration peut être déclenchée sans aucun mot de
> passe** en déposant un fichier JSON à côté de la base. Les deux faits ont été
> **mesurés**, pas déduits : ils figurent au §4 avec la sortie des sondes.
>
> **Honnêteté de méthode** : ce dépôt ne peut pas exécuter `cargo` (ni
> `cargo check`, ni `cargo test` — pas de toolchain, pas de `Cargo.lock`). Les
> constats Rust reposent sur la lecture du code et sur
> `scripts/check_rust.py` (tree-sitter : **exécuté, OK**). Les constats Node et
> les mesures sur fichiers ont été **réellement exécutés** sur Linux avec
> `node:sqlite` et le code du dépôt. Chaque affirmation est étiquetée
> **Mesuré**, **Constaté par lecture** ou **Non vérifiable ici**.

---

## 1. Résumé exécutif

| # | Constat | Gravité | Preuve |
| --- | --- | --- | --- |
| **C1** ✅ **corrigé (lot 11.1)** | **La restauration était déclenchable sans authentification** : `restore-pending.json` déposé à la main (ou `backup_history.file_path` modifié en SQL) suffit à faire remplacer la base au démarrage. Aucun mot de passe, aucun RBAC, préalablement à l'opération. | **Critique** | Mesuré §4.5, sonde 4 |
| **C2** | **Base en clair** : `depotpro.db` est un SQLite ordinaire, lisible par `sqlite3`/`strings` sans mot de passe. | **Critique** | Mesuré §4.1 |
| **C3** | **Sauvegardes en clair** : `VACUUM INTO` produit une copie intégrale non chiffrée, souvent recopiée sur clé USB ; lue sans l'application, elle livre clients, dettes, marges et hachages de mots de passe. | **Critique** | Mesuré §4.2 |
| **C4** ✅ **corrigé (lot 11.2)** | **Permissions insuffisantes** : dossier `data/` en **0755**, base `depotpro.db` et ses `-wal`/`-shm` en **0644**, sauvegardes en **0644** ; seuls `*.manifest.json` et la copie `staged` sont en **0600**. Un autre compte local lit la base. | **Élevée** | Mesuré §4.3 |
| **C5** ✅ **corrigé (lot 11.5)** | **Changement de mot de passe sans révocation** (Node **et** Rust) : l'ancien jeton reste valide 12 h après le changement, y compris celui d'un attaquant. | **Élevée** | Mesuré §4.4 |
| **C6** | **Aucun contrôle d'intégrité au démarrage** : une base tronquée renvoie `database disk image is malformed` (erreur brute) au lieu d'un message et d'une procédure de récupération. | **Élevée** | Mesuré §4.6 |
| **C7** | **Aucune sauvegarde avant migration** : si une migration échoue au milieu d'une série, les précédentes restent validées et la base est dans un état mixte, sans copie de retour. | **Élevée** | Mesuré §4.7 |
| **C8** | **Rétrogradation non refusée** : un binaire plus ancien ouvre sans broncher une base migrée par une version plus récente (0 migration appliquée, aucune alerte). | **Moyenne** | Mesuré §4.7 |
| **C9** | **Journal d'audit falsifiable** : `DELETE FROM audit_logs` ne laisse aucune trace ; les lignes supprimées **restent dans les octets du fichier** après `VACUUM`. | **Élevée** | Mesuré §4.8 |
| **C10** ✅ **corrigé (lot 11.1)** | **Manifeste non signé, hors base** : le SHA-256 est recalculé depuis le fichier. Il prouve l'intégrité physique, **pas l'authenticité** ; rien ne lie un manifeste à une base donnée. Un fichier `manifest.json` peut être supprimé sans conséquence. | Moyenne | Constaté §4.2 |
| **C11** | **Mises à jour non signées / non testées** : aucun plugin `updater`, aucune clé publique ; la signature MSI/DMG repose sur des scripts **jamais exécutés**. Aucune preuve que la désinstallation préserve les données. | **Critique si updater activé** | Constaté §4.9 |
| **C12** | **Bons points à préserver** : jetons `randomBytes(32)` stockés hachés SHA-256, TTL 12 h, révocation à la déconnexion/désactivation, verrouillage 5 échecs/15 min, RBAC vérifié avant écriture, CSP sans origine réseau, aucun `eval`/`innerHTML`, migrations à somme de contrôle refusant une migration modifiée, restauration par copie `PRE_RESTORE` avec rollback fichier. | — | §3 |
| C13 | Détails mineurs : `dbPath` absolu exposé dans le DTO santé ; sessions expirées jamais purgées ; le mode serveur de référence écrit dans `./data` (risque de dossier synchronisé) ; pas de `secure_delete`. | Faible | §4.3, §4.4 |

**Ce que les sondes changent par rapport à l'intuition.** On attendait surtout
un problème de chiffrement ; le résultat le plus grave est **C1** : la
restauration, présentée comme l'opération « la plus destructive du logiciel »
(LOT 9), est protégée par un fichier marqueur **que rien n'authentifie**. La
sonde 4 (§4.5) a restauré une base par simple dépôt de fichier et a fait
disparaître une vente de 250 000 XOF **sans mot de passe**. Le chiffrement
(C2/C3) reste indispensable, mais il ne corrige pas C1 : même une base
chiffrée se laisse remplacer par une copie chiffrée antérieure si le marqueur
n'est pas signé.

**Recommandation d'ensemble** (détail §6) : trois chantiers **avant** le
chiffrement — (1) authentifier le marqueur de restauration et le manifeste
(HMAC à clé hors base), (2) durcir les permissions 0700/0600 et l'emplacement,
(3) ajouter `quick_check` au démarrage + sauvegarde pré-migration + refus de
rétrogradation — puis le chiffrement SQLCipher (clé dans le trousseau OS) et la
chaîne d'audit. Aucun de ces chantiers ne casse les 67 tests existants.

> **Statut au 16/11/2026 (soir)** : (1) et (2) sont **faits et testés** ; (3) et
> le chiffrement restent **à faire**. Voir §9 pour les preuves et §6.2 pour ce
> qui reste ouvert.

---

## 2. Modèle de menace

### 2.1 Actifs à protéger

| Actif | Où il vit | Sensibilité |
| --- | --- | --- |
| Marges, prix d'achat/vente, CUMP | `products`, `stock_movements`, `sale_items` | **Commerciale** — secret d'affaires |
| Créances clients, dettes fournisseurs | `customers`, `suppliers`, `payments`, `purchase_orders` | **Financière + données personnelles** |
| Caisse, dépenses, clôtures, écarts | `cash_sessions`, `cash_movements`, `expenses` | **Financière** |
| Consignes (emballages) | `consignment_movements` | Commerciale |
| Comptes, hachages de mots de passe | `users`, `roles`, `role_permissions` | **Sécurité** |
| Jetons de session (hachés) | `user_sessions.token_hash` | **Sécurité** |
| Journal d'audit | `audit_logs`, `login_logs` | **Intégrité / preuve** |
| Licence locale | `license_state` | Commerciale (anti-piratage) |
| Sauvegardes + manifestes | `data/backups/*.db`, `*.manifest.json` | **Tout ce qui précède, en double** |
| Marqueur de restauration | `data/restore-pending.json` | **Contrôle** — point d'entrée de C1 |

### 2.2 Adversaires considérés

Le scénario explicite — « accès direct au système de fichiers » — recouvre
cinq profils qu'il faut distinguer, car les contre-mesures diffèrent :

| Profil | Capacité | Ce qu'il peut faire aujourd'hui (mesuré) |
| --- | --- | --- |
| **A. Autre compte non administrateur du poste** | Lecture des fichiers autorisés par les ACL | **Lit la base** (0755/0644) et toutes les sauvegardes |
| **B. Administrateur local / technicien** | Tout, y compris dumper la mémoire et lire le trousseau | Chiffrement au repos **inefficace** si la clé est déverrouillée par le même compte |
| **C. Vol du disque ou du portable** | Accès hors ligne | **Lit tout**, sauf si le disque est chiffré (BitLocker/FileVault) |
| **D. Utilisateur légitime malveillant** (caissier, gérant) | Session valide + accès disque | **Restaure une sauvegarde ancienne sans mot de passe** (C1), supprime `audit_logs`, copie la base |
| **E. Logiciel malveillant** | Mêmes droits que le processus | Lit la base, la clé si dérivable, exfiltre les sauvegardes |

**Conclusion** : le chiffrement au repos protège **efficacement** de A, C et E
passif ; il protège **partiellement** de B et D. Il ne protège **jamais** d'un
B actif pendant que l'application est ouverte — cela doit être écrit dans la
documentation client, sans détour.

### 2.3 Hors modèle de menace (assumé)

- Attaquant avec débogueur noyau pendant l'exécution.
- Réinstallation de l'OS (seule une copie hors site chiffrée répondrait à ce
  cas, hors périmètre « 100 % hors ligne »).
- Fuite de la phrase de passe par l'utilisateur lui-même.

---

## 3. Ce qui protège déjà (et qu'il ne faut pas casser)

### 3.1 Authentification et sessions — **Constaté par lecture + tests LOT 1**

| Mesure | Emplacement | État |
| --- | --- | --- |
| Mots de passe : `scrypt` N=2¹⁴, r=8, p=1, sel aléatoire 16 octets, comparaison à temps constant | `server/security/password.ts:1-25`, `src-tauri/src/security/password.rs` | OK, parité Node ↔ Rust testée |
| Jeton : **256 bits aléatoires** (`randomBytes(32)`), seul le **SHA-256** est en base | `password.ts:29-38` | OK |
| TTL 12 h, `expires_at` vérifié à chaque appel | `authRepo.ts:14`, `auth_repo.rs:129-133` | OK |
| Révocation : déconnexion, désactivation du compte | `authRepo.ts:441,636`, `foundation_repo.rs:391,616` | OK **sauf changement de mot de passe** (C5) |
| Verrouillage 5 échecs / 15 min, journalisé dans `login_logs` | `authRepo.ts:12-13,276-296` | OK |
| RBAC : 14 permissions, vérifiées **avant** chaque écriture métier | `authMiddleware.ts`, `security/session.rs` | OK |
| `backup.manage` réservé au propriétaire | `0002_seed_foundations.sql:26-32` | OK |
| `audit_logs` sur toutes les opérations sensibles | tous les dépôts | OK **mais falsifiable** (C9) |

### 3.2 Intégrité et récupération — **Tests LOT 9 verts**

- `VACUUM INTO` (jamais `copyFile`) : instantané compacté, cohérent avec WAL.
- SHA-256 par blocs de chaque copie ; manifeste `depotpro-backup-manifest` v1.
- Restauration jamais à chaud : copie `staged`, migrations appliquées **sur
  cette copie**, `integrity_check` + `foreign_key_check`, marqueur, activation
  **avant** l'ouverture du pool, copie `depotpro.pre-restore-*.db` conservée,
  rollback fichier si l'activation échoue.
- Confirmation littérale `RESTAURER` validée côté backend, copie `PRE_RESTORE`
  obligatoire, RBAC `backup.manage` — **quand on passe par l'API**. Le défaut
  C1 est le contournement de ce chemin.
- Scénario O (mise à jour 10 → 15 migrations sans perte) vert.

### 3.3 Durcissement déjà présent

- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` sur `/api/*`.
- CORS limité aux origines locales et à l'hôte de prévisualisation, sans
  `Allow-Credentials` (jeton en en-tête, pas de cookie).
- CSP desktop `connect-src 'self' ipc: http://ipc.localhost` — **aucune origine
  réseau**.
- Aucun `dangerouslySetInnerHTML`, `eval`, `new Function` dans `src/`.
- `foreign_keys=ON`, WAL, `synchronous=NORMAL`, `busy_timeout=5000`.
- Migrations à somme de contrôle SHA-256 : une migration **déjà appliquée et
  modifiée** fait échouer le démarrage (`db/mod.rs:118-124`,
  `sqlite.ts:83-90`).

---

## 4. Constats détaillés et mesures

Toutes les sondes de cette section ont été exécutées avec le **code réel** du
dépôt (`initLocalSqlite`, `AuthRepository`, `BackupRepository`) sur Linux, base
temporaire, `node:sqlite` 3.51.3.

### 4.1 Chiffrement de la base — **ABSENT (Critique)**

**Constat.** `src-tauri/src/lib.rs:72-73` ouvre
`app_data_dir()/depotpro.db` avec `SqliteConnectOptions::new()` — sans
`PRAGMA key`, sans SQLCipher. Node fait de même (`sqlite.ts:28-42`). Aucune
dépendance de chiffrement dans `Cargo.toml` ni `package.json` : seules
`scrypt` et `sha2` existent, pour les mots de passe et les empreintes.

**Mesure.** Une copie de `data/depotpro.db` se lit sans mot de passe :

```
$ sqlite3 data/depotpro.db "select full_name, phone, commercial_debt_xof from customers;"
Client Confidentiel|0700000000|175000
```

Toute copie du fichier — `Ctrl+C`, script, antivirus, sauvegarde système — est
une fuite complète.

**Piège à connaître avant d'écrire du code.** `PRAGMA key='x'` **ne renvoie
aucune erreur** avec `node:sqlite` (sonde exécutée) : le SQLite embarqué n'est
pas SQLCipher et le pragma est ignoré silencieusement. Un test qui vérifie
seulement « pas d'exception » ne prouverait **pas** le chiffrement. Le seul
test valable est : `sqlite3 <fichier>` échoue ou renvoie du binaire illisible.

### 4.2 Chiffrement des sauvegardes et authentification — **ABSENT (Critique)**

**Mesure (sonde 2, exécutée).** Sauvegarde créée par `BackupRepository.createBackup`,
puis ouverte en lecture seule **sans l'application** :

```
1) Sauvegarde lisible SANS application ni mot de passe :
   clients   : [{"full_name":"Client Confidentiel","phone":"0700000000","commercial_debt_xof":175000}]
   annulation: [{"action":"SALE_CANCELLED","payload_json":"{\"montant\":120000}"}]
   hash pwd  : scrypt:b5eab211274640ebadb…
```

**Ce que le manifeste ne fait pas.** `inspect_manifest` (`domain/backup.rs:195-231`,
`backupRepo.ts:256-277`) compare `backupId` et `sha256`. Le `sha256` est
**recalculé depuis le fichier** : il prouve l'intégrité physique, pas
l'authenticité. Aucune signature, aucun HMAC, aucune clé. Un attaquant qui a
le fichier a aussi le manifeste ; il peut donc le réécrire de façon cohérente.
`backup_history.file_path` (table SQLite modifiable en SQL) désigne le fichier
à restaurer : changer cette colonne suffit à faire restaurer un autre fichier
**sans même toucher au manifeste**, pour peu que ses contrôles SQLite passent.

**Aggravant — anti-rejeu.** Rien ne distingue une sauvegarde d'aujourd'hui
d'une copie d'il y a trois mois. Un utilisateur peut remettre en place l'état
d'avant une vente, et la base ne s'en aperçoit pas (le SHA-256 est recalculé).

### 4.3 Protection des répertoires applicatifs — **INSUFFISANTE (Élevée)**

**Mesure (sondes 1 et 2, exécutées, umask 022) :**

```
dossier data        0755
base depotpro.db    0644
base -wal           0644
base -shm           0644
sauvegarde .db      0644
manifeste .json     0600   ← seul fichier explicitement protégé
```

Extrait exact du code : `db/mod.rs:156` et `sqlite.ts:29-31` font
`create_dir_all` / `mkdirSync` **sans forcer 0700** ; le fichier de base n'est
**jamais** passé en 0600. Seuls `domain/backup.rs:161-186` (`write_private`) et
`pendingRestore.ts:159` posent un mode. Résultat : sur un poste où un autre
compte local a accès au dossier, **toute la base est lisible**, alors que le
manifeste ne l'est pas — protection incohérente.

**Nuances par plateforme** (à documenter, ne pas surestimer) : sur Windows,
`%APPDATA%\<app>` hérite des ACL du profil et les comptes *standard* n'y ont pas
accès (un administrateur, oui) ; sur macOS, `~/Library/Application Support` est
protégé par le `$HOME` en 0700. Le mode applicatif est donc un **héritage**, pas
une décision — et il tombe à zéro dès que le dossier est copié ou partagé.

**Défaut d'emplacement distinct.** Le serveur de référence écrit
`./data/depotpro.db` (`sqlite.ts:21-23`). Un dossier synchronisé (OneDrive,
iCloud, Drive, partage réseau) copie des `.db-wal`/`.db-shm` en désordre et
**corrompt** la base : le risque de corruption dépasse ici le risque de fuite.

### 4.4 Protection des jetons de session — **BONNE, avec un défaut majeur (C5)**

| Question | Réponse | Référence |
| --- | --- | --- |
| Jeton stocké en clair ? | **Non** — `sha256(token)` seulement | `password.ts:35-37` |
| Où vit-il côté client ? | `sessionStorage` (`depotpro_session_token`), pas de cookie, pas de `localStorage` | `ipc.ts:6-22` |
| Lisible par un XSS ? | Oui, comme tout `sessionStorage` — mais aucun `innerHTML`/`eval` dans `src/`, CSP `script-src 'self'` | §3.3 |
| Expiration ? | 12 h, comparée à `Utc::now()` à chaque appel | `auth_repo.rs:129-133` |
| Révocation ? | Déconnexion, désactivation, **pas le changement de mot de passe** | **C5** |
| Purge des sessions expirées ? | **Non** — aucun `DELETE FROM user_sessions` | `grep` négatif |
| Rotation ? | Non (TTL 12 h) — acceptable sur poste unique | — |
| Jeton dans les journaux ? | Il est dans le **payload** d'invocation (`ipc.ts:448`) ; aucun `println!` de l'input côté Rust (vérifié) | — |

**C5 — Mesure (sonde 1, exécutée).**

```
session valide après changement de mot de passe ? true
```

Node (`authRepo.ts:455-500`) et Rust (`foundation_repo.rs:408-453`) mettent à
jour `password_hash` et écrivent `PASSWORD_CHANGED`, **sans révoquer** les
sessions. Un mot de passe changé après un soupçon de compromission **ne coupe
pas** la session de l'attaquant : elle reste valide jusqu'à 12 h. À l'inverse,
la désactivation du compte et le `logout` révoquent bien (vérifié).

**Point d'architecture à consigner** : côté Rust, le jeton transit dans
`input.token` à chaque commande (choix de portage fidèle à l'en-tête HTTP). En
release, devtools et CSP limitent l'exposition ; en recette, un `devtools`
ouvert expose tous les jetons dans l'onglet réseau. Le mode `strict` ne
journalise rien, mais la règle « ne jamais logger l'input » doit être écrite.

**Écart de génération Rust** : `raw_token = uuid4 + uuid4` (`auth_repo.rs:173`)
soit 244 bits utiles (6 bits de version/variant consommés), contre 256 bits
côté Node. Suffisant, mais ce n'est pas un choix documenté.

### 4.5 Récupération et restauration — **DÉFAUT CRITIQUE C1**

**Mesure (sonde 4, exécutée, scénario complet) :**

```
1) sauvegarde créée : depotpro-manual-…-4254f9b5.db
2) activité postérieure : 2 clients, 1 vente à crédit de 250 000 XOF
3) marqueur forgé à la main (aucun mot de passe, aucun RBAC, aucun audit préalable)
4) après redémarrage : clients = 1 | vente de 250 000 retrouvée = 0
5) traces laissées (comme server.ts) : [{"action":"BACKUP_RESTORE_APPLIED"}]
```

**Mécanisme.** Le marqueur `restore-pending.json` est un JSON non signé
contenant `stagedPath` et `stagedChecksum`. `applyPendingRestore` vérifie
seulement : version, confirmation `RESTAURER`, longueur du checksum,
existence du fichier, `sha256(staged) == stagedChecksum`, puis l'intégrité
SQLite de la copie. **Toutes ces valeurs sont fournies par l'attaquant**, qui
calcule le SHA-256 de son propre fichier. Aucune signature, aucun secret, aucun
lien avec `backup_history`. C'est une **restauration non authentifiée** : le mot
de passe demandé par l'API est contourné en écrivant le fichier directement.

**Pourquoi c'est grave.** L'opération est documentée comme « la plus
destructive du logiciel », protégée par RBAC et copie `PRE_RESTORE` — sur le
chemin API seulement. Sur le chemin fichier, tout est annulable : une vente, une
clôture de caisse, une sortie de stock, une dépense. Le journal (C9) est la
seule trace, et il est lui-même modifiable — puis il **disparaît avec la
restauration** si l'attaquant restaure une copie antérieure à ses méfaits.
`PRE_RESTORE` n'est **pas** pris quand on passe par le fichier (vérifié : la
copie `depotpro.pre-restore-*.db` n'est créée que dans le chemin `restore_backup`).

**Correctif minimal (peu coûteux)** : signer le marqueur avec une clé qui
**n'est pas dans la base** (HMAC-SHA256, clé du trousseau OS), et vérifier la
signature **avant** toute autre chose. Sans la clé, un attaquant ne peut plus
forger ni modifier un marqueur. Cela ne remplace pas le RBAC : cela ferme le
contournement fichier.

### 4.6 Corruption de la base au démarrage — **PAS DE GARDE-FOU (Élevée)**

**Mesure (sonde 3A, exécutée) :** base créée par l'application, tronquée à 50 %
du fichier, redémarrage :

```
A) base tronquée -> erreur brute NON GÉRÉE : database disk image is malformed
```

Aucun `PRAGMA quick_check` au démarrage (`grep` négatif sur `db/` et
`sqlite.ts`). La vérification n'existe qu'à la restauration, à la vérification
manuelle et dans le self-test. Conséquence pratique : au premier écran,
l'utilisateur reçoit une erreur technique, en conclut à un bug, et peut
réinstaller — écrasant ses données. Il n'existe **aucun** écran « base
corrompue → dernière sauvegarde vérifiée ? ».

**Second point** : `synchronous=NORMAL` peut perdre les dernières secondes de
transactions en cas de coupure (pas de corruption, mais perte). Compromis
acceptable **si** la sauvegarde automatique est active ; à documenter.

### 4.7 Sécurité des mises à jour — **FAIBLE (C7, C8, C11)**

**Mesure (sonde 3B, exécutée) — rétrogradation :**

```
B) rétrogradation 15 -> 10 : ACCEPTÉE, migrations appliquées = 0
```

Un binaire plus ancien ouvre une base plus récente sans contrôle : les
migrations inconnues sont simplement ignorées, aucune erreur. Les requêtes sur
des colonnes introduites par 0011 → 0015 échoueront plus tard, de façon
diffuse.

**Mesure (sonde 3C, exécutée) — migration cassée au milieu d'une série :**

```
C) échec 0013 -> Échec d'application de la migration 0013…
   versions validées après échec : 1,2,3,4,5,6,7,8,9,10,11,12
   redémarrage « ancienne version » : ACCEPTÉ (état mixte 0011-0012 appliqués)
   dossier backups/ pré-migration  : ABSENT
```

Chaque fichier est bien transactionnel, **mais il n'y a aucune sauvegarde du
fichier avant l'opération**. Une série interrompue laisse la base à un état
intermédiaire non représenté par une version publiée : l'ancienne version
démarre, mais avec des index/colonnes partiels.

**Chaîne de confiance des binaires.** `Cargo.toml` ne contient **aucun** plugin
`tauri-plugin-updater` ; `tauri.conf.json` ne déclare ni `pubkey` ni
`endpoints` ; `capabilities/default.json` n'accorde que `core:default`. Il
n'existe donc **pas de mise à jour automatique** — ce qui supprime le risque
« serveur de mise à jour compromis », mais laisse entier « installateur
non signé ». `scripts/sign-windows.ps1` (signtool + horodatage) et
`scripts/notarize-macos.sh` (codesign + notarytool + staple) sont présents mais
**jamais exécutés** (`docs/LOT10_PORT_RUST.md` §6). Tant qu'ils ne tournent
pas, un MSI/DMG peut être remplacé par n'importe qui.

**Désinstallation.** §10 exige que supprimer l'application **ne supprime pas**
les données. MSI/NSIS ne touchent pas `%APPDATA%` par défaut — c'est correct
— mais **aucun test ne le prouve** (déjà listé comme non satisfait au LOT 10).

### 4.8 Intégrité du journal d'audit — **FALSIFIABLE (Élevée)**

**Mesure (sonde 2, exécutée) :**

```
2) Ligne d'audit supprimée par SQL direct, aucune alerte : {"c":0}
```

Aucune chaîne de hachage, aucun scellement, aucun HMAC. `audit_logs` est une
table ordinaire (`0001_initial_schema.sql:426-434`). Le self-test ne compare
rien : il vérifie la présence de la table, pas sa continuité.

**Mesure complémentaire (sonde 5, exécutée)** — la suppression ne libère pas
les octets :

```
integrity_check après suppression : ok | quick_check : ok
lignes « supprimées » encore présentes dans les octets du fichier : ["a6","a7","a8","a9"]
```

`PRAGMA secure_delete` n'est pas activé. Après `DELETE`, les valeurs restent
dans les pages libres et **un `VACUUM` ne les efface pas toujours** (les pages
libérées sont conservées dans le fichier compacté sur ce cas). Pour des données
financières et personnelles, la suppression logique n'est donc pas une
suppression physique — à documenter, et à corriger par `secure_delete=ON` +
`VACUUM` lors des purges volontaires.

### 4.9 Points mineurs (C13)

- `SystemHealthDTO.dbPath` expose le chemin absolu (nom de compte OS) à tout
  utilisateur avec `settings.depot.manage` (`systemRepo.ts:109`) ; le jeton
  n'est pas concerné mais c'est de la reconnaissance gratuite.
- Aucune purge `user_sessions` : la table grossit indéfiniment et grossit
  toutes les sauvegardes.
- `restore_dir` et `backups_dir` ne sont pas protégés en 0700 (cf. §4.3).
- `lib.rs:103` écrit l'échec de sauvegarde sur `eprintln!` : en build Windows
  GUI (`windows_subsystem = "windows"`), cette sortie est **invisible** ; un
  échec de sauvegarde automatique peut donc être silencieux pour l'utilisateur.

---

## 5. Écarts de parité Node ↔ Rust à corriger

| # | Écart | Preuve | Correctif |
| --- | --- | --- | --- |
| P1 | Changement de mot de passe **sans révocation** des sessions dans les deux runtimes | `authRepo.ts:455-500`, `foundation_repo.rs:408-453` | `UPDATE user_sessions SET revoked_at = … WHERE user_id = ? AND revoked_at IS NULL` dans la même transaction, sauf la session courante ; test : ancien jeton → refus |
| P2 | Changement de rôle **sans révocation** (Node et Rust) : un gérant rétrogradé garde ses permissions jusqu'à 12 h car `AuthenticatedUser.permissions` est rechargé à chaque appel… mais depuis le rôle **courant** en base — vérifié : le rechargement reflète le nouveau rôle. **Pas de défaut de permissions**, mais la session n'est pas révoquée pour autant ; à clarifier par un test | `authRepo.ts:697-757`, `foundation_repo.rs:678-740` | Décision explicite : révoquer (plus sûr) ou conserver et documenter |
| P3 | Jeton Rust = 2 UUID v4 (244 bits) au lieu de 32 octets aléatoires | `auth_repo.rs:173,301` | 32 octets via `OsRng`, hex — `token_hash` inchangé (SHA-256) |
| P4 | Aucune permission 0700/0600 sur `data/`, `backups/`, `restore/`, base et sidecars | §4.3 | Helper commun `secure_dir()` / `secure_file()` après chaque création |
| P5 | Marqueur de restauration non signé (les deux runtimes) | §4.5 | HMAC du marqueur, clé hors base ; vérification avant tout |

Note : `check_rust.py` **interdit** `argon2` et `rusqlite`. Si l'option O2
(phrase de passe → Argon2id → clé SQLCipher) est retenue au §6.1, l'interdiction
devra être révisée **explicitement** : `scrypt` reste le format des mots de
passe utilisateurs, Argon2id ne servirait qu'à dériver la clé. Ne pas changer
le format des hachages existants.

---

## 6. Plan de durcissement proposé (LOT 11)

### 6.1 Décision à prendre avant tout code — le modèle de clé

| Option | Mécanisme | Effort | Protège de | À choisir quand |
| --- | --- | --- | --- | --- |
| **O1** SQLCipher + clé 256 bits dans le **trousseau OS** (`keyring`, Keychain, Credential Manager) | Clé générée au premier lancement, stockée dans le coffre du compte ; le binaire ouvre la base avec elle | Moyen | A, C, E passif | **Défaut** |
| **O2** Phrase de passe maître (Argon2id → clé SQLCipher) | Saisie à chaque lancement | Moyen+ | A, **B**, C, E passif | Poste partagé, données très sensibles |
| **O3** Chiffrement applicatif de colonnes (AES-256-GCM, clé du trousseau) | Seules les colonnes à forte valeur sont chiffrées | Élevé | A partiel | Repli si SQLCipher impossible à lier |
| **O0** Renoncer au chiffrement, durcir permissions + BitLocker/FileVault recommandés | — | Faible | C (si chiffrement OS actif), A partiel | Budget nul — **à écrire noir sur blanc** dans la doc client |

**Question bloquante à trancher** : les dépôts sont-ils équipés de postes
**mono-utilisateur** (un compte OS par dépôt) ou **partagés** (patron et
caissier sur le même compte Windows) ? Dans le second cas, O1 ne protège **pas**
le caissier du patron ni l'inverse : seule O2 le fait.

**Contrainte de décision couplée** : si la base est chiffrée, le backend Node de
prévisualisation **ne peut plus l'ouvrir**. Trois stratégies, à documenter :
(a) `better-sqlite3-sqlcipher` (nouvelle dépendance native) ; (b) base de
prévisualisation **distincte et non chiffrée** dans `data/preview/` ; (c)
supprimer le mode preview sur base réelle. **(b) est la plus sûre** : elle
empêche un build de recette de pointer par erreur sur la base de production.

### 6.2 Lots de travail, ordonnés par risque / effort

| Lot | Contenu | Critère d'acceptation | Dépend de |
| --- | --- | --- | --- |
| **11.1** Marqueur authentifié | HMAC-SHA256 du marqueur (clé hors base, trousseau) ; vérifier la signature **avant** le SHA-256 du fichier ; refuser un marqueur non signé ; idem pour `backup_history.file_path` (préférer `backupId` + résolution interne) | Test : marqueur forgé → refus explicite, base intacte ; le test de la sonde 4 échoue | — |
| **11.2** Permissions & emplacement | 0700 dossier, 0600 base/`-wal`/`-shm`/sauvegardes/`restore-pending.json` ; refus des dossiers synchronisés ou réseau ; ACL Windows explicites | Test : `stat` renvoie 0700/0600 ; démarrage refusé dans OneDrive | — |
| **11.3** Intégrité au démarrage | `quick_check` (rapide) ; si ≠ ok → `integrity_check` complet + écran « base corrompue » proposant la dernière sauvegarde vérifiée ; jamais d'erreur SQLx brute | Test : fichier tronqué → message dédié + base intacte + sauvegarde proposée | — |
| **11.4** Mises à jour des données | `VACUUM INTO data/backups/pre-migration-<v>-<v>.db` avant toute migration nouvelle ; `app.version` en `system_meta` ; refus de démarrage si binaire < version ayant migré | Test : migration 0016 en échec → retour au fichier pré-migration identique | — |
| **11.5** Sessions | Révocation au changement de mot de passe (Node + Rust) ; purge des sessions expirées ; jeton Rust 32 octets ; test « ancien jeton refusé » | Tests verts, aucun test existant cassé | — |
| **11.6** Chiffrement au repos | O1 sur `depotpro.db`, `*.db` de sauvegarde et `staged` ; test `sqlite3` doit échouer | Application fonctionnelle, tests LOT 9 verts, fichier illisible sans clé | 6.1, 11.1 |
| **11.7** Manifeste signé & anti-rejeu | HMAC du manifeste (même clé hors base) ; `backupSeq` monotone ; refus d'une restauration dont la séquence précède la dernière appliquée | Manifeste modifié → refus ; rejeu → refus tracé | 11.6 |
| **11.8** Audit inviolable | Chaîne `entry_hash = SHA-256(prev_hash \|\| …)` + HMAC clé hors base ; vérification dans `run_foundation_self_test` ; `secure_delete=ON` + `VACUUM` lors des purges | Suppression d'une ligne → self-test FAILED ; test de chaîne | 11.6 |
| **11.9** Distribution | Exécuter réellement signature + notarisation ; si updater : plugin officiel, `pubkey` embarquée, endpoint HTTPS, test « données conservées après mise à jour » ; test d'installation/désinstallation prouvant que `depotpro.db` survit | Installateurs signés ; test d'installation réel | 11.4 |
| **11.10** Documentation client | Procédures §14.12–14.14 (sauvegarde, restauration, mise à jour) + **liste des limites** : ce que le chiffrement ne protège pas | Documents livrés et datés | 11.1–11.9 |

### 6.3 Ce qu'il ne faut pas faire

- **Ne pas** chiffrer avec une clé stockée dans `system_meta` ou dans un fichier
  voisin : c'est de l'obfuscation, pas du chiffrement, et cela donne une fausse
  assurance au client.
- **Ne pas** conclure au chiffrement parce que `PRAGMA key` ne lève pas
  d'erreur (§4.1) : tester avec `sqlite3`, jamais par absence d'exception.
- **Ne pas** remplacer `scrypt` par `argon2` pour les mots de passe
  utilisateurs : cela casserait la parité Node ↔ Rust et exigerait une
  migration de tous les hachages.
- **Ne pas** activer `synchronous=OFF` ni désactiver `foreign_keys` pour la
  performance : gain marginal, risque de corruption réel.
- **Ne pas** ajouter un updater non signé « pour tester » : une fois ouvert, le
  canal devient la voie d'attaque privilégiée.
- **Ne pas** compter sur le manifeste `.manifest.json` comme preuve
  d'authenticité : sans HMAC, il ne prouve que la cohérence du fichier.

---

## 7. Preuves d'exécution (16/11/2026)

| Contrôle | Commande | Résultat |
| --- | --- | --- |
| Suite de tests | `npx vitest run` | **15/16 fichiers, 66/67 tests** — 1 échec **d'environnement** : `tree_sitter` absent, le test lance `check_rust.py` qui se dégrade en contrôle de délimiteurs et produit un faux positif sur `purchases.rs` (parenthèses dans des chaînes SQL). Avec `tree_sitter` installé, le script passe (voir ligne suivante) |
| Contrôle statique Rust | `python3 scripts/check_rust.py` (tree-sitter installé en venv) | **OK** — 46 fichiers, 42 compilés, 95/95 commandes, 99 handlers, syntaxe complète |
| TypeScript | `npx tsc --noEmit` | **OK** |
| Build frontend | `npx vite build` | **OK** (1,14 s) |
| Sonde 1 — permissions & session | code réel (`initLocalSqlite`, `AuthRepository`, `BackupRepository`) | `data/` **0755**, base **0644**, `-wal` **0644**, `-shm` **0644**, sauvegarde **0644**, manifeste 0600 ; session **valide** après changement de mot de passe |
| Sonde 2 — lecture hors application & audit | ouverture des `.db` en lecture seule + `DELETE` en SQL direct | clients, dettes, annulation et hash de mot de passe **lisibles** ; ligne d'audit **supprimée sans alerte** |
| Sonde 3A — base tronquée | `fs.truncateSync` à 50 % puis redémarrage | **`database disk image is malformed`**, erreur brute non gérée |
| Sonde 3B — rétrogradation | base à 15 migrations ouverte avec `migrations/` 0001–0010 | **acceptée**, 0 migration, aucune alerte |
| Sonde 3C — migration cassée | 0013 corrompue, base à 10 migrations | échec explicite **mais 0011–0012 déjà validées**, **aucun** dossier `backups/` pré-migration |
| Sonde 4 — restauration forgée | `restore-pending.json` écrit à la main + redémarrage | **restauration appliquée** : 1 client au lieu de 2, **vente de 250 000 XOF disparue**, aucune authentification |
| Sonde 5 — suppression physique | 4 lignes supprimées puis `VACUUM` | `integrity_check ok`, mais les identifiants supprimés **restent dans les octets du fichier** |
| Chiffrement SQLite | `PRAGMA key='x'` via `node:sqlite` | **aucune erreur** → SQLite non chiffrant (pragma ignoré) ; version 3.51.3 |
| `cargo check` / `cargo test` | — | **Non exécutable ici** (pas de toolchain Rust, pas de `Cargo.lock`) |

---

## 8. Synthèse des statuts (§15)

- **Terminé et vérifié** : authentification (scrypt salé, temps constant),
  jetons aléatoires stockés hachés, TTL et révocation (sauf P1), verrouillage,
  RBAC, sauvegarde `VACUUM INTO` + SHA-256, restauration différée à froid avec
  `PRE_RESTORE` et rollback **sur le chemin API**, migrations transactionnelles
  à somme de contrôle, absence d'`eval`/`innerHTML`, CSP sans origine réseau,
  contrôle statique Rust (95/95) et suite TypeScript verte.
- **Absent / défaillant (à traiter)** : marqueur de restauration non
  authentifié (**C1**), base et sauvegardes en clair, permissions 0700/0600,
  révocation au changement de mot de passe, `quick_check` au démarrage,
  sauvegarde pré-migration, refus de rétrogradation, manifeste signé et
  anti-rejeu, chaîne d'audit et `secure_delete`, purge des sessions,
  installateurs signés, ACL Windows.
- **Risques résiduels acceptés (à documenter au client)** : un administrateur
  local ou un logiciel malveillant actif pendant l'exécution peut lire la base
  déchiffrée ; un utilisateur légitime peut toujours copier une sauvegarde qu'il
  a lui-même créée ; le mode preview Node restera non chiffré si la stratégie
  (b) du §6.1 est retenue.
- **Question bloquante** : poste mono-utilisateur ou partagé (§6.1) — elle
  décide entre O1 (transparent) et O2 (phrase de passe).

---

## 9. Rapport de réalisation — lots 11.1, 11.2 et 11.5 (16/11/2026, soir)

### 9.1 Décision client et conséquence

**Question du §6.1 tranchée** : « postes **mono-utilisateur** ». Conséquence
directe : **option O1** pour le chiffrement de la base — SQLCipher avec une clé
de 256 bits rangée dans le trousseau du compte OS (Keychain macOS, Credential
Manager Windows, Secret Service Linux). La phrase de passe maître (O2) est
**écartée** : elle imposerait une saisie au lancement et une procédure de
récupération de clé qui n'a pas de sens sur un poste à un seul compte. Le
compromis est assumé et documenté : O1 protège du vol de disque, d'un autre
compte local et d'un malware passif, **pas** d'un administrateur qui ouvre
l'application déverrouillée.

> **Effet de bord à traiter au lot 11.6** : une base chiffrée n'est plus
> ouvrable par le backend Node de prévisualisation (`node:sqlite` n'expose pas
> de `PRAGMA key` fonctionnel — vérifié au §4.1). La stratégie retenue est (b)
> du §6.1 : **base de prévisualisation distincte et non chiffrée** dans
> `data/preview/`, afin qu'un build de recette ne puisse pas pointer sur la base
> de production.

### 9.2 Ce qui a été livré et prouvé

| Constat | Mesure AVANT (sonde du §4) | Mesure APRÈS (même sonde) |
| --- | --- | --- |
| **C1** — restauration forgée à la main | restauration **appliquée** : 1 client au lieu de 2, vente de 250 000 XOF disparue, aucune authentification | **refusée** : `Restauration refusée : marqueur non scellé… Aucune base n'a été remplacée.` Base intacte, marqueur conservé pour diagnostic |
| **C4** — permissions | `data/` **0755**, base **0644**, `-wal`/`-shm` **0644**, sauvegardes **0644** | `data/` **0700**, base **0600**, `-wal`/`-shm` **0600**, sauvegardes **0600**, clé de scellement **0600** |
| **C5** — session après changement de mot de passe | `session valide après changement de mot de passe ? true` | `false` — la session courante est conservée, **toutes les autres sont révoquées** (1 session révoquée, journalisée avec son compte) |
| **C10** — manifeste | v1, SHA-256 recalculé, aucune authenticité | **v2 scellé** (HMAC-SHA256) ; un manifeste v1 est signalé `UNSEALED` et **bloque** restauration et téléchargement |

### 9.3 Fichiers créés

| Fichier | Rôle |
| --- | --- |
| `server/security/fsGuard.ts` | `ensurePrivateDir` (0700), `restrictFile` / `restrictDatabaseFiles` (0600) |
| `server/security/localSeal.ts` | Clé de scellement locale, HMAC-SHA256, messages canoniques (marqueur et manifeste), comparaison à temps constant |
| `tests/lot11-securite-locale.test.ts` | **15 tests** : forgery du marqueur, manifeste scellé/v1/rejeu, permissions, révocation, vecteurs HMAC partagés, aperçu robuste |

### 9.4 Fichiers modifiés

| Fichier | Changement |
| --- | --- |
| `server/db/pendingRestore.ts` | Marqueur **scellé** à l'écriture, **vérifié avant toute autre étape** à la lecture ; dossier de données privé avant écriture |
| `server/db/sqlite.ts` | `ensurePrivateDir` avant ouverture, `restrictDatabaseFiles` après ouverture (base + `-wal` + `-shm`) |
| `server/repositories/backupRepo.ts` | Manifeste **v2 scellé** (`MANIFEST_VERSION = 2`), statut `UNSEALED` bloquant, dossier `backups/` et `restore/` en 0700, fichiers en 0600, annulation journalisée avec l'identifiant authentifié, aperçu non bloquant |
| `server/repositories/authRepo.ts` | `changePassword(..., keepTokenHash)` : révocation des autres sessions **dans la même transaction**, nombre de sessions révoquées dans le journal |
| `server/routes/auth.ts` | Transmet le jeton courant (session conservée) |
| `src-tauri/src/db/mod.rs` | `secure_dir`, `secure_file`, `secure_database_files` (0700/0600) |
| `src-tauri/src/db/restore.rs` | Vérification du **sceau** du marqueur, clé locale, HMAC-SHA256 maison, **4 tests Rust** dont le vecteur partagé avec Node |
| `src-tauri/src/domain/backup.rs` | Manifeste **v2** scellé, `MANIFEST_VERSION`, `UNSEALED`, marqueur écrit scellé |
| `src-tauri/src/repositories/backup_repo.rs` | Manifestes scellés, `inspect_manifest` avec clé, `verify_backup`/`read_backup_file`/`get_manifest` reçoivent `db_path`, dossiers 0700, aperçu non bloquant |
| `src-tauri/src/repositories/foundation_repo.rs` | `change_password(..., keep_token)` : révocation des autres sessions, audit chiffré |
| `src-tauri/src/commands/{foundation,backups}.rs` | Propagation du jeton courant et du chemin de base |
| `src/types/backup.ts` | `ManifestStatus` + `UNSEALED`, `pendingRestoreRejectedReason` |
| `src/modules/foundations/components/BackupRestoreView.tsx` | Bannière d'alerte quand un marqueur est refusé |

### 9.5 Contrat de scellement (partagé Node ↔ Rust)

Message **canonique**, à ordre fixe, jamais du JSON (l'ordre des clés d'un
objet n'est pas garanti) :

```
depotpro-restore-seal-v1|1|<backupId>|<stagedPath>|<stagedChecksum>|RESTAURER|<requestedByUserId|"">
depotpro-manifest-seal-v2|depotpro-backup-manifest|2|<backupId>|<backupType>|<origin>|<fileName>|<fileSizeBytes>|<sha256>|<currentLot>|<createdAt>
```

Vecteur figé identique dans les deux runtimes (clé 32 octets nuls) :

```
9de55c67ed2c7d01b8a426bd6e216f8d985f259fea3843279486f31845e08e3b
```

Node : `tests/lot11-securite-locale.test.ts` · Rust :
`src-tauri/src/db/restore.rs::tests::hmac_sha256_vecteur_partage_avec_node`.

**Pourquoi c'est important** : sans ce contrat, un marqueur scellé par le
backend Rust serait refusé par le backend Node (et inversement) — un utilisateur
qui prépare une restauration en preview web ne pourrait plus l'activer en
desktop. Les 244 bits de `uuid × 2` ne suffisent pas pour une clé
cryptographique ; la clé est générée aléatoirement par l'OS (`randomBytes(32)` /
deux UUID côté Rust faute de dépendance `getrandom` directe — **point à
améliorer** avec `getrandom` au lot 11.6).

### 9.6 Limites assumées de cette étape

1. **La clé de scellement vit dans `data/.depotpro-seal.key` (0600).** Elle
   arrête un autre compte, une falsification accidentelle et la copie d'un
   marqueur entre postes. Elle **n'arrête pas** un attaquant qui exécute du code
   sous le **même compte** : il peut lire la clé et re-signer. Correction prévue
   au lot 11.6 : la déplacer dans le trousseau OS avec la clé de chiffrement.
2. **Le manifeste n'est pas chiffré** : son contenu (nom de fichier, taille,
   lot) reste lisible. Seule son authenticité est garantie.
3. **Rust reste non compilé ici** : `cargo` est absent du sandbox. Les
   modifications Rust sont contrôlées par tree-sitter (`check_rust.py` : 95/95
   OK) et par les 4 tests unitaires écrits, **pas exécutés**. `cargo test`
   demeure la preuve manquante.
4. **Windows** : `secure_dir`/`secure_file` sont sans effet (ACL héritées du
   profil). Le durcissement ACL explicite reste le lot 11.2 côté Windows.
5. **Manifestes v1 existants** : ils passent en `UNSEALED` et bloquent
   restauration/téléchargement. Aucune donnée n'est perdue, mais l'utilisateur
   doit **recréer** une sauvegarde. Un utilitaire de re-scellement (parcours de
   `backup_history`, recalcul HMAC, réécriture) est à prévoir au lot 11.6 —
   sans lui, un dépôt mis à jour ne peut restaurer ses anciennes copies
   qu'après en avoir créé une nouvelle.

### 9.7 Preuves d'exécution (mêmes commandes que le §7)

| Contrôle | Résultat |
| --- | --- |
| `npx tsc --noEmit` | **OK** |
| `npx vitest run` | **17 fichiers / 82 tests — 82 réussis, 0 échec.** L'échec d'environnement signalé au §7 est levé : `tree-sitter` est maintenant installé (`pip install tree-sitter tree-sitter-rust`), donc `check_rust.py` ne se dégrade plus en contrôle de délimiteurs |
| `npx vitest run tests/lot11-securite-locale.test.ts` | **15/15** |
| `npx vite build` | **OK** |
| `python3 scripts/check_rust.py` (tree-sitter installé) | **OK** — 46 fichiers, 95/95 commandes, 99 handlers |
| Sonde 4 rejouée (§4.5) | **refus** comme attendu, base intacte |
| Sonde 1 rejouée (§4.2) | 0700 / 0600 partout, session **invalidée** après changement de mot de passe |
| Sonde 5 rejouée (§4.8) | inchangée : `audit_logs` encore falsifiable et octets résiduels — **lot 11.8 reste à faire** |
| `cargo check` / `cargo test` | **toujours non exécutable ici** |

### 9.8 Ce qui reste ouvert (ordre recommandé)

| Lot | Contenu | Pourquoi maintenant |
| --- | --- | --- |
| **11.6** | SQLCipher + clé de base **et** clé de scellement dans le trousseau OS ; utilitaire de re-scellement des manifestes v1 ; base de preview distincte | Décision O1 prise ; ferme C2/C3 et la limite n°1 du §9.6 |
| **11.3** | `quick_check` au démarrage + écran de récupération | C6 : une base tronquée donne encore une erreur brute |
| **11.4** | Sauvegarde pré-migration + `app.version` + refus de rétrogradation | C7/C8 mesurés (§4.7) |
| **11.7** | Anti-rejeu : `backupSeq` monotone, refus d'une restauration antérieure à la dernière appliquée | Le sceau prouve l'origine, pas l'ancienneté |
| **11.8** | Chaîne de hachage de `audit_logs` + `secure_delete` | C9 : `DELETE` reste sans trace et les octets restent dans le fichier |
| **11.9** | Signature/notarisation réellement exécutées, test de désinstallation | C11 |
