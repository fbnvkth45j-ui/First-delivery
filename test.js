// Tests de bout en bout : "npm test"
// Démarre un vrai serveur avec une base temporaire et joue le parcours complet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-test-'));
const app = createApp({
  dbPath: path.join(tmp, 'test.db'), uploadDir: path.join(tmp, 'uploads'),
  adminEmail: 'admin@test.local', adminPassword: 'AdminPass123', demo: true,
  deliveryFee: 500, commissionRate: 0.15,
});
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const h = { 'X-Requested-With': 'fetch', ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie');
    if (sc) { cookie = sc.split(';')[0]; if (cookie.endsWith('=')) cookie = ''; }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) data = await res.json(); else await res.arrayBuffer();
    return { status: res.status, data, type: ct };
  };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + (e.message || e).toString().split('\n').join('\n      ')); }
}

const anon = client(), admin = client(), alice = client(), bob = client(), awa = client(), burger = client(), newResto = client();
const ctx = {};

console.log('\nFirst Delivery — tests\n');

console.log('Public');
await test('le serveur répond', async () => {
  const r = await anon('GET', '/api/health');
  assert.equal(r.status, 200); assert.equal(r.data.ok, true);
});
await test('la page d’accueil est servie', async () => {
  const r = await anon('GET', '/');
  assert.equal(r.status, 200); assert.ok(r.type.includes('text/html'));
});
await test('2 restaurants de démo, sans données sensibles', async () => {
  const r = await anon('GET', '/api/restaurants');
  assert.equal(r.data.restaurants.length, 2);
  assert.ok(!JSON.stringify(r.data).includes('password'));
  ctx.awaId = r.data.restaurants.find((x) => x.name.includes('Awa')).id;
  ctx.burgerId = r.data.restaurants.find((x) => x.name.includes('Burger')).id;
});
await test('menu d’un restaurant avec prix', async () => {
  const r = await anon('GET', `/api/restaurants/${ctx.awaId}`);
  assert.ok(r.data.products.length >= 5);
  ctx.awaProducts = r.data.products;
  const b = await anon('GET', `/api/restaurants/${ctx.burgerId}`);
  ctx.burgerProducts = b.data.products;
});
await test('protection des fichiers : pas de sortie du dossier public', async () => {
  for (const p of ['/%2e%2e/server.js', '/..%2fdb.js', '/uploads/..%2f..%2fserver.js']) {
    const r = await anon('GET', p);
    assert.equal(r.status, 404, p);
  }
});

