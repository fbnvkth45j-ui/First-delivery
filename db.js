// Base de données SQLite (intégrée à Node, aucune installation nécessaire)
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('client','restaurant','livreur','entreprise','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS restaurants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  image_url   TEXT NOT NULL DEFAULT '',
  is_open     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  is_demo     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price         INTEGER NOT NULL CHECK (price >= 0),
  category      TEXT NOT NULL DEFAULT 'Plats',
  image_url     TEXT NOT NULL DEFAULT '',
  available     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       INTEGER NOT NULL REFERENCES users(id),
  restaurant_id     INTEGER NOT NULL REFERENCES restaurants(id),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','refused','preparing','ready','delivering','delivered','cancelled')),
  subtotal          INTEGER NOT NULL,
  delivery_fee      INTEGER NOT NULL,
  total             INTEGER NOT NULL,
  commission_rate   REAL NOT NULL,
  commission_amount INTEGER NOT NULL,
  payment_method    TEXT NOT NULL DEFAULT 'cash_on_delivery',
  delivery_address  TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS order_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status   TEXT NOT NULL,
  user_id  INTEGER REFERENCES users(id),
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_restaurant ON products(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// ---- Mots de passe : scrypt (jamais stockés en clair) ----
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---- Compte administrateur : créé uniquement ici, jamais via l'API ----
export function seedAdmin(db, { email, password } = {}) {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return null;
  const adminEmail = (email || 'admin@firstdelivery.local').toLowerCase();
  const generated = !password;
  const adminPassword = password || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Administrateur', 'admin')")
    .run(adminEmail, hashPassword(adminPassword));
  return { email: adminEmail, password: generated ? adminPassword : null, generated };
}

// ---- Données de démonstration (restaurants fictifs, repérés par is_demo = 1) ----
export function seedDemo(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM restaurants').get().n;
  if (count > 0) return false;

  const demo = [
    {
      email: 'demo.awa@firstdelivery.local', owner: 'Awa (démo)',
      name: 'Chez Maman Awa (démo)', address: 'Ouagadougou, secteur 15',
      description: 'Cuisine burkinabè traditionnelle, faite maison.',
      products: [
        ['Riz gras au poulet', 'Riz cuisiné à la tomate avec une cuisse de poulet', 2500, 'Plats'],
        ['Tô sauce gombo', 'Tô de mil avec sauce gombo et viande', 2000, 'Plats'],
        ['Poulet bicyclette grillé', 'Demi-poulet grillé avec oignons et piment', 4000, 'Grillades'],
        ['Brochettes de bœuf (5)', 'Cinq brochettes marinées, servies avec oignons', 1500, 'Grillades'],
        ['Jus de bissap', 'Jus d’hibiscus frais, 50 cl', 500, 'Boissons'],
        ['Jus de gingembre', 'Jus de gingembre frais, 50 cl', 500, 'Boissons'],
      ],
    },
    {
      email: 'demo.burger@firstdelivery.local', owner: 'Burger (démo)',
      name: 'Le Délice Burger (démo)', address: 'Ouagadougou, Ouaga 2000',
      description: 'Burgers, frites et boissons fraîches.',
      products: [
        ['Burger classique', 'Steak, salade, tomate, fromage', 3000, 'Burgers'],
        ['Burger poulet croustillant', 'Poulet pané, sauce maison', 3500, 'Burgers'],
        ['Frites', 'Portion de frites maison', 1000, 'Accompagnements'],
        ['Soda 33 cl', 'Canette fraîche', 600, 'Boissons'],
      ],
    },
  ];

  const insUser = db.prepare("INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, 'restaurant')");
  const insResto = db.prepare("INSERT INTO restaurants (owner_id, name, description, address, status, is_demo) VALUES (?, ?, ?, ?, 'approved', 1)");
  const insProd = db.prepare('INSERT INTO products (restaurant_id, name, description, price, category) VALUES (?, ?, ?, ?, ?)');
  const pwd = hashPassword('demo1234');
  for (const r of demo) {
    const uid = insUser.run(r.email, pwd, r.owner, '').lastInsertRowid;
    const rid = insResto.run(uid, r.name, r.description, r.address).lastInsertRowid;
    for (const p of r.products) insProd.run(rid, p[0], p[1], p[2], p[3]);
  }
  return true;
}
