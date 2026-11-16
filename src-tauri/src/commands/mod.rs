//! LOT 10 — Seules les commandes du registre de parité sont compilées.
//!
//! Les fichiers `auth.rs`, `finance.rs`, `purchases.rs` et `system.rs` présents
//! dans ce dossier sont des SQUELETTES HISTORIQUES (21 commandes sur 95, dont
//! plusieurs non implémentées). Ils restent dans le dépôt à titre de référence
//! mais ne sont plus déclarés : les compiler exposerait des handlers factices.
//! Les tranches 1 à 4 du port les remplacent ; le registre est à 95/95.

pub mod foundation;
pub mod operations;
pub mod commercial;
pub mod backups;
