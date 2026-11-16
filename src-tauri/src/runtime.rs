//! LOT 10 — Diagnostic du runtime desktop natif (aucun pont HTTP, aucun sidecar).

use crate::json::Json;
use serde_json::Value;

const LEDGER_JSON: &str = include_str!("../parity/commands.json");

/// État du moteur métier : 95/95 commandes Rust, transport Tauri IPC uniquement.
#[tauri::command]
pub fn get_desktop_runtime_status() -> Result<Json, String> {
    let ledger: Value = serde_json::from_str(LEDGER_JSON)
        .map_err(|err| format!("Registre de parité illisible : {err}"))?;
    Ok(serde_json::json!({
        "runtime": "TAURI_RUST_SQLX",
        "transport": "TAURI_IPC_ONLY",
        "sidecar": false,
        "loopbackHttp": false,
        "parity": {
            "total": ledger.get("total").and_then(Value::as_i64).unwrap_or(0),
            "implemented": ledger.get("implemented").and_then(Value::as_i64).unwrap_or(0),
            "complete": ledger.get("implemented").and_then(Value::as_i64)
                == ledger.get("total").and_then(Value::as_i64),
        },
        "architecture": ledger.get("architecture").and_then(Value::as_str).unwrap_or(""),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_registre_embarque_est_complet() {
        let status = get_desktop_runtime_status().unwrap();
        assert_eq!(status["parity"]["total"], 95);
        assert_eq!(status["parity"]["implemented"], 95);
        assert_eq!(status["parity"]["complete"], true);
        assert_eq!(status["transport"], "TAURI_IPC_ONLY");
    }
}
