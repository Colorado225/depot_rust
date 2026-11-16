#!/usr/bin/env python3
"""LOT 10 — Validation statique du port Rust, SANS cargo (indisponible ici).

Vérifie :
  1. la syntaxe de tous les fichiers .rs via tree-sitter-rust (parseur réel) ;
  2. la cohérence du registre de parité : chaque commande RUST possède un
     handler `#[tauri::command]` dans le fichier annoncé par son `handler`
     ET est enregistrée dans lib.rs ;
  3. l'absence de handlers factices (`todo!`, `unimplemented!`, squelettes) ;
  4. les invariants métier de la tranche 2 (stocks négatifs, CUMP, XOF entiers) ;
  5. l'absence de `sqlx::migrate!` et de requête sur `_sqlx_migrations` ;
  6. la présence du runner `schema_migrations` + SHA-256.

Si tree-sitter n'est pas installé (poste sans PyPI), le script le signale
clairement et se replie sur un contrôle de délimiteurs : il NE PRÉTEND PAS
remplacer `cargo check`. `npm run delivery:check` chaîne ce script.

Usage : python3 scripts/check_rust.py [--strict]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src-tauri" / "src"
COMMANDS_DIR = SRC / "commands"
LEDGER = ROOT / "src-tauri" / "parity" / "commands.json"
LIB = SRC / "lib.rs"
CONF = ROOT / "src-tauri" / "tauri.conf.json"
IPC = ROOT / "src" / "lib" / "ipc.ts"

errors: list[str] = []


def parse_with_tree_sitter(files: list[Path]) -> bool:
    try:
        import tree_sitter  # noqa: F401
        import tree_sitter_rust
        from tree_sitter import Language, Parser
    except ImportError:
        print("  ! tree-sitter-rust absent : contrôle syntaxique DÉGRADÉ (délimiteurs seulement).")
        print("    Installer : python3 -m pip install tree-sitter tree-sitter-rust")
        for path in files:
            text = path.read_text()
            for opening, closing in (("{", "}"), ("(", ")"), ("[", "]")):
                if text.count(opening) != text.count(closing):
                    errors.append(f"{path.relative_to(ROOT)} : délimiteurs {opening}{closing} déséquilibrés")
        return False

    language = Language(tree_sitter_rust.language())
    parser = Parser(language)
    for path in files:
        tree = parser.parse(path.read_bytes())
        if tree.root_node.has_error:
            stack = [tree.root_node]
            found = 0
            while stack and found < 5:
                node = stack.pop()
                if node.type in ("ERROR", "MISSING") or node.is_missing:
                    line = node.start_point[0] + 1
                    excerpt = node.text.decode("utf-8", "replace")[:70].replace("\n", " ")
                    errors.append(
                        f"{path.relative_to(ROOT)}:{line} : syntaxe Rust invalide ({node.type}: {excerpt!r})"
                    )
                    found += 1
                stack.extend(reversed(node.children))
    return True


LEGACY_COMMAND_FILES = {"auth.rs", "finance.rs", "purchases.rs", "system.rs"}
COMPILED_COMMAND_MODULES = {
    "foundation": "foundation.rs",
    "operations": "operations.rs",
    "commercial": "commercial.rs",
    "backups": "backups.rs",
}

# Commandes de service hors registre des 95 : transferts binaires + diagnostic.
SERVICE_COMMANDS = {
    "backup_get_manifest",
    "backup_download_file",
    "backup_import_file",
    "reports_export_file",
    "get_desktop_runtime_status",
}


def strip_comments(text: str) -> str:
    """Retire les commentaires Rust pour ne tester que du code compilé."""
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    return text


def is_compiled(path: Path) -> bool:
    # Squelettes historiques non déclarés dans commands/mod.rs.
    return not (path.parent.name == "commands" and path.name in LEGACY_COMMAND_FILES)


SQL_QUERY = re.compile(r'sqlx::query(?:_as)?\(\s*"([^"]*)"', re.S)
SQL_TERMINATOR = re.compile(r"\.execute\(|\.fetch_(?:all|one|optional)\(")


def check_bind_counts(compiled: list[Path]) -> None:
    """Vérifie #? == #.bind() pour chaque requête SQLx littérale.

    Ce n'est PAS un contrôle de types, mais il détecte les décalages de
    paramètres qui ne se verraient qu'à l'exécution de la commande Tauri.
    """
    for path in compiled:
        text = strip_comments(path.read_text())
        for match in SQL_QUERY.finditer(text):
            sql = match.group(1)
            placeholders = sql.count("?")
            terminator = SQL_TERMINATOR.search(text, match.end())
            segment_end = terminator.start() if terminator else len(text)
            binds = text[match.end():segment_end].count(".bind(")
            if placeholders != binds:
                line = text.count("\n", 0, match.start()) + 1
                errors.append(
                    f"{path.relative_to(ROOT)}:{line} : {placeholders} marqueur(s) ? "
                    f"pour {binds} .bind() (requête désynchronisée)"
                )


def command_functions(text: str) -> set[str]:
    """Extrait les noms des fonctions précédées de #[tauri::command]."""
    return set(
        re.findall(
            r"#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)",
            text,
        )
    )


