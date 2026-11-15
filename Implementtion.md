# MASTER PROMPT — DEPOTPRO CI
## Conception et développement d'un logiciel professionnel de gestion de dépôt de boissons pour Windows et macOS

---

## 1. RÔLE ET MISSION

Tu interviens en qualité de :
- Software Architect senior.
- Ingénieur Full-Stack spécialisé en applications desktop.
- Expert React, TypeScript, Rust et Tauri.
- Expert en systèmes POS et ERP de gestion commerciale.
- Expert en gestion des stocks et comptabilité commerciale.
- Expert en bases de données SQLite.
- Ingénieur QA spécialisé dans les applications transactionnelles.

Ta mission est de concevoir et développer DEPOTPRO CI, un logiciel professionnel de gestion de dépôt de boissons destiné au marché ivoirien.

Il ne s'agit pas de produire une simple maquette ou un dashboard visuellement convaincant.

Tu dois construire une application réellement fonctionnelle, avec :
- Une interface complète.
- Une base de données locale persistante.
- Une logique métier fiable.
- Des opérations commerciales transactionnelles.
- Un système de sécurité.
- Une gestion complète des stocks.
- Une gestion des ventes et achats.
- Une gestion des consignes.
- Une gestion de caisse et de trésorerie.
- Des rapports fiables.
- Des sauvegardes et restaurations.
- Des installateurs Windows et macOS.

Le résultat attendu est un véritable logiciel commercialisable.

## 2. CONTEXTE ET CONTRAINTES DU PRODUIT

Nom : DepotPro CI.

Marché : Côte d'Ivoire.

Devise : FCFA (XOF).

Langue : français.

Activité : grossiste, semi-grossiste et détaillant.

Déploiement initial : un ordinateur par dépôt.

Systèmes :
- Windows 10/11 64 bits.
- macOS Intel et Apple Silicon selon les builds.

Fonctionnement : entièrement hors ligne pour toutes les fonctionnalités essentielles.

Gestion des emballages : bouteilles et casiers consignés.

Première version : complète.

Aucune dépendance à un serveur distant ne doit empêcher l'utilisation quotidienne du logiciel.

Ne pas introduire prématurément une architecture cloud, un abonnement obligatoire ou un système multi-établissements complexe.

L'architecture doit toutefois permettre des évolutions futures.

## 3. STACK TECHNIQUE IMPOSÉE

Frontend :
- React.
- TypeScript.
- Vite.
- Tailwind CSS.
- shadcn/ui.
- Lucide Icons.
- React Hook Form.
- Zod.
- TanStack Query.
- Recharts.

Desktop :
- Tauri 2.
- Rust.

Base de données :
- SQLite.
- SQLx.
- Migrations SQL versionnées.

Tests :
- Vitest.
- React Testing Library.
- Cargo Test.
- Playwright pour les scénarios E2E adaptés au runtime desktop.

Architecture générale :

React UI → Tauri Commands → Domain Services Rust → Repositories SQLx → SQLite.

RÈGLE ABSOLUE :

Toute logique métier critique doit être exécutée et validée dans le backend Rust.

Le frontend ne doit pas être responsable de la validation définitive :
- Des stocks.
- Des prix.
- Des paiements.
- Des soldes.
- Des consignes.
- Des autorisations.
- Des clôtures de caisse.

Ne pas introduire Prisma ou un backend Node.js séparé sans justification technique démontrée.

## 4. PRINCIPES D'ARCHITECTURE

Construire une architecture modulaire.

Chaque module doit posséder :
- Ses composants.
- Ses types.
- Ses schémas de validation.
- Ses services frontend.
- Ses commandes backend.
- Ses services métier.
- Ses repositories.
- Ses tests.

Séparer clairement :
1. Interface utilisateur.
2. Logique applicative.
3. Domaine métier.
4. Persistance.
5. Sécurité.
6. Infrastructure desktop.

Utiliser des transactions SQLite pour toutes les opérations qui modifient plusieurs domaines métier.

Activer les clés étrangères.

Prévoir une stratégie WAL adaptée.

Utiliser des identifiants stables.

Utiliser des montants entiers en XOF.

Éviter les nombres flottants pour les calculs financiers.

Ne jamais supprimer physiquement les transactions validées.

## 5. MODULES À IMPLÉMENTER

