-- DepotPro CI — Migration 0004: Améliorations Catalogue, Conditionnements et Emballages Consignés (LOT 2)

ALTER TABLE products ADD COLUMN preferred_supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN bottle_packaging_type_id TEXT REFERENCES packaging_types(id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN crate_packaging_type_id TEXT REFERENCES packaging_types(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_product_units_product ON product_units(product_id);
CREATE INDEX IF NOT EXISTS idx_product_units_barcode ON product_units(barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);

UPDATE system_meta
SET value = 'LOT_2',
    description = 'Lot courant : Catalogue produits, marques, catégories, emballages consignés et conversions par produit.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'app.lot_current';