def main() -> int:
    files = sorted(SRC.rglob("*.rs"))
    compiled = [p for p in files if is_compiled(p)]
    print(f"Contrôle statique Rust : {len(files)} fichiers ({len(compiled)} compilés)")
    full_syntax = parse_with_tree_sitter(files)

    ledger = json.loads(LEDGER.read_text())
    rust_commands = {c["command"] for c in ledger["commands"] if c["status"] == "RUST"}
    handler_by_module: dict[str, set[str]] = {}
    for module, filename in COMPILED_COMMAND_MODULES.items():
        path = COMMANDS_DIR / filename
        if not path.exists():
            errors.append(f"Module de commandes absent : {path.relative_to(ROOT)}")
            handler_by_module[module] = set()
            continue
        text = path.read_text()
        handler_by_module[module] = command_functions(text)
        code = strip_comments(text)
        for forbidden in ("todo!(", "unimplemented!(", "Signature prête"):
            if forbidden in code:
                errors.append(f"Handler factice interdit dans {filename} : {forbidden}")

    all_handlers: set[str] = set().union(*handler_by_module.values()) if handler_by_module else set()
    missing_handlers = sorted(rust_commands - all_handlers)
    extra_handlers = sorted(all_handlers - rust_commands - SERVICE_COMMANDS)
    if missing_handlers:
        errors.append(f"Commandes RUST sans handler : {missing_handlers}")
    if extra_handlers:
        errors.append(f"Handlers non déclarés RUST dans le registre : {extra_handlers}")

    # Le chemin `handler` du registre doit pointer vers le bon fichier compilé.
    for entry in ledger["commands"]:
        if entry["status"] != "RUST":
            continue
        handler = entry.get("handler") or ""
        match = re.fullmatch(r"commands::([a-z_]+)::([a-z_][a-z0-9_]*)", handler)
        if not match:
            errors.append(f"Chemin de handler invalide pour {entry['command']} : {handler}")
            continue
        module, function = match.groups()
        if function != entry["command"]:
            errors.append(f"Handler {handler} ne correspond pas à {entry['command']}")
        if module not in handler_by_module:
            errors.append(f"Module de handler inconnu pour {entry['command']} : {module}")
        elif function not in handler_by_module[module]:
            errors.append(f"Handler introuvable dans {COMPILED_COMMAND_MODULES[module]} : {function}")

    lib = LIB.read_text()
    handler_block = re.search(r"generate_handler!\[(.*?)\]", lib, re.S)
    registered_list = (
        re.findall(r"\b([a-z_][a-z0-9_]*)\s*,", handler_block.group(1)) if handler_block else []
    )
    registered = set(registered_list)
    missing_registered = sorted((rust_commands | SERVICE_COMMANDS) - registered)
    if missing_registered:
        errors.append(f"Commandes RUST non enregistrées dans lib.rs : {missing_registered}")
    duplicates = sorted({name for name in registered_list if registered_list.count(name) > 1})
    if duplicates:
        errors.append(f"Handlers enregistrés en double dans generate_handler! : {duplicates}")
    extra_registered = sorted(registered - rust_commands - SERVICE_COMMANDS)
    if extra_registered:
        errors.append(f"Handlers enregistrés hors registre et hors services : {extra_registered}")

    # Les 21 squelettes historiques ne doivent jamais être déclarés : ils
    # contiennent des stubs et un `sqlx::migrate!` qui créerait _sqlx_migrations.
    mods = (SRC / "commands" / "mod.rs").read_text()
    declared = set(re.findall(r"pub\s+mod\s+([a-z_]+)\s*;", mods))
    legacy_declared = sorted(declared - set(COMPILED_COMMAND_MODULES))
    if legacy_declared:
        errors.append(f"Squelettes legacy encore déclarés dans commands/mod.rs : {legacy_declared}")
    if any(c["status"] != "RUST" for c in ledger["commands"]):
        errors.append("Registre de parité incomplet : statut autre que RUST encore présent")
    if any(c.get("fallback") for c in ledger["commands"]):
        errors.append("Registre de parité : repli HTTP transitoire encore déclaré")
    if ledger.get("implemented") != ledger.get("total"):
        errors.append("Registre de parité : implemented != total")

    check_bind_counts(compiled)
    all_rust = "\n".join(strip_comments(p.read_text()) for p in compiled)
    if "sqlx::migrate!(" in all_rust:
        errors.append("sqlx::migrate! interdit (double propriétaire du schéma)")
    if re.search(r"FROM\s+_sqlx_migrations", all_rust, re.I):
        errors.append("Requête sur _sqlx_migrations interdite")
    if "schema_migrations" not in (SRC / "db" / "mod.rs").read_text():
        errors.append("Runner schema_migrations absent de db/mod.rs")
    if "Sha256" not in (SRC / "db" / "mod.rs").read_text():
        errors.append("Checksum SHA-256 absente du runner de migrations")
    if "apply_pending_restore" not in (SRC / "db" / "mod.rs").read_text():
        errors.append("Restauration différée LOT 9 non appliquée avant l'ouverture du pool")

    # Invariants métier de la tranche 2 (contrôle de présence, pas d'exécution).
    stock_repo = (SRC / "repositories" / "stock_repo.rs").read_text()
    purchase_repo = (SRC / "repositories" / "purchase_repo.rs").read_text()
    cump = (SRC / "domain" / "cump.rs").read_text()
    invariants = [
        (stock_repo, "allow_negative_stock", "Interdiction des stocks négatifs absente"),
        (stock_repo, "insufficient_stock(", "Erreur INSUFFICIENT_STOCK absente"),
        (purchase_repo, "compute_weighted_avg_cost_xof", "CUMP absent des réceptions"),
        (purchase_repo, "recompute_supplier_balance_due", "Dette fournisseur non recomputée"),
        (purchase_repo, "payment_allocations", "Allocation FIFO des règlements absente"),
        (cump, "i128", "Calcul CUMP sans arithmétique entière étendue"),
    ]
    for source, token, message in invariants:
        if token not in source:
            errors.append(message)

    # Tranche 4 : le pont HTTP est retiré, les sauvegardes sont en Rust.
    if (SRC / "bridge.rs").exists():
        errors.append("bridge.rs (sidecar Node) encore présent")
    conf = json.loads(CONF.read_text())
    if conf.get("bundle", {}).get("externalBin"):
        errors.append("externalBin sidecar encore déclaré dans tauri.conf.json")
    if "127.0.0.1" in conf.get("app", {}).get("security", {}).get("csp", ""):
        errors.append("CSP desktop avec origine loopback HTTP")
    if "backend:build" in conf.get("build", {}).get("beforeBuildCommand", ""):
        errors.append("beforeBuildCommand embarque encore le bundle Node")
    ipc = IPC.read_text()
    if "get_backend_origin" in ipc or "get_backend_status" in ipc:
        errors.append("Client Tauri encore branché sur le pont HTTP")
    runtime = (SRC / "runtime.rs").read_text()
    if "TAURI_IPC_ONLY" not in runtime:
        errors.append("Diagnostic runtime TAURI_IPC_ONLY absent")
    backup_repo = (SRC / "repositories" / "backup_repo.rs").read_text()
    for token, message in (
        ("VACUUM INTO", "VACUUM INTO absent du dépôt de sauvegarde Rust"),
        ("RESTORE_CONFIRMATION", "Confirmation RESTAURER absente"),
        ("PRE_RESTORE", "Copie pré-restore absente"),
        ("apply_migrations", "Migrations sur base séparée absentes"),
        ("backup_history", "Historique des sauvegardes absent"),
    ):
        if token not in backup_repo:
            errors.append(message)
    # LOT 11 — la restauration doit être AUTHENTIFIÉE : un marqueur non scellé
    # doit être refusé (constat C1 du rapport de sécurité, mesuré).
    domain_backup = (SRC / "domain" / "backup.rs").read_text()
    restore = (SRC / "db" / "restore.rs").read_text()
    for token, message in (
        ("RESTORE_SEAL_CONTEXT", "Contexte de sceau du marqueur de restauration absent"),
        ("hmac_sha256", "HMAC-SHA256 du marqueur absent (restauration non authentifiée)"),
        ("load_or_create_seal_key", "Clé de scellement locale absente"),
        ("MANIFEST_VERSION", "Version de manifeste scellé absente"),
        ("verify_manifest_seal", "Vérification du sceau de manifeste absente"),
    ):
        source = domain_backup if token in ("MANIFEST_VERSION", "verify_manifest_seal", "RESTORE_SEAL_CONTEXT") else restore
        if token not in source:
            errors.append(message)
    if "verify_restore_seal" not in restore:
        errors.append("Le marqueur de restauration n'est pas vérifié avant activation (C1)")
    if "keep_token" not in (SRC / "repositories" / "foundation_repo.rs").read_text():
        errors.append("Révocation des sessions au changement de mot de passe absente (C5)")
    if "secure_dir" not in (SRC / "db" / "mod.rs").read_text():
        errors.append("Permissions 0700/0600 absentes du module de base (C4)")
    pdf = (SRC / "domain" / "pdf_export.rs").read_text()
    if "%PDF-1.4" not in pdf:
        errors.append("Générateur PDF Rust autonome absent")

    # LOT 11.6 — les clés ne doivent pas rester dans un fichier quand un
    # trousseau répond : le module Rust doit passer par le trousseau et
    # conserver le repli 0600 seulement comme secours.
    keys_rs = (SRC / "db" / "keys.rs").read_text()
    for token, message in (
        ("KEYRING_SERVICE", "Nom de service du trousseau absent (clés non portables)"),
        ("keyring_account", "Comptes du trousseau absents (clés non retrouvables)"),
        ("KeyBackend", "Le repli fichier n'est pas distingué du trousseau (pas de diagnostic)"),
        ("load_or_create_key", "Chargement unifié des clés absent"),
    ):
        if token not in keys_rs:
            errors.append(message)
    if "keyring" not in (ROOT / "src-tauri" / "Cargo.toml").read_text():
        errors.append("Dépendance Cargo absente : keyring (LOT 11.6)")
    # La clé de scellement doit passer par le module de clés, pas écrire le
    # fichier elle-même : sinon la migration vers le trousseau serait ignorée.
    if "crate::db::keys::load_or_create_key" not in restore:
        errors.append("La clé de scellement contourne le module de clés (repli non migré)")
    # Le chiffrement de la base n'est pas encore porté côté Rust : le module
    # DOIT le dire explicitement plutôt que de laisser croire à une couverture.
    if "SQLCipher" not in keys_rs:
        errors.append("Limite du chiffrement Rust non documentée dans db/keys.rs")

    cargo = (ROOT / "src-tauri" / "Cargo.toml").read_text()
    for dep in ("sqlx", "scrypt", "sha2", "serde_json", "tauri"):
        if dep not in cargo:
            errors.append(f"Dépendance Cargo absente : {dep}")
    # Les chaînes de test `$argon2id$...` sont volontaires (scrypt doit les
    # refuser) ; seul un usage effectif de la crate est interdit.
    for forbidden, message in (
        ("argon2", "argon2 incompatible avec les mots de passe scrypt du backend Node"),
        ("rusqlite", "rusqlite interdit : SQLx est le seul accès SQLite"),
    ):
        if re.search(rf"(?m)^\s*{forbidden}\s*=", cargo):
            errors.append(message)
        if re.search(rf"(?:use\s+{forbidden}\b|{forbidden}::|extern crate {forbidden}\b)", all_rust):
            errors.append(f"{message} (présent dans le code Rust compilé)")

    print(
        f"  Registre : {len(rust_commands)}/{ledger['total']} commandes en Rust ; "
        f"{len(all_handlers)} handlers ; {len(registered)} enregistrées"
    )
    print(f"  Syntaxe : {'tree-sitter (complète)' if full_syntax else 'DÉGRADÉE'}")

    if errors:
        for error in errors:
            print(f"  ✗ {error}", file=sys.stderr)
        print(f"\nÉCHEC : {len(errors)} anomalie(s).", file=sys.stderr)
        return 1

    print("  ✓ Syntaxe et cohérence du port : OK")
    print("  Limite : ceci n'est PAS un cargo check (types SQLx non vérifiés ici).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