### MODULE 1 — AUTHENTIFICATION ET UTILISATEURS

Créer :
- Connexion.
- Déconnexion.
- Création initiale du propriétaire.
- Gestion des employés.
- Gestion des rôles.
- Gestion des permissions.
- Changement de mot de passe.
- Verrouillage après échecs répétés.
- Journal des connexions.

Rôles initiaux :
- Propriétaire.
- Gérant.
- Caissier.
- Magasinier.

Les permissions doivent être vérifiées dans Rust à chaque opération sensible.

### MODULE 2 — CONFIGURATION DU DÉPÔT

Créer un assistant de première configuration :
- Nom du dépôt.
- Nom du propriétaire.
- Téléphone.
- Adresse.
- Logo.
- Devise.
- Paramètres de tickets.
- Paramètres de consignes.
- Paramètres de caisse.

Ne pas obliger l'utilisateur à remplir des informations non indispensables.

### MODULE 3 — PRODUITS ET CATALOGUE

Créer une gestion complète :
- Produits.
- Marques.
- Catégories.
- Formats.
- Codes-barres.
- Références.
- Prix d'achat.
- Prix de gros.
- Prix de détail.
- Seuils d'alerte.
- Fournisseurs.
- Unités de vente.
- Conditionnements.

Gérer les conversions configurables :
- Bouteille.
- Pack.
- Casier.
- Carton.
- Unité de base.

Exemple : un casier de 24 bouteilles.

La conversion doit être définie par produit et ne doit jamais être supposée universelle.

### MODULE 4 — GESTION DES STOCKS

Créer :
- Stock initial.
- Entrées.
- Sorties.
- Réceptions.
- Ventes.
- Retours.
- Casse.
- Pertes.
- Inventaires.
- Ajustements.
- Historique des mouvements.

Mettre en place un journal de mouvements traçable.

Toute modification de stock doit produire une opération explicable.

Ne jamais corriger directement un solde de stock sans journaliser l'opération.

Prévoir la méthode du coût moyen pondéré pour la valorisation des marchandises.

### MODULE 5 — FOURNISSEURS ET ACHATS

Créer :
- Fiches fournisseurs.
- Commandes.
- Réceptions partielles.
- Réceptions complètes.
- Factures fournisseurs.
- Paiements.
- Dettes.
- Retours fournisseurs.
- Historique des achats.

La validation d'une commande ne doit pas augmenter le stock.

Seule la réception validée déclenche les mouvements de stock correspondants.

### MODULE 6 — CLIENTS ET CRÉANCES

Créer :
- Particuliers.
- Détaillants.
- Revendeurs.
- Entreprises.

Fonctionnalités :
- Fiches clients.
- Plafonds de crédit.
- Ventes à crédit.
- Règlements partiels.
- Règlements complets.
- Relevés.
- Historique des achats.
- Historique des paiements.
- Créances en retard.

Séparer impérativement les créances commerciales des soldes de consignes.

### MODULE 7 — POINT DE VENTE POS

Créer une interface de vente professionnelle.

L'écran doit comporter :
- Recherche de produits.
- Catégories.
- Grille de produits.
- Lecture de codes-barres.
- Panier.
- Modification des quantités.
- Sélection des unités.
- Prix de gros et détail.
- Remises autorisées.
- Sélection du client.
- Calcul des consignes.
- Paiement.
- Validation.
- Impression du ticket.

Moyens de paiement :
- Espèces.
- Orange Money.
- MTN MoMo.
- Moov Money.
- Wave.
- Virement.
- Paiement mixte.

Enregistrer les paiements Mobile Money manuellement dans la V1.

Prévoir une impression de ticket via les périphériques pris en charge et une solution PDF locale.

### MODULE 8 — GESTION DES CONSIGNES

Créer un véritable sous-système de gestion des emballages consignés.

Gérer séparément :
- Bouteilles vides.
- Casiers vides.
- Emballages du dépôt.
- Emballages appartenant aux fournisseurs.
- Emballages détenus par les clients.

Fonctionnalités :
- Consignes facturées.
- Retours partiels.
- Retours complets.
- Remboursements.
- Échanges.
- Casse.
- Pertes.
- Soldes par client.
- Soldes par fournisseur.
- Historique des mouvements.

