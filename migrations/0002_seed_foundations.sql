-- DepotPro CI — Migration 0002: Référentiel initial (Rôles, Permissions, Décisions d'architecture LOT 0)
-- Aucune donnée commerciale fictive n'est insérée ici.

INSERT OR IGNORE INTO roles (id, code, name, description, is_system) VALUES
  ('role-owner', 'OWNER', 'Propriétaire', 'Accès complet à l''ensemble du dépôt, sécurité, clôtures et sauvegardes.', 1),
  ('role-manager', 'MANAGER', 'Gérant', 'Gestion opérationnelle des ventes, achats, stocks, consignes et rapports.', 1),
  ('role-cashier', 'CASHIER', 'Caissier', 'Opérations de point de vente, encaissements et gestion de sa session de caisse.', 1),
  ('role-warehouse', 'WAREHOUSE', 'Magasinier', 'Réceptions fournisseurs, mouvements de stock, inventaires et consignes.', 1);

INSERT OR IGNORE INTO permissions (id, code, module, description) VALUES
  ('perm-auth-manage', 'auth.users.manage', 'AUTH', 'Créer et gérer les comptes utilisateurs et rôles'),
  ('perm-settings-manage', 'settings.depot.manage', 'SETTINGS', 'Configurer les paramètres généraux du dépôt'),
  ('perm-catalog-write', 'catalog.products.write', 'CATALOG', 'Créer et modifier produits, conditionnements et tarifs'),
  ('perm-stock-adjust', 'stock.adjust', 'STOCK', 'Réaliser des ajustements, inventaires et déclarations de casse'),
  ('perm-purchase-manage', 'purchase.manage', 'PURCHASES', 'Créer commandes fournisseurs et valider les réceptions'),
  ('perm-pos-sell', 'pos.sale.create', 'POS', 'Enregistrer des ventes au point de vente'),
  ('perm-pos-cancel', 'pos.sale.cancel', 'POS', 'Annuler une vente validée avec écritures compensatoires'),
  ('perm-pos-discount', 'pos.discount.apply', 'POS', 'Appliquer des remises autorisées au POS'),
  ('perm-consignment-manage', 'consignment.manage', 'CONSIGNMENT', 'Gérer consignes, retours et remboursements emballages'),
  ('perm-cash-session', 'cash.session.operate', 'CASH', 'Ouvrir et clôturer une session de caisse'),
  ('perm-cash-override', 'cash.session.override', 'CASH', 'Procédure administrative de réouverture ou correction de clôture'),
  ('perm-expense-write', 'expense.write', 'EXPENSES', 'Enregistrer des dépenses opérationnelles'),
  ('perm-reports-view', 'reports.view', 'REPORTS', 'Consulter et exporter les rapports financiers et de gestion'),
  ('perm-backup-manage', 'backup.manage', 'BACKUP', 'Exécuter des sauvegardes et restaurations SQLite');

-- Attribution des permissions par rôle
INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role-owner', id FROM permissions;

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role-manager', id FROM permissions
WHERE code NOT IN ('auth.users.manage', 'cash.session.override', 'backup.manage');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role-cashier', id FROM permissions
WHERE code IN ('pos.sale.create', 'consignment.manage', 'cash.session.operate');

INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
SELECT 'role-warehouse', id FROM permissions
WHERE code IN ('catalog.products.write', 'stock.adjust', 'purchase.manage', 'consignment.manage');

-- Unités de base standards (chaque conversion reste configurée par produit dans product_units)
INSERT OR IGNORE INTO units (id, code, name, is_base_unit) VALUES
  ('unit-bottle', 'BOUTEILLE', 'Bouteille', 1),
  ('unit-can', 'CANETTE', 'Canette', 1),
  ('unit-pack', 'PACK', 'Pack', 0),
  ('unit-crate', 'CASIER', 'Casier', 0),
  ('unit-carton', 'CARTON', 'Carton', 0);

-- Catégories de dépenses initiales
INSERT OR IGNORE INTO expense_categories (id, name, description) VALUES
  ('exp-transport', 'Transport & Livraison', 'Carburant, frais de course et livraison'),
  ('exp-utilities', 'Eau, Électricité & Télécom', 'Factures CIE, SODECI et internet'),
  ('exp-maintenance', 'Entretien & Manutention', 'Réparations, nettoyage et manutention'),
  ('exp-other', 'Autres charges opérationnelles', 'Frais divers du dépôt');

-- Caisse par défaut prête pour ouverture lors des lots ultérieurs
INSERT OR IGNORE INTO cash_registers (id, code, name, is_active) VALUES
  ('reg-main', 'CAISSE-01', 'Caisse Principale', 1);

-- Décisions d'architecture LOT 0 (Partie V du Master Prompt)
INSERT OR IGNORE INTO system_meta (key, value, category, description) VALUES
  ('adr.accounting_mode', 'SIMPLIFIED_COMMERCIAL', 'ARCHITECTURE', 'Comptabilité commerciale simplifiée orientée exploitation (pas un logiciel comptable OHADA certifié en V1).'),
  ('adr.licensing_strategy', 'OPTIONAL_LOCAL_OFFLINE', 'ARCHITECTURE', 'Activation de licence locale facultative, indépendante des données commerciales, sans jamais bloquer le mode hors ligne.'),
  ('adr.cloud_sync_readiness', 'PREPARED_NOT_ENABLED_V1', 'ARCHITECTURE', 'Identifiants UUID v4 stables, horodatages ISO UTC et colonnes sync_version prêts sur les tables métier ; aucune synchronisation cloud active en V1.'),
  ('app.currency', 'XOF', 'SYSTEM', 'Devise unique FCFA (XOF) manipulée exclusivement en entiers.'),
  ('app.lot_current', 'LOT_0', 'EXECUTION', 'Lot courant validé : Fondations techniques et base SQLite.');

-- État de licence local initial (distinct de business_settings)
INSERT OR IGNORE INTO license_state (
  id, edition, status, license_key_masked, installation_id, offline_allowed
) VALUES (
  'local-license', 'STANDARD_OFFLINE', 'TRIAL_OFFLINE', NULL, 'DEPOTPRO-CI-LOCAL-001', 1
);
