-- Migration: Move form EDN files into shared.forms table
-- All forms belong to the 'calculator' database
-- Run with: psql -h localhost -U postgres -d polyaccess -f migrate_forms_to_db.sql

-- Ensure shared schema and tables exist
CREATE SCHEMA IF NOT EXISTS shared;

CREATE TABLE IF NOT EXISTS shared.forms (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    definition TEXT NOT NULL,
    record_source VARCHAR(255),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(database_id, name)
);

-- Insert forms (using ON CONFLICT to allow re-running)

INSERT INTO shared.forms (database_id, name, definition, record_source, description)
VALUES (
    'calculator',
    'recipe_calculator',
    '{:id 1
 :name "Recipe Calculator"
 :type "form"
 :record-source "ingredient"
 :default-view "single"
 :header {:height 40
          :controls [{:type :label
                      :text "Recipe Calculator"
                      :x 8
                      :y 8
                      :width 200
                      :height 24}]}
 :detail {:height 220
          :controls [{:type :label
                      :text "Ingredient Name"
                      :x 20
                      :y 8
                      :width 120
                      :height 18}
                     {:type :text-box
                      :field "name"
                      :label "name"
                      :x 20
                      :y 28
                      :width 200
                      :height 24}
                     {:type :label
                      :text "Description"
                      :x 20
                      :y 60
                      :width 100
                      :height 18}
                     {:type :text-box
                      :field "description"
                      :label "description"
                      :x 20
                      :y 80
                      :width 300
                      :height 50}
                     {:type :label
                      :text "Cost per Gram"
                      :x 20
                      :y 140
                      :width 100
                      :height 18}
                     {:type :text-box
                      :field "cost_per_gram"
                      :label "cost_per_gram"
                      :x 20
                      :y 160
                      :width 100
                      :height 24}]}
 :footer {:height 30
          :controls []}}',
    'ingredient',
    'Basic form for viewing/editing ingredients with name, description, and cost'
)
ON CONFLICT (database_id, name) DO UPDATE SET
    definition = EXCLUDED.definition,
    record_source = EXCLUDED.record_source,
    description = EXCLUDED.description,
    updated_at = NOW();

INSERT INTO shared.forms (database_id, name, definition, record_source, description)
VALUES (
    'calculator',
    'ingredient_entry',
    '{:id 2
 :name "Ingredient Entry"
 :type "form"
 :record-source "ingredient"
 :default-view "single"
 :header {:height 40
          :controls [{:type :label
                      :text "Ingredient Entry"
                      :x 8
                      :y 8
                      :width 200
                      :height 24}]}
 :detail {:height 200
          :controls [{:type :label
                      :text "ingredient"
                      :x 8
                      :y 8
                      :width 150
                      :height 18}
                     {:type :text-box
                      :field "ingredient"
                      :label "ingredient"
                      :x 8
                      :y 28
                      :width 150
                      :height 24}
                     {:type :label
                      :text "ingredient_type"
                      :x 8
                      :y 60
                      :width 150
                      :height 18}
                     {:type :text-box
                      :field "ingredient_type"
                      :label "ingredient_type"
                      :x 8
                      :y 80
                      :width 150
                      :height 24}
                     {:type :label
                      :text "initial_amount_in_grams"
                      :x 8
                      :y 112
                      :width 150
                      :height 18}
                     {:type :text-box
                      :field "initial_amount_in_grams"
                      :label "initial_amount_in_grams"
                      :x 8
                      :y 132
                      :width 150
                      :height 24}
                     {:type :label
                      :text "note"
                      :x 8
                      :y 164
                      :width 150
                      :height 18}
                     {:type :text-box
                      :field "note"
                      :label "note"
                      :x 8
                      :y 184
                      :width 200
                      :height 24}]}
 :footer {:height 30
          :controls []}}',
    'ingredient',
    'Data entry form for ingredients with type and initial amount'
)
ON CONFLICT (database_id, name) DO UPDATE SET
    definition = EXCLUDED.definition,
    record_source = EXCLUDED.record_source,
    description = EXCLUDED.description,
    updated_at = NOW();

INSERT INTO shared.forms (database_id, name, definition, record_source, description)
VALUES (
    'calculator',
    'inventory_list',
    '{:id 3
 :name "Inventory List"
 :type :form
 :record-source "ingredient"
 :default-view "continuous"
 :page-size 20
 :header {:height 30
          :controls [{:type :label
                      :text "Inventory List"
                      :x 8
                      :y 4
                      :width 200
                      :height 22}]}
 :detail {:height 32
          :controls [{:type :text-box
                      :field "name"
                      :label "name"
                      :x 10 :y 4
                      :width 150 :height 24}
                     {:type :text-box
                      :field "description"
                      :label "description"
                      :x 170 :y 4
                      :width 200 :height 24}
                     {:type :text-box
                      :field "cost_per_gram"
                      :label "cost_per_gram"
                      :x 380 :y 4
                      :width 80 :height 24}]}
 :footer {:height 30
          :controls []}}',
    'ingredient',
    'Continuous/datasheet view of ingredients'
)
ON CONFLICT (database_id, name) DO UPDATE SET
    definition = EXCLUDED.definition,
    record_source = EXCLUDED.record_source,
    description = EXCLUDED.description,
    updated_at = NOW();

-- Verify
SELECT database_id, name, record_source, created_at FROM shared.forms ORDER BY name;
