#!/usr/bin/env bash
# LOT 10 — Signature Developer ID + notarisation macOS (à exécuter SUR macOS).
# Aucun secret n'est stocké dans le dépôt : identifiants fournis par la CI.
#
# Prérequis :
#   - Xcode / Command Line Tools, compte Apple Developer Program
#   - DEPOTPRO_MAC_IDENTITY   : "Developer ID Application: NOM (TEAMID)"
#   - APPLE_ID                : identifiant Apple du compte
#   - APPLE_TEAM_ID           : Team ID (10 caractères)
#   - APPLE_APP_PASSWORD      : mot de passe spécifique à l'application
#
# Usage : bash scripts/notarize-macos.sh [chemin/vers/DepotPro CI.app]
#
# Étape 1 (build) : DEPOTPRO_MAC_IDENTITY="..." npm run tauri:build -- --bundles app,dmg
# Le .app signé est ensuite notarisé ci-dessous. Pour un DMG notarisé, reconstruire
# le DMG à partir du .app agrafé (stapled) avec Tauri ou hdiutil, puis le soumettre
# également à notarytool. Voir docs/LOT10_DISTRIBUTION.md §5.

set -euo pipefail

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERREUR : variable d'environnement manquante : $name" >&2
    exit 1
  fi
}

require DEPOTPRO_MAC_IDENTITY
require APPLE_ID
require APPLE_TEAM_ID
require APPLE_APP_PASSWORD

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/DepotPro CI.app}"
[[ -d "$APP" ]] || { echo "ERREUR : application introuvable : $APP" >&2; exit 1; }

echo "Signature Developer ID : $APP"
codesign --deep --force --options runtime --timestamp \
  --sign "$DEPOTPRO_MAC_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

ZIP="$(mktemp -d)/DepotPro-CI.zip"
echo "Soumission à notarytool : $ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "Agrafage du ticket de notarisation"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl -a -vvv --type execute "$APP"

echo "OK — application signée, notarisée et validée par Gatekeeper."
echo "Rappel : soumettre aussi le DMG final à notarytool puis l'agrafer."
