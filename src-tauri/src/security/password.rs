//! LOT 10 — Hachage des mots de passe : PARITÉ DE DONNÉES avec le backend Node.
//!
//! `server/security/password.ts` stocke `scrypt:<salt-hex-32>:<derived-hex-128>`
//! avec `crypto.scryptSync(password, salt, 64)`, paramètres Node par défaut
//! N = 16384 (log_n = 14), r = 8, p = 1. Le sel est la CHAÎNE hexadécimale de
//! 32 caractères (donc 32 octets ASCII), pas les 16 octets décodés.
//!
//! Le scaffold initial utilisait Argon2 : les comptes créés par l'un des
//! runtimes auraient été illisibles par l'autre sur la même base SQLite.
//! Ce module reproduit exactement le format Node, ce qui rend la base
//! interchangeable entre les deux moteurs pendant la durée du port.

use crate::error::AppError;
use scrypt::{scrypt, Params};

const KEY_LEN: usize = 64;
const LOG_N: u8 = 14; // 2^14 = 16384
const R: u32 = 8;
const P: u32 = 1;
const SALT_HEX_LEN: usize = 32;

fn derive(plain: &str, salt_hex: &str) -> Result<[u8; KEY_LEN], AppError> {
    let params = Params::new(LOG_N, R, P, KEY_LEN)
        .map_err(|e| AppError::Internal(format!("Paramètres scrypt invalides : {e}")))?;
    // Node reçoit le sel sous forme de chaîne : ce sont ses octets ASCII qui
    // sont utilisés, pas la valeur hexadécimale décodée.
    let mut output = [0_u8; KEY_LEN];
    scrypt(plain.as_bytes(), salt_hex.as_bytes(), &params, &mut output)
        .map_err(|e| AppError::Internal(format!("Dérivation scrypt impossible : {e}")))?;
    Ok(output)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

pub fn hash_password(plain: &str) -> Result<String, AppError> {
    // Uuid v4 « simple » = 16 octets aléatoires sous forme de 32 caractères hex.
    let salt_hex = uuid::Uuid::new_v4().simple().to_string();
    if salt_hex.len() != SALT_HEX_LEN {
        return Err(AppError::Internal("Génération du sel scrypt invalide".into()));
    }
    let derived = derive(plain, &salt_hex)?;
    Ok(format!("scrypt:{salt_hex}:{}", hex::encode(derived)))
}

pub fn verify_password(plain: &str, stored_hash: &str) -> bool {
    let parts: Vec<&str> = stored_hash.split(':').collect();
    if parts.len() != 3 || parts[0] != "scrypt" {
        return false;
    }
    let salt_hex = parts[1];
    let Ok(expected) = hex::decode(parts[2]) else {
        return false;
    };
    if expected.len() != KEY_LEN {
        return false;
    }
    match derive(plain, salt_hex) {
        Ok(actual) => constant_time_eq(&actual, &expected),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_compatible_node() {
        let hash = hash_password("Password2026!").unwrap();
        let parts: Vec<&str> = hash.split(':').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "scrypt");
        assert_eq!(parts[1].len(), 32);
        assert_eq!(parts[2].len(), 128);
        assert!(verify_password("Password2026!", &hash));
        assert!(!verify_password("mauvais", &hash));
    }

    #[test]
    fn refuse_un_hash_argon2() {
        assert!(!verify_password("x", "$argon2id$v=19$m=19456,t=2,p=1$abc$def"));
    }

    /// Vecteur de parité généré par `crypto.scryptSync` (Node) / OpenSSL avec
    /// un sel fixe : prouve qu'un compte créé par le backend Node est lisible
    /// par le moteur Rust sur la même base SQLite. Recalculé côté TypeScript
    /// par `tests/lot10-rust-tranche2.test.ts`.
    const NODE_VECTOR: &str = "scrypt:0123456789abcdef0123456789abcdef:070fe702f192199add932534aa8fa0f3121ea5148e9d37579b5b438f5e5f15291e063640e5f7a2b7eb2e4d422bdb8bf60cbc499decac385d5f139f1ae5af517b";

    #[test]
    fn compte_cree_par_node_est_lisible_par_rust() {
        assert!(verify_password("Password2026!", NODE_VECTOR));
        assert!(!verify_password("mauvais mot de passe", NODE_VECTOR));
    }
}
