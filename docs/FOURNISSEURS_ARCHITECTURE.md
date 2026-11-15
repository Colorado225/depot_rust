# Architecture des Fournisseurs dans DepotPro CI

## 1. Rôle métier dans un dépôt de boissons en Côte d'Ivoire
Un fournisseur (ex. Solibra, Brassivoire, distributeur agréé, importateur de vins/spiritueux) intervient à quatre niveaux distincts dans le système, sans jamais mélanger les flux :

1. **Référentiel Catalogue (`suppliers`, `products.preferred_supplier_id`, `product_suppliers`)** :
   - Chaque fournisseur possède un type (`BRASSERIE`, `DISTRIBUTEUR`, `IMPORTATEUR`, `AUTRE`), un identifiant fiscal/RCCM (`tax_id`), un délai de règlement (`payment_terms_days`) et des coordonnées.
   - Un produit peut être lié à un fournisseur principal (`preferred_supplier_id`) ainsi qu'à plusieurs fournisseurs secondaires via `product_suppliers` (avec référence article fournisseur et dernier coût négocié en entiers FCFA).

2. **Approvisionnement & Valorisation Stock (`purchase_orders` → `goods_receipts` → `stock_movements`)** :
   - **Règle critique** : la validation d'une commande fournisseur n'augmente jamais le stock.
   - Seule la réception physique validée (`goods_receipts`) déclenche les mouvements `PURCHASE_RECEIPT` dans `stock_movements`, met à jour `stock_balances` et recalcule le **Coût Moyen Pondéré (CUMP)** en entiers XOF.

3. **Dettes Commerciales & Trésorerie (`suppliers.balance_due_xof`, `payments`, `payment_allocations`)** :
   - Les réceptions à crédit ou partiellement payées augmentent la dette commerciale due au fournisseur (`balance_due_xof`).
   - Les règlements (`payments` avec `direction = 'OUTBOUND'`, `party_type = 'SUPPLIER'`) diminuent cette dette et impactent la session de caisse si payés en espèces (en restant strictement séparés des dépenses opérationnelles pour éviter tout double comptage).

4. **Emballages Consignés Fournisseurs (`consignment_balances`, `consignment_movements` avec `holder_type = 'SUPPLIER'`)** :
   - Les bouteilles et casiers vides reçus du fournisseur ou restitués au fournisseur sont suivis séparément de la dette commerciale et du stock de boissons pleines.
   - Les retours fournisseurs d'emballages vides ou de marchandises sont journalisés et réconciliables.