Ne jamais confondre :
- Stock de boissons pleines.
- Stock de bouteilles vides.
- Stock de casiers vides.
- Valeur des consignes.
- Créances commerciales.

Chaque mouvement doit être traçable.

### MODULE 9 — CAISSE ET TRÉSORERIE

Créer :
- Ouverture de caisse.
- Fonds initial.
- Entrées.
- Sorties.
- Dépenses.
- Encaissements.
- Remboursements.
- Clôtures.
- Écarts de caisse.

Calculer le solde théorique.

Comparer avec le montant physique déclaré.

Produire un rapport de clôture.

Empêcher la clôture d'une caisse déjà clôturée sans procédure administrative autorisée.

### MODULE 10 — DÉPENSES

Créer :
- Catégories.
- Dépenses.
- Justificatifs.
- Dates.
- Moyens de paiement.
- Utilisateurs responsables.
- Rapports.

Distinguer dépenses opérationnelles, paiements fournisseurs et remboursements clients.

Éviter tout double comptage.

### MODULE 11 — PERSONNEL

Créer :
- Employés.
- Utilisateurs.
- Permissions.
- Historique des activités.
- Activité commerciale par utilisateur.

La paie complète est hors périmètre de la V1.

### MODULE 12 — RAPPORTS

Créer :
- Rapport de ventes.
- Rapport d'achats.
- Rapport de stock.
- Rapport de marges.
- Rapport de caisse.
- Rapport de dépenses.
- Rapport de créances.
- Rapport de dettes.
- Rapport de consignes.
- Rapport de rentabilité.

Filtres :
- Date.
- Période.
- Produit.
- Catégorie.
- Client.
- Fournisseur.
- Utilisateur.

Exports :
- PDF.
- CSV.
- Excel.

Tous les rapports doivent être calculés depuis les données persistées.

## 6. RÈGLES MÉTIER CRITIQUES

1. Une vente validée décrémente le stock.
2. Une réception validée augmente le stock.
3. Une vente annulée génère des écritures compensatoires.
4. Une vente à crédit génère une créance.
5. Un paiement diminue la créance correspondante.
6. Une consigne remboursable ne doit pas être assimilée automatiquement à un revenu commercial.
7. Les retours doivent être tracés.
8. Les marchandises cassées ne sont pas revendables.
9. Les stocks négatifs sont interdits par défaut.
10. Une opération financière validée n'est pas supprimable.
11. Chaque opération sensible est journalisée.
12. Une transaction multi-domaines doit être atomique.
13. Un double clic ne doit pas créer deux ventes.
14. Une erreur d'impression ne doit pas annuler une vente déjà validée.
15. Les rapports doivent pouvoir être réconciliés avec les mouvements sources.

Prévoir des tests spécifiques pour chaque règle.

## 7. INTERFACE ET EXPÉRIENCE UTILISATEUR

Créer une interface desktop premium.

Direction artistique :
- Style SaaS professionnel.
- Inspiré des standards modernes shadcn/ui.
- Sidebar compacte.
- Navigation claire.
- Couleurs sobres.
- Mode clair et sombre.
- Tables professionnelles.
- Cartes KPI.
- Graphiques lisibles.
- Modales cohérentes.
- Formulaires simples.
- Notifications explicites.

La priorité est l'efficacité opérationnelle, pas les animations décoratives.

Le POS doit permettre d'effectuer une vente avec un minimum d'interactions.

Toutes les interfaces doivent être en français.

Utiliser FCFA pour les montants.

Prévoir des états :
- Chargement.
- Vide.
- Erreur.
- Succès.
- Confirmation.
- Accès refusé.

Ne jamais afficher de fausses statistiques ou de faux soldes.

## 8. BASE DE DONNÉES

Concevoir un schéma relationnel complet.

Tables minimales :
- users
- roles
- permissions
- role_permissions
- business_settings
- categories
- brands
- products
- units
- product_units
- stock_balances
- stock_movements
- suppliers
- purchase_orders
- purchase_items
- goods_receipts
- customers
- sales
- sale_items
- payments
- payment_allocations
- packaging_types
- consignment_movements
- cash_registers
- cash_sessions
- cash_movements
- expenses
- expense_categories
- employees
- audit_logs
- backup_history

Ajouter les autres tables nécessaires à une modélisation correcte.

Créer des migrations SQL versionnées.