console.log('\nComptes et sécurité');
await test('inscription client', async () => {
  const r = await alice('POST', '/api/auth/register', { name: 'Alice Client', email: 'Alice@Test.local', password: 'motdepasse1', phone: '70 11 22 33' });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'client'); assert.equal(r.data.user.email, 'alice@test.local');
});
await test('impossible de s’inscrire comme administrateur', async () => {
  const r = await bob('POST', '/api/auth/register', { name: 'Pirate', email: 'pirate@test.local', password: 'motdepasse1', role: 'admin' });
  assert.equal(r.status, 400);
  const r2 = await bob('POST', '/api/auth/register', { name: 'Pirate', email: 'pirate@test.local', password: 'motdepasse1', role: 'livreur' });
  assert.equal(r2.status, 400);
});
await test('e-mail déjà utilisé, mot de passe trop court', async () => {
  assert.equal((await bob('POST', '/api/auth/register', { name: 'Alice 2', email: 'alice@test.local', password: 'motdepasse1' })).status, 409);
  assert.equal((await bob('POST', '/api/auth/register', { name: 'Bob', email: 'bob@test.local', password: 'court' })).status, 400);
});
await test('inscription du deuxième client', async () => {
  const r = await bob('POST', '/api/auth/register', { name: 'Bob Client', email: 'bob@test.local', password: 'motdepasse2', phone: '76000000' });
  assert.equal(r.status, 200);
});
await test('mauvais mot de passe refusé', async () => {
  assert.equal((await client()('POST', '/api/auth/login', { email: 'alice@test.local', password: 'faux-mot-de-passe' })).status, 401);
});
await test('connexion / session / déconnexion', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { email: 'alice@test.local', password: 'motdepasse1' })).status, 200);
  assert.equal((await c('GET', '/api/me')).data.user.email, 'alice@test.local');
  await c('POST', '/api/auth/logout', {});
  assert.equal((await c('GET', '/api/me')).data.user, null);
});
await test('un client ne peut pas accéder à l’administration', async () => {
  assert.equal((await alice('GET', '/api/admin/stats')).status, 403);
  assert.equal((await alice('GET', '/api/admin/restaurants')).status, 403);
  assert.equal((await anon('GET', '/api/admin/stats')).status, 401);
});
await test('un client ne peut pas gérer un restaurant', async () => {
  assert.equal((await alice('POST', '/api/my/products', { name: 'Pirate', price: 1 })).status, 403);
  assert.equal((await alice('PUT', '/api/my/restaurant', { name: 'Pirate' })).status, 403);
});
await test('aucun moyen de changer son rôle', async () => {
  for (const [m, p] of [['PUT', '/api/me'], ['POST', '/api/me'], ['PATCH', '/api/me'], ['PUT', '/api/users/1']]) {
    const r = await alice(m, p, { role: 'admin' });
    assert.ok([404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
  assert.equal((await alice('GET', '/api/me')).data.user.role, 'client');
});
await test('requête d’écriture sans l’en-tête de l’application refusée (CSRF)', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice@test.local', password: 'motdepasse1' }) });
  assert.equal(res.status, 403);
});
await test('connexion administrateur', async () => {
  const r = await admin('POST', '/api/auth/login', { email: 'admin@test.local', password: 'AdminPass123' });
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin');
});
await test('connexion des restaurants de démo', async () => {
  assert.equal((await awa('POST', '/api/auth/login', { email: 'demo.awa@firstdelivery.local', password: 'demo1234' })).status, 200);
  assert.equal((await burger('POST', '/api/auth/login', { email: 'demo.burger@firstdelivery.local', password: 'demo1234' })).status, 200);
});

console.log('\nParcours client : commande');
await test('commande valide : prix recalculés par le serveur (le prix envoyé est ignoré)', async () => {
  const [p1, p2] = ctx.awaProducts;
  const r = await alice('POST', '/api/orders', {
    restaurantId: ctx.awaId, address: 'Secteur 15, rue 12.34, portail bleu', phone: '70112233', notes: 'Appeler en arrivant',
    items: [{ productId: p1.id, quantity: 2, price: 1 }, { productId: p2.id, quantity: 1, unitPrice: 1 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const o = r.data.order;
  const expected = p1.price * 2 + p2.price;
  assert.equal(o.subtotal, expected); assert.equal(o.deliveryFee, 500); assert.equal(o.total, expected + 500);
  assert.equal(o.commissionAmount, Math.round(expected * 0.15));
  assert.equal(o.status, 'pending'); assert.equal(o.items.length, 2); assert.equal(o.paymentMethod, 'cash_on_delivery');
  ctx.order1 = o.id;
});
await test('commande refusée : panier vide, quantité 0, adresse manquante', async () => {
  const p = ctx.awaProducts[0];
  const base_ = { restaurantId: ctx.awaId, address: 'Secteur 15, rue 12.34', phone: '70112233' };
  assert.equal((await alice('POST', '/api/orders', { ...base_, items: [] })).status, 400);
  assert.equal((await alice('POST', '/api/orders', { ...base_, items: [{ productId: p.id, quantity: 0 }] })).status, 400);
  assert.equal((await alice('POST', '/api/orders', { ...base_, address: '', items: [{ productId: p.id, quantity: 1 }] })).status, 400);
});
await test('commande refusée : produits de deux restaurants différents', async () => {
  const r = await alice('POST', '/api/orders', {
    restaurantId: ctx.awaId, address: 'Secteur 15, rue 12.34', phone: '70112233',
    items: [{ productId: ctx.awaProducts[0].id, quantity: 1 }, { productId: ctx.burgerProducts[0].id, quantity: 1 }],
  });
  assert.equal(r.status, 400);
});
await test('il faut être client connecté pour commander', async () => {
  const body = { restaurantId: ctx.awaId, address: 'Secteur 15, rue 12.34', phone: '70112233', items: [{ productId: ctx.awaProducts[0].id, quantity: 1 }] };
  assert.equal((await anon('POST', '/api/orders', body)).status, 401);
  assert.equal((await awa('POST', '/api/orders', body)).status, 403);
});
await test('historique du client ; un autre client ne voit pas la commande', async () => {
  const mine = await alice('GET', '/api/orders');
  assert.ok(mine.data.orders.some((o) => o.id === ctx.order1));
  assert.equal((await bob('GET', '/api/orders')).data.orders.length, 0);
  assert.equal((await bob('GET', `/api/orders/${ctx.order1}`)).status, 404);
  assert.equal((await alice('GET', `/api/orders/${ctx.order1}`)).status, 200);
});

console.log('\nEspace restaurant : traitement de la commande');
await test('le restaurant concerné voit la commande, l’autre non', async () => {
  assert.ok((await awa('GET', '/api/orders')).data.orders.some((o) => o.id === ctx.order1));
  assert.equal((await burger('GET', '/api/orders')).data.orders.length, 0);
  assert.equal((await burger('GET', `/api/orders/${ctx.order1}`)).status, 404);
  assert.equal((await burger('POST', `/api/orders/${ctx.order1}/status`, { status: 'accepted' })).status, 404);
});
await test('le client ne peut pas accepter sa propre commande', async () => {
  assert.equal((await alice('POST', `/api/orders/${ctx.order1}/status`, { status: 'accepted' })).status, 409);
});
await test('cycle : acceptée → en préparation → prête', async () => {
  for (const s of ['accepted', 'preparing', 'ready']) {
    const r = await awa('POST', `/api/orders/${ctx.order1}/status`, { status: s });
    assert.equal(r.status, 200, s); assert.equal(r.data.order.status, s);
  }
  const o = (await alice('GET', `/api/orders/${ctx.order1}`)).data.order;
  assert.deepEqual(o.events.map((e) => e.status), ['pending', 'accepted', 'preparing', 'ready']);
});
await test('transitions interdites refusées', async () => {
  assert.equal((await awa('POST', `/api/orders/${ctx.order1}/status`, { status: 'preparing' })).status, 409);
  assert.equal((await awa('POST', `/api/orders/${ctx.order1}/status`, { status: 'delivered' })).status, 409);
  assert.equal((await alice('POST', `/api/orders/${ctx.order1}/status`, { status: 'cancelled' })).status, 409);
  assert.equal((await awa('POST', `/api/orders/${ctx.order1}/status`, { status: 'nimporte-quoi' })).status, 409);
});
await test('annulation par le client tant que la commande est en attente', async () => {
  const mk = await alice('POST', '/api/orders', { restaurantId: ctx.awaId, address: 'Secteur 15, rue 1', phone: '70112233', items: [{ productId: ctx.awaProducts[0].id, quantity: 1 }] });
  const id = mk.data.order.id;
  const c = await alice('POST', `/api/orders/${id}/status`, { status: 'cancelled' });
  assert.equal(c.status, 200); assert.equal(c.data.order.status, 'cancelled');
  assert.equal((await awa('POST', `/api/orders/${id}/status`, { status: 'accepted' })).status, 409);
});
await test('refus d’une commande par le restaurant', async () => {
  const mk = await bob('POST', '/api/orders', { restaurantId: ctx.awaId, address: 'Ouaga 2000, villa 4', phone: '76000000', items: [{ productId: ctx.awaProducts[1].id, quantity: 3 }] });
  const r = await awa('POST', `/api/orders/${mk.data.order.id}/status`, { status: 'refused' });
  assert.equal(r.data.order.status, 'refused');
  assert.equal((await awa('POST', `/api/orders/${mk.data.order.id}/status`, { status: 'accepted' })).status, 409);
});

console.log('\nEspace restaurant : produits et photos');
await test('ajout, modification, masquage et suppression d’un produit', async () => {
  const add = await burger('POST', '/api/my/products', { name: 'Burger double', description: 'Deux steaks', price: 4500, category: 'Burgers' });
  assert.equal(add.status, 200); const id = add.data.product.id;
  assert.equal((await burger('PUT', `/api/my/products/${id}`, { name: 'Burger double XL', description: 'Deux steaks', price: 5000, category: 'Burgers' })).data.product.price, 5000);
  assert.ok((await anon('GET', `/api/restaurants/${ctx.burgerId}`)).data.products.some((p) => p.id === id));
  await burger('PUT', `/api/my/products/${id}`, { name: 'Burger double XL', price: 5000, category: 'Burgers', available: false });
  assert.ok(!(await anon('GET', `/api/restaurants/${ctx.burgerId}`)).data.products.some((p) => p.id === id));
  assert.equal((await burger('DELETE', `/api/my/products/${id}`)).status, 200);
});
await test('un restaurant ne peut pas toucher aux produits d’un autre', async () => {
  const pid = ctx.awaProducts[0].id;
  const body = { name: 'Piraté', price: 1, category: 'X' };
  assert.equal((await burger('PUT', `/api/my/products/${pid}`, body)).status, 404);
  assert.equal((await burger('DELETE', `/api/my/products/${pid}`)).status, 404);
});
await test('supprimer un produit garde l’historique des commandes', async () => {
  const add = await awa('POST', '/api/my/products', { name: 'Plat éphémère', price: 1000, category: 'Plats' });
  const mk = await alice('POST', '/api/orders', { restaurantId: ctx.awaId, address: 'Secteur 15, rue 1', phone: '70112233', items: [{ productId: add.data.product.id, quantity: 1 }] });
  await awa('DELETE', `/api/my/products/${add.data.product.id}`);
  const o = (await alice('GET', `/api/orders/${mk.data.order.id}`)).data.order;
  assert.equal(o.items[0].name, 'Plat éphémère'); assert.equal(o.items[0].unitPrice, 1000);
});
await test('données de produit invalides refusées', async () => {
  assert.equal((await awa('POST', '/api/my/products', { name: 'X', price: 100 })).status, 400);
  assert.equal((await awa('POST', '/api/my/products', { name: 'Plat', price: -5 })).status, 400);
  assert.equal((await awa('POST', '/api/my/products', { name: 'Plat', price: 'abc' })).status, 400);
  assert.equal((await awa('POST', '/api/my/products', { name: 'Plat', price: 100, imageUrl: 'javascript:alert(1)' })).status, 400);
});
await test('envoi de photo : vrai PNG accepté, faux fichier refusé', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const up = await awa('POST', '/api/upload', png, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 200); assert.match(up.data.url, /^\/uploads\/[a-f0-9]{32}\.png$/);
  const get = await anon('GET', up.data.url);
  assert.equal(get.status, 200); assert.equal(get.type, 'image/png');
  const fake = await awa('POST', '/api/upload', Buffer.from('<script>alert(1)</script> pas une image du tout'), { 'Content-Type': 'image/png' });
  assert.equal(fake.status, 400);
  assert.equal((await alice('POST', '/api/upload', png, { 'Content-Type': 'image/png' })).status, 403);
  const prod = await awa('POST', '/api/my/products', { name: 'Plat avec photo', price: 1500, category: 'Plats', imageUrl: up.data.url });
  assert.equal(prod.data.product.imageUrl, up.data.url);
  await awa('DELETE', `/api/my/products/${prod.data.product.id}`);
});
await test('restaurant fermé : commande impossible ; réouverture', async () => {
  const info = (await burger('GET', '/api/my/restaurant')).data.restaurant;
  await burger('PUT', '/api/my/restaurant', { ...info, isOpen: false });
  const body = { restaurantId: ctx.burgerId, address: 'Secteur 15, rue 1', phone: '70112233', items: [{ productId: ctx.burgerProducts[0].id, quantity: 1 }] };
  assert.equal((await alice('POST', '/api/orders', body)).status, 409);
  await burger('PUT', '/api/my/restaurant', { ...info, isOpen: true });
  assert.equal((await alice('POST', '/api/orders', body)).status, 200);
});

console.log('\nNouveau restaurant et administration');
await test('un nouveau restaurant est invisible tant que l’administrateur ne l’a pas validé', async () => {
  const r = await newResto('POST', '/api/auth/register', { role: 'restaurant', name: 'Issa Traoré', email: 'issa@test.local', password: 'motdepasse3', phone: '70 55 44 33', restaurantName: 'Maquis Chez Issa', restaurantAddress: 'Bobo-Dioulasso, secteur 1' });
  assert.equal(r.status, 200);
  const me = await newResto('GET', '/api/me');
  assert.equal(me.data.restaurant.status, 'pending'); ctx.issaId = me.data.restaurant.id;
  await newResto('POST', '/api/my/products', { name: 'Poisson braisé', price: 3500, category: 'Grillades' });
  assert.ok(!(await anon('GET', '/api/restaurants')).data.restaurants.some((x) => x.id === ctx.issaId));
  assert.equal((await anon('GET', `/api/restaurants/${ctx.issaId}`)).status, 404);
  const body = { restaurantId: ctx.issaId, address: 'Secteur 15, rue 1', phone: '70112233', items: [{ productId: 1, quantity: 1 }] };
  assert.equal((await alice('POST', '/api/orders', body)).status, 404);
});
await test('seul l’administrateur peut valider un restaurant', async () => {
  assert.equal((await newResto('POST', `/api/admin/restaurants/${ctx.issaId}/status`, { status: 'approved' })).status, 403);
  assert.equal((await alice('POST', `/api/admin/restaurants/${ctx.issaId}/status`, { status: 'approved' })).status, 403);
  const list = await admin('GET', '/api/admin/restaurants');
  assert.equal(list.data.restaurants[0].status, 'pending');
  assert.equal((await admin('POST', `/api/admin/restaurants/${ctx.issaId}/status`, { status: 'approved' })).status, 200);
  assert.ok((await anon('GET', '/api/restaurants')).data.restaurants.some((x) => x.id === ctx.issaId));
});
await test('statistiques administrateur et vue de toutes les commandes', async () => {
  const s = await admin('GET', '/api/admin/stats');
  assert.equal(s.status, 200); assert.equal(s.data.users.admin, 1); assert.ok(s.data.users.client >= 2);
  assert.ok((await admin('GET', '/api/orders')).data.orders.length >= 4);
});
await test('l’administrateur peut annuler une commande en cours, pas la valider à la place du restaurant', async () => {
  const mk = await alice('POST', '/api/orders', { restaurantId: ctx.awaId, address: 'Secteur 15, rue 1', phone: '70112233', items: [{ productId: ctx.awaProducts[0].id, quantity: 1 }] });
  const id = mk.data.order.id;
  assert.equal((await admin('POST', `/api/orders/${id}/status`, { status: 'accepted' })).status, 409);
  assert.equal((await admin('POST', `/api/orders/${id}/status`, { status: 'cancelled' })).data.order.status, 'cancelled');
});

console.log(`\n${passed} réussis, ${failed} échoués\n`);
app.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
