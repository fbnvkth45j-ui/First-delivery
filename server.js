// First Delivery - serveur (Node 22+, aucune dépendance externe)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, hashPassword, verifyPassword, seedAdmin, seedDemo } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// ---- Règles des statuts de commande : { statutActuel: { nouveauStatut: [rôles autorisés] } } ----
// "En livraison" et "Livrée" seront ajoutés avec l'espace livreur (Phase 2).
export const TRANSITIONS = {
  pending:   { accepted: ['restaurant'], refused: ['restaurant'], cancelled: ['client', 'admin'] },
  accepted:  { preparing: ['restaurant'], cancelled: ['admin'] },
  preparing: { ready: ['restaurant'], cancelled: ['admin'] },
  ready:     { cancelled: ['admin'] },
};

// Catégories de commerces. Pour en ajouter une : une ligne ici.
export const KINDS = [
  { id: 'repas', label: 'Repas', icon: '🍽️' },
  { id: 'quotidien', label: 'Produits du quotidien', icon: '🛒' },
  { id: 'autre', label: 'Autres', icon: '🛍️' },
];
const KIND_IDS = KINDS.map((k) => k.id);

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESSION_MS = 30 * 24 * 3600 * 1000;

// ---- Validation ----
function str(v, name, min, max) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${name} invalide`);
  v = v.trim();
  if (v.length < min) throw bad(`${name} est obligatoire`);
  if (v.length > max) throw bad(`${name} est trop long (${max} caractères maximum)`);
  return v;
}
function int(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} invalide`);
  return n;
}
function imgUrl(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw bad('Adresse de photo invalide');
  if (/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(v)) return v;
  if (/^https:\/\/[^\s"'<>]{1,480}$/.test(v)) return v;
  throw bad('Adresse de photo invalide');
}
const PHONE_RE = /^[+\d\s().-]{8,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApp(opts = {}) {
  const env = process.env;
  const dbPath = opts.dbPath ?? env.DB_PATH ?? path.join(__dirname, 'data', 'firstdelivery.db');
  const uploadDir = opts.uploadDir ?? env.UPLOAD_DIR ?? path.join(__dirname, 'data', 'uploads');
  const config = {
    // Valeurs provisoires : à fixer définitivement avant le lancement commercial.
    deliveryFee: Number(opts.deliveryFee ?? env.DELIVERY_FEE ?? 500),
    commissionRate: Number(opts.commissionRate ?? env.COMMISSION_RATE ?? 0.15),
    currency: 'FCFA',
  };
  const production = env.NODE_ENV === 'production';
  fs.mkdirSync(uploadDir, { recursive: true });

  const db = openDb(dbPath);
  const adminInfo = seedAdmin(db, {
    email: opts.adminEmail ?? env.ADMIN_EMAIL,
    password: opts.adminPassword ?? env.ADMIN_PASSWORD,
  });
  // Démo : activée par défaut hors production ; en production, seulement si DEMO_DATA=1 (période de test).
  const wantDemo = opts.demo ?? (env.DEMO_DATA === '1' || (!production && env.DEMO_DATA !== '0'));
  const demoCreated = wantDemo ? seedDemo(db) : false;

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  // ---- Sessions ----
  function createSession(res, userId) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie',
      `fd_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${production ? '; Secure' : ''}`);
  }
  function readCookie(req, name) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  }
  function currentUser(req) {
    const token = readCookie(req, 'fd_session');
    if (!token) return null;
    return db.prepare(`SELECT u.id, u.email, u.name, u.phone, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(hashToken(token), Date.now()) || null;
  }

  // ---- Limitation des tentatives de connexion ----
  const attempts = new Map();
  function checkRate(key, max = 20, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return; }
    a.count++;
    if (a.count > max) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
  }

  // ---- Lecture des requêtes ----
  function readBuffer(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'Fichier ou requête trop volumineux')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req) {
    const buf = await readBuffer(req, 1024 * 1024);
    if (buf.length === 0) return {};
    try {
      const v = JSON.parse(buf.toString('utf8'));
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch { throw bad('Données JSON invalides'); }
  }

  const send = (res, status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  };

  // ---- Accès aux données ----
  const ownRestaurant = (user) =>
    db.prepare('SELECT * FROM restaurants WHERE owner_id = ?').get(user.id);
  const toRestaurant = (r) => ({
    id: r.id, name: r.name, description: r.description, address: r.address, phone: r.phone,
    imageUrl: r.image_url, isOpen: !!r.is_open, status: r.status, isDemo: !!r.is_demo, kind: r.kind,
  });
  const toProduct = (p) => ({
    id: p.id, restaurantId: p.restaurant_id, name: p.name, description: p.description,
    price: p.price, category: p.category, imageUrl: p.image_url, available: !!p.available,
  });
  function loadOrder(id) {
    const o = db.prepare(`SELECT o.*, r.name AS restaurant_name, r.address AS restaurant_address,
        u.name AS customer_name FROM orders o
        JOIN restaurants r ON r.id = o.restaurant_id
        JOIN users u ON u.id = o.customer_id WHERE o.id = ?`).get(id);
    if (!o) return null;
    return {
      id: o.id, status: o.status, restaurantId: o.restaurant_id,
      restaurantName: o.restaurant_name, restaurantAddress: o.restaurant_address,
      customerId: o.customer_id, customerName: o.customer_name, customerPhone: o.customer_phone,
      deliveryAddress: o.delivery_address, notes: o.notes, paymentMethod: o.payment_method,
      subtotal: o.subtotal, deliveryFee: o.delivery_fee, total: o.total,
      commissionRate: o.commission_rate, commissionAmount: o.commission_amount,
      createdAt: o.created_at, updatedAt: o.updated_at,
      items: db.prepare('SELECT product_id AS productId, name, unit_price AS unitPrice, quantity FROM order_items WHERE order_id = ? ORDER BY id').all(id),
      events: db.prepare('SELECT status, at FROM order_events WHERE order_id = ? ORDER BY id').all(id),
    };
  }
  function canSeeOrder(user, o) {
    if (user.role === 'admin') return true;
    if (user.role === 'client') return o.customerId === user.id;
    if (user.role === 'restaurant') { const r = ownRestaurant(user); return !!r && r.id === o.restaurantId; }
    return false;
  }

  // ================= ROUTES =================
  const routes = [];
  const route = (method, pattern, roles, handler, raw = false) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, roles, handler, raw });
  };

  // --- Public ---
  route('GET', '/api/health', null, () => ({ ok: true, time: new Date().toISOString() }));

  route('GET', '/api/config', null, () => ({
    deliveryFee: config.deliveryFee, currency: config.currency, kinds: KINDS,
    payment: { methods: ['cash_on_delivery'], note: 'Paiement en espèces à la livraison. Le Mobile Money sera ajouté plus tard.' },
  }));

  route('GET', '/api/restaurants', null, ({ query }) => {
    const kind = query.get('kind');
    if (kind && !KIND_IDS.includes(kind)) throw bad('Catégorie inconnue');
    const rows = kind
      ? db.prepare("SELECT * FROM restaurants WHERE status = 'approved' AND kind = ? ORDER BY is_open DESC, name").all(kind)
      : db.prepare("SELECT * FROM restaurants WHERE status = 'approved' ORDER BY is_open DESC, name").all();
    return { restaurants: rows.map(toRestaurant) };
  });

  route('GET', '/api/restaurants/:id', null, ({ params }) => {
    const r = db.prepare("SELECT * FROM restaurants WHERE id = ? AND status = 'approved'").get(Number(params.id));
    if (!r) throw new HttpError(404, 'Restaurant introuvable');
    const products = db.prepare('SELECT * FROM products WHERE restaurant_id = ? AND available = 1 ORDER BY category, name').all(r.id);
    return { restaurant: toRestaurant(r), products: products.map(toProduct) };
  });

  // --- Comptes ---
  route('POST', '/api/auth/register', null, ({ req, res, body }) => {
    checkRate('reg:' + req.socket.remoteAddress);
    const role = body.role ?? 'client';
    // Seuls "client" et "restaurant" peuvent s'inscrire seuls. Jamais "admin".
    if (role !== 'client' && role !== 'restaurant') throw bad('Type de compte non autorisé');
    const name = str(body.name, 'Le nom', 2, 80);
    const email = str(body.email, "L'e-mail", 5, 120).toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad("L'e-mail est invalide");
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8 || password.length > 200) throw bad('Le mot de passe doit contenir au moins 8 caractères');
    const phone = str(body.phone, 'Le téléphone', role === 'client' ? 0 : 8, 20);
    if (phone && !PHONE_RE.test(phone)) throw bad('Le numéro de téléphone est invalide');
    let restaurantName = '', restaurantAddress = '', restaurantKind = 'repas';
    if (role === 'restaurant') {
      restaurantKind = body.restaurantKind ?? 'repas';
      if (!KIND_IDS.includes(restaurantKind)) throw bad('Catégorie de commerce invalide');
      restaurantName = str(body.restaurantName, 'Le nom du restaurant', 2, 80);
      restaurantAddress = str(body.restaurantAddress, "L'adresse du restaurant", 5, 200);
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée');
    const userId = tx(() => {
      const id = db.prepare('INSERT INTO users (email, password_hash, name, phone, role) VALUES (?, ?, ?, ?, ?)')
        .run(email, hashPassword(password), name, phone, role).lastInsertRowid;
      if (role === 'restaurant') {
        db.prepare("INSERT INTO restaurants (owner_id, name, address, phone, status, kind) VALUES (?, ?, ?, ?, 'pending', ?)")
          .run(id, restaurantName, restaurantAddress, phone, restaurantKind);
      }
      return id;
    });
    createSession(res, userId);
    return { user: db.prepare('SELECT id, email, name, phone, role FROM users WHERE id = ?').get(userId) };
  });

  route('POST', '/api/auth/login', null, ({ req, res, body }) => {
    checkRate('login:' + req.socket.remoteAddress);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'E-mail ou mot de passe incorrect');
    createSession(res, u.id);
    return { user: { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role } };
  });

  route('POST', '/api/auth/logout', null, ({ req, res }) => {
    const token = readCookie(req, 'fd_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.setHeader('Set-Cookie', 'fd_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  });

  route('GET', '/api/me', null, ({ user }) => {
    if (!user) return { user: null };
    const out = { user };
    if (user.role === 'restaurant') { const r = ownRestaurant(user); if (r) out.restaurant = toRestaurant(r); }
    return out;
  });

  // --- Client : commandes ---
  route('POST', '/api/orders', ['client'], ({ user, body }) => {
    const restaurantId = int(body.restaurantId, 'Restaurant', 1, 1e9);
    const r = db.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId);
    if (!r || r.status !== 'approved') throw new HttpError(404, 'Restaurant introuvable');
    if (!r.is_open) throw new HttpError(409, 'Ce restaurant est fermé actuellement');
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) throw bad('Le panier est vide');
    const address = str(body.address, "L'adresse de livraison", 5, 300);
    const phone = str(body.phone, 'Le téléphone', 8, 20);
    if (!PHONE_RE.test(phone)) throw bad('Le numéro de téléphone est invalide');
    const notes = str(body.notes, 'Les informations', 0, 500);

    // Les prix viennent TOUJOURS de la base de données, jamais du téléphone du client.
    const wanted = new Map();
    for (const it of body.items) {
      if (!it || typeof it !== 'object') throw bad('Panier invalide');
      const pid = int(it.productId, 'Produit', 1, 1e9);
      const qty = int(it.quantity, 'Quantité', 1, 50);
      wanted.set(pid, Math.min(50, (wanted.get(pid) || 0) + qty));
    }
    const lines = [];
    let subtotal = 0;
    for (const [pid, qty] of wanted) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND restaurant_id = ?').get(pid, restaurantId);
      if (!p) throw bad('Un produit du panier n’appartient pas à ce restaurant');
      if (!p.available) throw new HttpError(409, `« ${p.name} » n’est plus disponible`);
      lines.push({ p, qty });
      subtotal += p.price * qty;
    }
    const deliveryFee = config.deliveryFee;
    const total = subtotal + deliveryFee;
    const commission = Math.round(subtotal * config.commissionRate);
    const orderId = tx(() => {
      const id = db.prepare(`INSERT INTO orders (customer_id, restaurant_id, subtotal, delivery_fee, total,
          commission_rate, commission_amount, delivery_address, customer_phone, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(user.id, restaurantId, subtotal, deliveryFee, total, config.commissionRate, commission, address, phone, notes).lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_items (order_id, product_id, name, unit_price, quantity) VALUES (?, ?, ?, ?, ?)');
      for (const l of lines) ins.run(id, l.p.id, l.p.name, l.p.price, l.qty);
      db.prepare("INSERT INTO order_events (order_id, status, user_id) VALUES (?, 'pending', ?)").run(id, user.id);
      return id;
    });
    return { order: loadOrder(orderId) };
  });

  route('GET', '/api/orders', ['client', 'restaurant', 'admin'], ({ user }) => {
    let ids;
    if (user.role === 'client') ids = db.prepare('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(user.id);
    else if (user.role === 'restaurant') {
      const r = ownRestaurant(user);
      ids = r ? db.prepare('SELECT id FROM orders WHERE restaurant_id = ? ORDER BY id DESC LIMIT 100').all(r.id) : [];
    } else ids = db.prepare('SELECT id FROM orders ORDER BY id DESC LIMIT 200').all();
    return { orders: ids.map((x) => loadOrder(x.id)) };
  });

  route('GET', '/api/orders/:id', ['client', 'restaurant', 'admin'], ({ user, params }) => {
    const o = loadOrder(Number(params.id));
    if (!o || !canSeeOrder(user, o)) throw new HttpError(404, 'Commande introuvable');
    return { order: o };
  });

  route('POST', '/api/orders/:id/status', ['client', 'restaurant', 'admin'], ({ user, params, body }) => {
    const o = loadOrder(Number(params.id));
    if (!o || !canSeeOrder(user, o)) throw new HttpError(404, 'Commande introuvable');
    const next = typeof body.status === 'string' ? body.status : '';
    const allowed = TRANSITIONS[o.status]?.[next];
    if (!allowed || !allowed.includes(user.role)) {
      throw new HttpError(409, 'Ce changement de statut n’est pas possible pour cette commande');
    }
    tx(() => {
      db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, o.id);
      db.prepare('INSERT INTO order_events (order_id, status, user_id) VALUES (?, ?, ?)').run(o.id, next, user.id);
    });
    return { order: loadOrder(o.id) };
  });

  // --- Restaurant : mon restaurant et mes produits ---
  route('GET', '/api/my/restaurant', ['restaurant'], ({ user }) => {
    const r = ownRestaurant(user);
    if (!r) throw new HttpError(404, 'Restaurant introuvable');
    return { restaurant: toRestaurant(r) };
  });

  route('PUT', '/api/my/restaurant', ['restaurant'], ({ user, body }) => {
    const r = ownRestaurant(user);
    if (!r) throw new HttpError(404, 'Restaurant introuvable');
    const phone = str(body.phone, 'Le téléphone', 0, 20);
    if (phone && !PHONE_RE.test(phone)) throw bad('Le numéro de téléphone est invalide');
    db.prepare('UPDATE restaurants SET name = ?, description = ?, address = ?, phone = ?, image_url = ?, is_open = ? WHERE id = ?')
      .run(str(body.name, 'Le nom', 2, 80), str(body.description, 'La description', 0, 500),
        str(body.address, "L'adresse", 5, 200), phone, imgUrl(body.imageUrl), body.isOpen ? 1 : 0, r.id);
    return { restaurant: toRestaurant(ownRestaurant(user)) };
  });

  route('GET', '/api/my/products', ['restaurant'], ({ user }) => {
    const r = ownRestaurant(user);
    if (!r) throw new HttpError(404, 'Restaurant introuvable');
    return { products: db.prepare('SELECT * FROM products WHERE restaurant_id = ? ORDER BY category, name').all(r.id).map(toProduct) };
  });

  const productFields = (body) => ({
    name: str(body.name, 'Le nom du produit', 2, 80),
    description: str(body.description, 'La description', 0, 300),
    price: int(body.price, 'Le prix', 0, 10_000_000),
    category: str(body.category || 'Plats', 'La catégorie', 1, 40),
    imageUrl: imgUrl(body.imageUrl),
    available: body.available === false ? 0 : 1,
  });

  route('POST', '/api/my/products', ['restaurant'], ({ user, body }) => {
    const r = ownRestaurant(user);
    if (!r) throw new HttpError(404, 'Restaurant introuvable');
    const f = productFields(body);
    const id = db.prepare('INSERT INTO products (restaurant_id, name, description, price, category, image_url, available) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, f.name, f.description, f.price, f.category, f.imageUrl, f.available).lastInsertRowid;
    return { product: toProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) };
  });

  const ownProduct = (user, id) => {
    const r = ownRestaurant(user);
    const p = r && db.prepare('SELECT * FROM products WHERE id = ? AND restaurant_id = ?').get(Number(id), r.id);
    if (!p) throw new HttpError(404, 'Produit introuvable');
    return p;
  };

  route('PUT', '/api/my/products/:id', ['restaurant'], ({ user, params, body }) => {
    const p = ownProduct(user, params.id);
    const f = productFields(body);
    db.prepare('UPDATE products SET name = ?, description = ?, price = ?, category = ?, image_url = ?, available = ? WHERE id = ?')
      .run(f.name, f.description, f.price, f.category, f.imageUrl, f.available, p.id);
    return { product: toProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id)) };
  });

  route('DELETE', '/api/my/products/:id', ['restaurant'], ({ user, params }) => {
    const p = ownProduct(user, params.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(p.id); // l'historique des commandes garde le nom et le prix
    return { ok: true };
  });

  // --- Photos : on reconnaît le vrai type du fichier, pas seulement son nom ---
  route('POST', '/api/upload', ['restaurant', 'admin'], async ({ req }) => {
    const buf = await readBuffer(req, 2 * 1024 * 1024);
    let ext = null;
    if (buf.length > 12) {
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
      else if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
      else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') ext = 'webp';
    }
    if (!ext) throw bad('Format de photo non accepté (JPEG, PNG ou WebP uniquement)');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    return { url: '/uploads/' + name };
  }, true);

  // --- Administrateur ---
  route('GET', '/api/admin/stats', ['admin'], () => {
    const group = (sql) => Object.fromEntries(db.prepare(sql).all().map((x) => [x.k, x.n]));
    const money = db.prepare("SELECT COALESCE(SUM(total),0) AS gross, COALESCE(SUM(commission_amount),0) AS commission FROM orders WHERE status = 'delivered'").get();
    return {
      users: group('SELECT role AS k, COUNT(*) AS n FROM users GROUP BY role'),
      restaurants: group('SELECT status AS k, COUNT(*) AS n FROM restaurants GROUP BY status'),
      orders: group('SELECT status AS k, COUNT(*) AS n FROM orders GROUP BY status'),
      deliveredGross: money.gross, deliveredCommission: money.commission,
    };
  });

  route('GET', '/api/admin/restaurants', ['admin'], () => ({
    restaurants: db.prepare(`SELECT r.*, u.email AS owner_email, u.name AS owner_name FROM restaurants r
      JOIN users u ON u.id = r.owner_id ORDER BY (r.status = 'pending') DESC, r.id DESC`).all()
      .map((r) => ({ ...toRestaurant(r), ownerEmail: r.owner_email, ownerName: r.owner_name })),
  }));

  route('POST', '/api/admin/restaurants/:id/status', ['admin'], ({ params, body }) => {
    const status = body.status;
    if (status !== 'approved' && status !== 'rejected') throw bad('Statut invalide');
    const r = db.prepare('SELECT id FROM restaurants WHERE id = ?').get(Number(params.id));
    if (!r) throw new HttpError(404, 'Restaurant introuvable');
    db.prepare('UPDATE restaurants SET status = ? WHERE id = ?').run(status, r.id);
    return { restaurant: toRestaurant(db.prepare('SELECT * FROM restaurants WHERE id = ?').get(r.id)) };
  }, false);

  // ================= SERVEUR HTTP =================
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  };

  function serveFile(res, baseDir, rel, immutable) {
    const file = path.resolve(baseDir, '.' + path.sep + rel);
    if (file !== baseDir && !file.startsWith(baseDir + path.sep)) return false; // pas de sortie du dossier
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return false;
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { pathname = null; }
    if (pathname === null) return send(res, 400, { error: 'Adresse invalide' });

    if (pathname.startsWith('/api/')) {
      try {
        const match = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(pathname) : null })).find((x) => x.m);
        if (!match) throw new HttpError(404, 'Adresse inconnue');
        const { r, m } = match;
        // Protection CSRF : les actions d'écriture doivent venir de notre application
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'Requête refusée');
        const user = currentUser(req);
        if (r.roles) {
          if (!user) throw new HttpError(401, 'Connectez-vous pour continuer');
          if (!r.roles.includes(user.role)) throw new HttpError(403, 'Accès refusé');
        }
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        const body = (req.method === 'GET' || req.method === 'DELETE' || r.raw) ? {} : await readJson(req);
        const out = await r.handler({ req, res, user, params, body, query: url.searchParams });
        return send(res, 200, out);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        console.error('Erreur serveur :', e);
        return send(res, 500, { error: 'Une erreur est survenue. Réessayez.' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Méthode non autorisée' });
    if (pathname.startsWith('/uploads/')) {
      if (serveFile(res, path.resolve(uploadDir), pathname.slice('/uploads/'.length), true)) return;
      return send(res, 404, { error: 'Fichier introuvable' });
    }
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (serveFile(res, PUBLIC_DIR, rel, false)) return;
    return send(res, 404, { error: 'Page introuvable' });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); try { res.end(); } catch { /* */ } }); });
  return { server, db, config, adminInfo, demoCreated, close: () => { server.close(); db.close(); } };
}

// Démarrage direct : "node server.js"
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`\nFirst Delivery est démarré : http://localhost:${port}\n`);
    if (app.adminInfo?.generated) {
      console.log('Compte administrateur créé (notez bien ces informations, elles ne seront plus affichées) :');
      console.log(`  e-mail       : ${app.adminInfo.email}`);
      console.log(`  mot de passe : ${app.adminInfo.password}\n`);
    } else if (app.adminInfo) {
      console.log(`Compte administrateur créé : ${app.adminInfo.email}\n`);
    }
    if (app.demoCreated) {
      console.log('Restaurants de démonstration créés (comptes démo : demo.awa@firstdelivery.local / demo.burger@firstdelivery.local, mot de passe demo1234).');
      console.log('Ils sont réservés aux tests : ne les utilisez pas en production.\n');
    }
  });
}