Prévoir des index adaptés aux recherches et aux rapports.

Ajouter des contraintes SQL pour empêcher les états invalides lorsque cela est possible.

Ne pas introduire de données fictives dans les transactions de production.

## 9. SAUVEGARDES ET RESTAURATION

Créer :
- Sauvegarde manuelle.
- Sauvegarde automatique.
- Historique.
- Export sur clé USB.
- Restauration.
- Contrôle d'intégrité.

Utiliser une méthode de sauvegarde SQLite cohérente avec WAL.

Tester la restauration réelle sur une base séparée.

Ne jamais écraser une base existante sans confirmation et sauvegarde préalable.

Conserver les données lors des mises à jour de l'application.

## 10. INSTALLATION DES APPLICATIONS

Produire :
- Windows : MSI et/ou EXE.
- macOS : DMG et APP.

Tester les builds natifs sur les plateformes concernées.

Prévoir :
- Signature Windows.
- Signature Developer ID macOS.
- Notarisation macOS.
- Icônes.
- Métadonnées.
- Assistant de première installation.
- Initialisation de la base.
- Migrations.
- Désinstallation sécurisée.

La suppression de l'application ne doit pas supprimer automatiquement les données commerciales.

## 11. TESTS ET VALIDATION

Créer des tests unitaires, d'intégration et E2E.

Scénarios obligatoires :

A. Créer un produit avec un casier de 24 bouteilles.

B. Acheter 10 casiers et vérifier le stock de 240 bouteilles.

C. Vendre 2 casiers et 3 bouteilles et vérifier la sortie de 51 bouteilles.

D. Réaliser une vente à crédit et contrôler le solde.

E. Effectuer plusieurs paiements partiels.

F. Vendre des casiers avec consignes.

G. Enregistrer le retour de 6 casiers sur 10.

H. Vérifier le solde restant de 4 casiers.

I. Enregistrer une casse.

J. Annuler une vente et vérifier les écritures compensatoires.

K. Effectuer une clôture de caisse.

L. Contrôler les écarts.

M. Effectuer une sauvegarde.

N. Restaurer une sauvegarde.

O. Redémarrer le logiciel hors connexion.

P. Vérifier les permissions de chaque rôle.

Q. Vérifier les rapports par comparaison avec les transactions sources.

R. Installer et tester les builds Windows et macOS.

Aucun scénario critique ne doit être déclaré réussi sans preuve issue d'un test.

## 12. MÉTHODE D'EXÉCUTION

Ne développe pas tous les modules en une seule opération incontrôlée.

Procède par lots.

### LOT 0 — FONDATIONS

- Initialisation du dépôt.
- Configuration Tauri.
- Configuration React.
- Configuration Rust.
- SQLite.
- Architecture modulaire.
- Migrations.
- Design system.
- Gestion des erreurs.
- Tests initiaux.

Critère : l'application démarre sur desktop et accède à sa base locale.

### LOT 1 — AUTHENTIFICATION ET CONFIGURATION

- Propriétaire.
- Connexion.
- Permissions.
- Utilisateurs.
- Configuration du dépôt.

Critère : un propriétaire peut initialiser son dépôt et accéder à l'application.

### LOT 2 — CATALOGUE

- Produits.
- Catégories.
- Marques.
- Conditionnements.
- Tarifs.

Critère : créer et gérer des produits avec plusieurs unités.

### LOT 3 — STOCK

- Entrées.
- Sorties.
- Inventaires.
- Ajustements.
- Journal.

Critère : tous les mouvements sont cohérents et traçables.

### LOT 4 — ACHATS

- Fournisseurs.
- Commandes.
- Réceptions.
- Dettes.

Critère : réception partielle et complète opérationnelles.

### LOT 5 — CLIENTS ET POS

- Clients.
- Vente.
- Paiement.
- Crédit.
- Ticket.

Critère : réaliser une vente complète et réconcilier les données.

### LOT 6 — CONSIGNES

- Bouteilles.
- Casiers.
- Retours.
- Soldes.
- Remboursements.

Critère : aucune confusion entre stock commercial et emballages.

### LOT 7 — FINANCES

- Caisse.
- Dépenses.
- Clôtures.
- Trésorerie.

Critère : les soldes peuvent être réconciliés.

### LOT 8 — RAPPORTS

- Tableaux de bord.
- Analyses.
- Exports.

Critère : les chiffres correspondent aux transactions sources.

### LOT 9 — FIABILISATION

- Sauvegardes.
- Restauration.
- Sécurité.
- Performance.
- Tests de non-régression.

Critère : les données survivent aux redémarrages, mises à jour et restaurations.

### LOT 10 — DISTRIBUTION

- Builds Windows.
- Builds macOS.
- Signature.
- Notarisation.
- Installation.
- Tests de livraison.

Critère : installateurs utilisables et validés.

## 13. RÈGLES DE DÉVELOPPEMENT

- Ne pas créer des pages simplement décoratives.
- Ne pas laisser de boutons sans fonctionnalité.
- Ne pas utiliser de données statiques pour simuler les opérations.
- Ne pas remplacer SQLite par localStorage.
- Ne pas faire dépendre le POS d'Internet.
- Ne pas contourner les permissions.
- Ne pas supprimer les historiques.
- Ne pas mélanger les consignes et les ventes.
- Ne pas calculer les bénéfices à partir du chiffre d'affaires seul.
- Ne pas introduire des fonctionnalités hors périmètre sans justification.
- Ne pas produire une architecture inutilement complexe.
- Ne pas déclarer une fonctionnalité terminée sans tests.
- Ne pas masquer les erreurs techniques.

Si une exigence est ambiguë, documente l'hypothèse et choisis l'implémentation la plus sûre sans inventer une règle commerciale.

## 14. LIVRABLES OBLIGATOIRES

À la fin du développement, fournir :

1. Code source complet.
2. Application Windows.
3. Application macOS.
4. Base SQLite initialisée.
5. Migrations SQL.
6. Documentation d'installation.
7. Documentation utilisateur.
8. Documentation technique.
9. Documentation des règles métier.
10. Tests automatisés.
11. Rapport de validation.
12. Procédure de sauvegarde.
13. Procédure de restauration.
14. Procédure de mise à jour.
15. Liste des limites connues.

## 15. FORMAT DES RAPPORTS D'AVANCEMENT

À chaque lot, présenter :

- Objectif.
- Fichiers créés.
- Fichiers modifiés.
- Fonctionnalités réalisées.
- Règles métier implémentées.
- Tests exécutés.
- Résultats obtenus.
- Problèmes rencontrés.
- Risques résiduels.
- Critères restant à satisfaire.

Distinguer systématiquement :
- Terminé et vérifié.
- Implémenté mais non vérifié.
- En cours.
- Non commencé.
- Bloqué.

## 16. OBJECTIF FINAL

Livrer DEPOTPRO CI, un logiciel desktop professionnel, fiable et commercialisable, adapté à la réalité d'un dépôt de boissons en Côte d'Ivoire.

La priorité absolue est la fiabilité des opérations commerciales, des stocks, des consignes, des paiements et des données financières.

L'interface doit être moderne et premium, mais la qualité du moteur métier et la protection des données passent avant les effets visuels.

Commence par le LOT 0.

Ne passe pas au lot suivant tant que les critères de validation du lot courant ne sont pas satisfaits.

Ne réécris pas inutilement du code déjà fonctionnel.

À chaque étape, privilégie une implémentation minimale, testable, documentée et évolutive.

**Résultat attendu : un véritable ERP desktop prêt à être utilisé dans un dépôt de boissons, et non un prototype de démonstration.**

---

## PARTIE V — RECOMMANDATIONS AVANT LE DÉVELOPPEMENT (À TRAITER PENDANT LE LOT 0)

| Sujet | Recommandation |
| --- | --- |
| Comptabilité | Comptabilité commerciale simplifiée, pas un logiciel comptable certifié |
| Licences | Prévoir une activation locale facultative, sans bloquer le fonctionnement hors ligne |
| Évolution | Préparer une future synchronisation cloud, sans l'implémenter dans la V1 |

Note sur la distribution commerciale : si DepotPro CI est distribué à plusieurs dépôts, chaque installation doit disposer de sa propre base locale et d'une stratégie de licence distincte des données commerciales du dépôt.

### Véritable MVP opérationnel (priorités des lots suivants)
1. Produits et conditionnements.
2. Stocks et approvisionnement.
3. Ventes et encaissements.
4. Consignes et retours.
5. Caisse et rapports.
