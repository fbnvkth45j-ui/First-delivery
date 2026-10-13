'use strict';
// First Delivery — interface mobile (une seule page, sans bibliothèque externe)

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('fr-FR') + ' FCFA';
const STATUS = {
  pending: 'En attente du restaurant', accepted: 'Acceptée', preparing: 'En préparation', ready: 'Prête à récupérer',
  delivering: 'En livraison', delivered: 'Livrée', refused: 'Refusée par le restaurant', cancelled: 'Annulée',
};
const pill = (s) => `<span class="pill ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
const fmtDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z')
  .toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const safeImg = (u) => (typeof u === 'string' && (u.startsWith('/uploads/') || u.startsWith('https://'))) ? u : '';
const thumb = (u, cls = 'thumb') => safeImg(u)
  ? `<img class="${cls}" src="${esc(safeImg(u))}" alt="" loading="lazy">` : `<div class="${cls}">🍽️</div>`;

// ---------- État ----------
const state = { user: null, restaurant: null, config: { deliveryFee: 500, kinds: [] }, kind: 'all', pending: 0, draft: {}, nextHash: null };
let cart = { restaurantId: null, restaurantName: '', items: [] };
try { const c = JSON.parse(localStorage.getItem('fd_cart') || 'null'); if (c && Array.isArray(c.items)) cart = c; } catch { /* panier vide */ }
const saveCart = () => { try { localStorage.setItem('fd_cart', JSON.stringify(cart)); } catch { /* ignore */ } };
const cartCount = () => cart.items.reduce((n, i) => n + i.quantity, 0);
const cartSubtotal = () => cart.items.reduce((n, i) => n + i.quantity * i.price, 0);

// ---------- Appels au serveur ----------
async function api(method, url, body) {
  const opts = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); } catch { throw new Error('Pas de connexion à Internet. Réessayez.'); }
  let data = {};
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) { const e = new Error(data.error || 'Une erreur est survenue'); e.status = res.status; throw e; }
  return data;
}
let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}
async function refreshMe() {
  const d = await api('GET', '/api/me');
  state.user = d.user; state.restaurant = d.restaurant || null;
}

// ---------- Barre du haut et navigation ----------
function renderChrome() {
  const u = state.user;
  $('#topright').innerHTML = u
    ? `<span class="small">${esc(u.name.split(' ')[0])}</span><button data-act="logout">Déconnexion</button>`
    : '<a href="#/login">Connexion</a>';
  const h = location.hash || '#/';
  let items;
  if (u && u.role === 'restaurant') {
    items = [['#/pro', '📋', 'Commandes', state.pending], ['#/pro/products', '🍲', 'Menu'], ['#/pro/info', '🏪', 'Restaurant']];
  } else if (u && u.role === 'admin') {
    items = [['#/admin', '📊', 'Tableau'], ['#/admin/restaurants', '🏪', 'Restaurants'], ['#/admin/orders', '📋', 'Commandes']];
  } else {
    items = [['#/', '🍽️', 'Commerces'], ['#/cart', '🛒', 'Panier', cartCount()],
      u ? ['#/orders', '📋', 'Commandes'] : ['#/login', '👤', 'Connexion']];
  }
  $('#nav').innerHTML = items.map(([href, ico, label, badge]) => {
    const exactOnly = href === '#/pro' || href === '#/admin';
    const active = href === '#/' ? (h === '#/' || h === '' || h.startsWith('#/r/'))
      : exactOnly ? h === href : (h === href || h.startsWith(href + '/'));
    return `<a href="${href}" class="${active ? 'active' : ''}"><span class="ico">${ico}</span>${label}${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
  }).join('');
}

// ---------- Utilitaires de vue ----------
const empty = (icon, text) => `<div class="empty"><span class="big">${icon}</span>${text}</div>`;
const tabs = (list, active) => `<div class="tabs">${list.map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}</div>`;
const needLogin = (role) => {
  if (!state.user) { state.nextHash = location.hash; location.hash = '#/login'; return true; }
  if (role && state.user.role !== role) { location.hash = '#/'; return true; }
  return false;
};

// ================= CLIENT =================
const kindLabel = (id) => { const k = (state.config.kinds || []).find((x) => x.id === id); return k ? `${k.icon} ${k.label}` : ''; };
async function viewHome() {
  if (state.user?.role === 'restaurant') { location.hash = '#/pro'; return null; }
  if (state.user?.role === 'admin') { location.hash = '#/admin'; return null; }
  const kinds = state.config.kinds || [];
  if (state.kind !== 'all' && !kinds.some((k) => k.id === state.kind)) state.kind = 'all';
  const { restaurants } = await api('GET', '/api/restaurants' + (state.kind !== 'all' ? '?kind=' + encodeURIComponent(state.kind) : ''));
  const chips = kinds.length > 1
    ? `<div class="tabs">${[{ id: 'all', label: 'Tout', icon: '✨' }, ...kinds].map((k) => `<a href="#/" data-act="kind" data-kind="${esc(k.id)}" class="${state.kind === k.id ? 'active' : ''}">${k.icon} ${esc(k.label)}</a>`).join('')}</div>` : '';
  if (!restaurants.length) return '<h1>Que voulez-vous commander ?</h1>' + chips + empty('🍽️', 'Aucun commerce disponible dans cette catégorie pour le moment.');
  return '<h1>Que voulez-vous commander ?</h1>' + chips + restaurants.map((r) => `
    <a class="card resto" href="#/r/${r.id}">
      ${thumb(r.imageUrl)}
      <div class="grow">
        <div class="row between"><h3>${esc(r.name)}</h3><span class="pill ${r.isOpen ? 'open' : 'closed'}">${r.isOpen ? 'Ouvert' : 'Fermé'}</span></div>
        <p class="muted small">${esc(kindLabel(r.kind))}</p>
        <p class="muted small">${esc(r.description)}</p>
        <p class="muted small">📍 ${esc(r.address)}</p>
      </div>
    </a>`).join('');
}

let lastResto = null;
function restaurantHtml(d) {
  const { restaurant: r, products } = d;
  const inCart = (id) => cart.items.find((i) => i.productId === id)?.quantity || 0;
  const byCat = {};
  products.forEach((p) => { (byCat[p.category] = byCat[p.category] || []).push(p); });
  const menu = Object.entries(byCat).map(([cat, list]) => `<div class="cat">${esc(cat)}</div>` + list.map((p) => {
    const q = inCart(p.id);
    const ctrl = !r.isOpen ? '' : q
      ? `<span class="qty"><button data-act="dec" data-id="${p.id}" aria-label="Retirer">−</button><span>${q}</span><button data-act="inc" data-id="${p.id}" aria-label="Ajouter">+</button></span>`
      : `<button class="btn small" data-act="add" data-id="${p.id}">Ajouter</button>`;
    return `<div class="card prod">${thumb(p.imageUrl)}
      <div class="grow"><h3>${esc(p.name)}</h3><p class="muted small">${esc(p.description)}</p><p class="price">${money(p.price)}</p></div>${ctrl}</div>`;
  }).join('')).join('');
  const bar = cartCount() && cart.restaurantId === r.id
    ? `<a class="btn cartbar" href="#/cart"><span>🛒 Voir mon panier (${cartCount()})</span><span>${money(cartSubtotal())}</span></a>` : '';
  return `<p><a href="#/">← Retour</a></p>
    <div class="card"><div class="hero">${safeImg(r.imageUrl) ? `<img src="${esc(safeImg(r.imageUrl))}" alt="">` : '🍽️'}</div>
    <div class="pad-in" style="padding:.9rem"><div class="row between"><h1 style="margin:0">${esc(r.name)}</h1><span class="pill ${r.isOpen ? 'open' : 'closed'}">${r.isOpen ? 'Ouvert' : 'Fermé'}</span></div>
    <p class="muted">${esc(r.description)}</p><p class="muted small">📍 ${esc(r.address)}</p></div></div>
    ${r.isOpen ? '' : '<div class="notice err">Ce restaurant est fermé pour le moment. Vous pouvez consulter le menu mais pas commander.</div>'}
    ${menu || empty('🍲', 'Ce restaurant n’a pas encore publié son menu.')}${bar}`;
}
async function viewRestaurant(id) {
  lastResto = await api('GET', '/api/restaurants/' + encodeURIComponent(id));
  return restaurantHtml(lastResto);
}
function repaintResto() {
  const y = window.scrollY;
  $('#app').innerHTML = restaurantHtml(lastResto); renderChrome(); window.scrollTo(0, y);
}
function cartAdd(productId) {
  const { restaurant: r, products } = lastResto;
  const p = products.find((x) => x.id === productId);
  if (!p) return;
  if (cart.restaurantId && cart.restaurantId !== r.id && cart.items.length) {
    if (!confirm(`Votre panier contient des produits de « ${cart.restaurantName} ». Le vider pour commander chez « ${r.name} » ?`)) return;
    cart.items = [];
  }
  cart.restaurantId = r.id; cart.restaurantName = r.name;
  const line = cart.items.find((i) => i.productId === p.id);
  if (line) line.quantity = Math.min(50, line.quantity + 1);
  else cart.items.push({ productId: p.id, name: p.name, price: p.price, quantity: 1 });
  saveCart();
}
function cartChange(productId, delta) {
  const line = cart.items.find((i) => i.productId === productId);
  if (!line) return;
  line.quantity = Math.min(50, line.quantity + delta);
  if (line.quantity <= 0) cart.items = cart.items.filter((i) => i !== line);
  if (!cart.items.length) { cart.restaurantId = null; cart.restaurantName = ''; }
  saveCart();
}

function viewCart() {
  if (!cart.items.length) return '<h1>Mon panier</h1>' + empty('🛒', 'Votre panier est vide.<br><br><a class="btn" href="#/">Voir les restaurants</a>');
  const fee = state.config.deliveryFee, sub = cartSubtotal();
  const lines = cart.items.map((i) => `<div class="row between" style="padding:.4rem 0"><div class="grow"><b>${esc(i.name)}</b><div class="muted small">${money(i.price)}</div></div>
    <span class="qty"><button data-act="cdec" data-id="${i.productId}" aria-label="Retirer">−</button><span>${i.quantity}</span><button data-act="cinc" data-id="${i.productId}" aria-label="Ajouter">+</button></span></div>`).join('');
  const d = state.draft;
  let checkout;
  if (!state.user) {
    checkout = '<div class="notice info">Connectez-vous ou créez un compte pour valider votre commande. Votre panier est conservé.</div><a class="btn block" href="#/login">Se connecter</a><p class="center mt"><a href="#/register">Créer un compte client</a></p>';
  } else if (state.user.role !== 'client') {
    checkout = '<div class="notice">Seuls les comptes clients peuvent passer commande.</div>';
  } else {
    checkout = `<form data-form="order">
      <label for="address">Adresse de livraison</label>
      <textarea id="address" name="address" data-draft required minlength="5" maxlength="300" placeholder="Quartier, rue, repère connu (ex. près du marché, portail bleu)">${esc(d.address || '')}</textarea>
      <label for="phone">Téléphone pour le livreur</label>
      <input id="phone" name="phone" type="tel" data-draft required value="${esc(d.phone ?? state.user.phone ?? '')}" placeholder="70 00 00 00">
      <label for="notes">Informations utiles (facultatif)</label>
      <input id="notes" name="notes" data-draft maxlength="500" value="${esc(d.notes || '')}" placeholder="Ex. sans piment, appeler en arrivant">
      <div class="notice info mt">💵 Paiement en espèces à la livraison. Le paiement par Mobile Money n’est pas encore disponible.</div>
      <button class="btn block" type="submit">Envoyer la commande — ${money(sub + fee)}</button></form>`;
  }
  return `<h1>Mon panier</h1><p class="muted">Restaurant : <b>${esc(cart.restaurantName)}</b></p>
    <div class="card pad-in">${lines}<hr style="border:0;border-top:1px solid var(--line)">
    <table class="sum"><tr><td>Sous-total</td><td class="right">${money(sub)}</td></tr>
    <tr><td>Frais de livraison</td><td class="right">${money(fee)}</td></tr>
    <tr class="total"><td>Total</td><td class="right">${money(sub + fee)}</td></tr></table></div>${checkout}`;
}

function orderItemsHtml(o) {
  return `<table class="sum">${o.items.map((i) => `<tr><td>${i.quantity} × ${esc(i.name)}</td><td class="right nowrap">${money(i.quantity * i.unitPrice)}</td></tr>`).join('')}
    <tr><td class="muted">Livraison</td><td class="right muted nowrap">${money(o.deliveryFee)}</td></tr>
    <tr class="total"><td>Total</td><td class="right nowrap">${money(o.total)}</td></tr></table>`;
}

async function viewOrders() {
  if (needLogin('client')) return null;
  const { orders } = await api('GET', '/api/orders');
  startPoll();
  if (!orders.length) return '<h1>Mes commandes</h1>' + empty('📋', 'Vous n’avez pas encore passé de commande.<br><br><a class="btn" href="#/">Commander</a>');
  return '<h1>Mes commandes</h1>' + orders.map((o) => `<a class="card pad-in" href="#/orders/${o.id}">
    <div class="row between"><h3>${esc(o.restaurantName)}</h3>${pill(o.status)}</div>
    <p class="muted small">Commande n° ${o.id} · ${fmtDate(o.createdAt)}</p>
    <div class="row between"><span class="muted small">${o.items.reduce((n, i) => n + i.quantity, 0)} article(s)</span><b>${money(o.total)}</b></div></a>`).join('');
}
async function viewOrder(id) {
  if (needLogin('client')) return null;
  const { order: o } = await api('GET', '/api/orders/' + encodeURIComponent(id));
  if (!['delivered', 'cancelled', 'refused'].includes(o.status)) startPoll();
  const msg = { pending: 'Votre commande a été envoyée. Nous attendons la réponse du restaurant.', accepted: 'Le restaurant a accepté votre commande.',
    preparing: 'Votre repas est en cours de préparation.', ready: 'Votre commande est prête. Elle va être confiée à un livreur.',
    refused: 'Le restaurant n’a pas pu accepter cette commande.', cancelled: 'Cette commande a été annulée.' }[o.status] || '';
  return `<p><a href="#/orders">← Mes commandes</a></p><h1>Commande n° ${o.id}</h1>
    <div class="card pad-in"><div class="row between"><h3>${esc(o.restaurantName)}</h3>${pill(o.status)}</div><p>${esc(msg)}</p>
    <ul class="timeline">${o.events.map((e) => `<li><b>${esc(STATUS[e.status] || e.status)}</b> <span class="muted small">· ${fmtDate(e.at)}</span></li>`).join('')}</ul></div>
    <div class="card pad-in">${orderItemsHtml(o)}</div>
    <div class="card pad-in"><p><b>Livraison :</b> ${esc(o.deliveryAddress)}</p><p><b>Téléphone :</b> ${esc(o.customerPhone)}</p>
    ${o.notes ? `<p><b>Infos :</b> ${esc(o.notes)}</p>` : ''}<p class="muted small">Paiement en espèces à la livraison</p></div>
    ${o.status === 'pending' ? `<button class="btn danger block" data-act="cancel-order" data-id="${o.id}">Annuler la commande</button>` : ''}`;
}

// ================= COMPTES =================
function viewLogin() {
  if (state.user) { location.hash = '#/'; return null; }
  return `<h1>Connexion</h1><form data-form="login">
    <label for="email">Adresse e-mail</label><input id="email" name="email" type="email" required autocomplete="email" autocapitalize="none">
    <label for="password">Mot de passe</label><input id="password" name="password" type="password" required autocomplete="current-password">
    <button class="btn block mt" type="submit">Se connecter</button></form>
    <p class="center mt">Pas encore de compte ?</p>
    <a class="btn alt block" href="#/register">Créer un compte client</a>
    <p class="center mt"><a href="#/register/restaurant">Je suis un commerce : rejoindre First Delivery</a></p>`;
}
function viewRegister(kind) {
  if (state.user) { location.hash = '#/'; return null; }
  const resto = kind === 'restaurant';
  return `<h1>${resto ? 'Inscrire mon commerce' : 'Créer un compte client'}</h1>
    ${resto ? '<div class="notice info">Après votre inscription, l’équipe First Delivery valide votre restaurant avant qu’il soit visible des clients. Vous pouvez préparer votre menu dès maintenant.</div>' : ''}
    <form data-form="register" data-role="${resto ? 'restaurant' : 'client'}">
    ${resto ? `<label for="restaurantKind">Type de commerce</label>
    <select id="restaurantKind" name="restaurantKind">${(state.config.kinds || []).map((k) => `<option value="${esc(k.id)}">${k.icon} ${esc(k.label)}</option>`).join('')}</select>
    <label for="restaurantName">Nom du commerce</label><input id="restaurantName" name="restaurantName" required maxlength="80">
    <label for="restaurantAddress">Adresse du commerce</label><input id="restaurantAddress" name="restaurantAddress" required maxlength="200" placeholder="Ville, secteur, repère">` : ''}
    <label for="name">${resto ? 'Votre nom (responsable)' : 'Votre nom'}</label><input id="name" name="name" required maxlength="80" autocomplete="name">
    <label for="phone">Téléphone${resto ? '' : ' (facultatif)'}</label><input id="phone" name="phone" type="tel" ${resto ? 'required' : ''} autocomplete="tel" placeholder="70 00 00 00">
    <label for="email">Adresse e-mail</label><input id="email" name="email" type="email" required autocomplete="email" autocapitalize="none">
    <label for="password">Mot de passe (8 caractères minimum)</label><input id="password" name="password" type="password" required minlength="8" autocomplete="new-password">
    <button class="btn block mt" type="submit">Créer mon compte</button></form>
    <p class="center mt"><a href="#/login">J’ai déjà un compte</a></p>
    <p class="center"><a href="${resto ? '#/register' : '#/register/restaurant'}">${resto ? 'Je suis un client' : 'Je suis un commerce'}</a></p>`;
}

// ================= RESTAURANT =================
const proTabs = (a) => tabs([['#/pro', 'Commandes', 'orders'], ['#/pro/products', 'Menu', 'products'], ['#/pro/info', 'Mon restaurant', 'info']], a);
function proHeader(r) {
  let n = '';
  if (r.status === 'pending') n = '<div class="notice">⏳ Votre restaurant est en attente de validation par First Delivery. Vous pouvez déjà préparer votre menu : il sera visible des clients après validation.</div>';
  if (r.status === 'rejected') n = '<div class="notice err">Votre demande n’a pas été acceptée. Contactez First Delivery pour en savoir plus.</div>';
  return `<h1>${esc(r.name)}</h1>${n}`;
}
async function proRestaurant() {
  const d = await api('GET', '/api/my/restaurant');
  state.restaurant = d.restaurant; return d.restaurant;
}
function proOrderCard(o) {
  const actions = {
    pending: `<div class="row mt"><button class="btn good grow" data-act="status" data-id="${o.id}" data-status="accepted">Accepter</button><button class="btn danger grow" data-act="status" data-id="${o.id}" data-status="refused" data-confirm="Refuser cette commande ?">Refuser</button></div>`,
    accepted: `<button class="btn block mt" data-act="status" data-id="${o.id}" data-status="preparing">Commencer la préparation</button>`,
    preparing: `<button class="btn good block mt" data-act="status" data-id="${o.id}" data-status="ready">Commande prête à récupérer</button>`,
    ready: '<p class="notice ok">Prête. En attente d’un livreur (bientôt disponible dans l’application).</p>',
  }[o.status] || '';
  return `<div class="card pad-in"><div class="row between"><h3>Commande n° ${o.id}</h3>${pill(o.status)}</div>
    <p class="muted small">${fmtDate(o.createdAt)} · ${esc(o.customerName)} · <a href="tel:${esc(o.customerPhone)}">${esc(o.customerPhone)}</a></p>
    ${orderItemsHtml(o)}${o.notes ? `<p class="small"><b>Infos client :</b> ${esc(o.notes)}</p>` : ''}
    <p class="small muted">📍 ${esc(o.deliveryAddress)}</p>${actions}</div>`;
}
async function viewProOrders() {
  if (needLogin('restaurant')) return null;
  const r = await proRestaurant();
  const { orders } = await api('GET', '/api/orders');
  state.pending = orders.filter((o) => o.status === 'pending').length;
  startPoll();
  const open = orders.filter((o) => ['pending', 'accepted', 'preparing', 'ready'].includes(o.status));
  const done = orders.filter((o) => !open.includes(o));
  return proHeader(r) + proTabs('orders') + '<h2 style="margin-top:0">À traiter</h2>'
    + (open.length ? open.map(proOrderCard).join('') : empty('📋', 'Aucune commande en cours. Cette page se met à jour toute seule.'))
    + (done.length ? '<h2>Terminées</h2>' + done.slice(0, 15).map((o) => `<div class="card pad-in"><div class="row between"><b>Commande n° ${o.id}</b>${pill(o.status)}</div><p class="muted small">${fmtDate(o.createdAt)} · ${esc(o.customerName)} · ${money(o.total)}</p></div>`).join('') : '');
}
async function viewProProducts() {
  if (needLogin('restaurant')) return null;
  const r = await proRestaurant();
  const { products } = await api('GET', '/api/my/products');
  return proHeader(r) + proTabs('products') + '<a class="btn block" href="#/pro/products/new">+ Ajouter un produit</a><div class="mt"></div>'
    + (products.length ? products.map((p) => `<a class="card prod" href="#/pro/products/${p.id}">${thumb(p.imageUrl)}
      <div class="grow"><h3>${esc(p.name)}</h3><p class="muted small">${esc(p.category)}</p><p class="price">${money(p.price)}</p></div>
      <span class="pill ${p.available ? 'open' : 'closed'}">${p.available ? 'Disponible' : 'Masqué'}</span></a>`).join('')
      : empty('🍲', 'Votre menu est vide. Ajoutez votre premier produit.'));
}
const photoField = (url) => `<label>Photo</label><input type="file" accept="image/*" data-photo>
  <input type="hidden" name="imageUrl" value="${esc(url || '')}">
  <img class="photo-prev" id="photo-prev" alt="" ${safeImg(url) ? `src="${esc(safeImg(url))}"` : 'hidden'}>
  <div class="hint">La photo est réduite automatiquement avant l’envoi.</div>`;
async function viewProProductForm(id) {
  if (needLogin('restaurant')) return null;
  const { products } = await api('GET', '/api/my/products');
  const p = id === 'new' ? { name: '', description: '', price: '', category: '', imageUrl: '', available: true } : products.find((x) => String(x.id) === id);
  if (!p) return empty('❓', 'Produit introuvable.');
  const cats = [...new Set(products.map((x) => x.category))];
  return `<p><a href="#/pro/products">← Menu</a></p><h1>${id === 'new' ? 'Nouveau produit' : 'Modifier le produit'}</h1>
    <form data-form="product" data-id="${id === 'new' ? '' : p.id}">
    <label for="name">Nom</label><input id="name" name="name" required minlength="2" maxlength="80" value="${esc(p.name)}">
    <label for="description">Description</label><textarea id="description" name="description" maxlength="300">${esc(p.description)}</textarea>
    <label for="price">Prix (FCFA)</label><input id="price" name="price" type="number" inputmode="numeric" min="0" step="1" required value="${esc(p.price)}">
    <label for="category">Catégorie</label><input id="category" name="category" list="cats" required maxlength="40" placeholder="Plats, Boissons, Desserts…" value="${esc(p.category)}">
    <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${photoField(p.imageUrl)}
    <label class="check mt"><input type="checkbox" name="available" ${p.available ? 'checked' : ''}> Disponible à la commande</label>
    <button class="btn block mt" type="submit">Enregistrer</button></form>
    ${id === 'new' ? '' : `<button class="btn ghost block mt" data-act="del-product" data-id="${p.id}" data-confirm="Supprimer définitivement « ${esc(p.name).replace(/"/g, '')} » ?">Supprimer ce produit</button>`}`;
}
async function viewProInfo() {
  if (needLogin('restaurant')) return null;
  const r = await proRestaurant();
  return proHeader(r) + proTabs('info') + `<form data-form="resto">
    <label for="name">Nom du restaurant</label><input id="name" name="name" required minlength="2" maxlength="80" value="${esc(r.name)}">
    <label for="description">Description</label><textarea id="description" name="description" maxlength="500">${esc(r.description)}</textarea>
    <label for="address">Adresse</label><input id="address" name="address" required minlength="5" maxlength="200" value="${esc(r.address)}">
    <label for="phone">Téléphone</label><input id="phone" name="phone" type="tel" value="${esc(r.phone)}">
    ${photoField(r.imageUrl)}
    <label class="check mt"><input type="checkbox" name="isOpen" ${r.isOpen ? 'checked' : ''}> Ouvert aux commandes</label>
    <div class="hint">Décochez cette case pour ne plus recevoir de commandes (fermeture, rupture…).</div>
    <button class="btn block mt" type="submit">Enregistrer</button></form>`;
}

// ================= ADMINISTRATEUR =================
const adminTabs = (a) => tabs([['#/admin', 'Tableau de bord', 'dash'], ['#/admin/restaurants', 'Restaurants', 'restos'], ['#/admin/orders', 'Commandes', 'orders']], a);
async function viewAdmin(sub) {
  if (needLogin('admin')) return null;
  if (sub === 'restaurants') {
    const { restaurants } = await api('GET', '/api/admin/restaurants');
    return '<h1>Restaurants</h1>' + adminTabs('restos') + restaurants.map((r) => `<div class="card pad-in">
      <div class="row between"><h3>${esc(r.name)}</h3><span class="pill ${r.status}">${{ pending: 'À valider', approved: 'Validé', rejected: 'Refusé' }[r.status]}</span></div>
      <p class="muted small">${esc(r.address)} · ${esc(r.ownerName)} (${esc(r.ownerEmail)})${r.isDemo ? ' · <b>démo</b>' : ''}</p>
      <div class="row mt">${r.status !== 'approved' ? `<button class="btn good small grow" data-act="resto-status" data-id="${r.id}" data-status="approved">Valider</button>` : ''}
      ${r.status !== 'rejected' ? `<button class="btn danger small grow" data-act="resto-status" data-id="${r.id}" data-status="rejected" data-confirm="Refuser ce restaurant ?">Refuser</button>` : ''}</div></div>`).join('');
  }
  if (sub === 'orders') {
    const { orders } = await api('GET', '/api/orders');
    startPoll();
    return '<h1>Commandes</h1>' + adminTabs('orders') + (orders.length ? orders.map((o) => `<div class="card pad-in">
      <div class="row between"><h3>n° ${o.id} · ${esc(o.restaurantName)}</h3>${pill(o.status)}</div>
      <p class="muted small">${fmtDate(o.createdAt)} · ${esc(o.customerName)} · ${money(o.total)} (commission ${money(o.commissionAmount)})</p>
      ${['pending', 'accepted', 'preparing', 'ready'].includes(o.status) ? `<button class="btn ghost small" data-act="status" data-id="${o.id}" data-status="cancelled" data-confirm="Annuler cette commande ?">Annuler la commande</button>` : ''}</div>`).join('')
      : empty('📋', 'Aucune commande pour le moment.'));
  }
  const s = await api('GET', '/api/admin/stats');
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  return '<h1>Tableau de bord</h1>' + adminTabs('dash') + `<div class="stats">
    <div class="stat"><b>${s.users.client || 0}</b>clients</div><div class="stat"><b>${s.restaurants.approved || 0}</b>restaurants validés</div>
    <div class="stat"><b>${s.restaurants.pending || 0}</b>à valider</div><div class="stat"><b>${sum(s.orders)}</b>commandes</div>
    <div class="stat"><b>${s.orders.pending || 0}</b>en attente</div><div class="stat"><b>${s.orders.delivered || 0}</b>livrées</div></div>
    <div class="card pad-in"><p>Chiffre d’affaires des commandes livrées : <b>${money(s.deliveredGross)}</b></p>
    <p>Commissions de la plateforme : <b>${money(s.deliveredCommission)}</b></p>
    <p class="muted small">Les commandes ne peuvent pas encore passer à « livrée » : cela viendra avec l’espace livreur (Phase 2).</p></div>`;
}

// ================= ROUTEUR =================
let renderId = 0, pollTimer = null;
function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden) render(true); }, 10000);
}
async function render(silent) {
  const my = ++renderId;
  if (!silent) clearInterval(pollTimer);
  const [a, b, c] = (location.hash.slice(2) || '').split('/').filter(Boolean).map(decodeURIComponent);
  const y = window.scrollY;
  let html;
  try {
    if (!a) html = await viewHome();
    else if (a === 'r' && b) html = await viewRestaurant(b);
    else if (a === 'cart') html = viewCart();
    else if (a === 'orders') html = b ? await viewOrder(b) : await viewOrders();
    else if (a === 'login') html = viewLogin();
    else if (a === 'register') html = viewRegister(b);
    else if (a === 'pro' && b === 'products') html = c ? await viewProProductForm(c) : await viewProProducts();
    else if (a === 'pro' && b === 'info') html = await viewProInfo();
    else if (a === 'pro') html = await viewProOrders();
    else if (a === 'admin') html = await viewAdmin(b);
    else html = empty('❓', 'Page introuvable.<br><br><a class="btn" href="#/">Accueil</a>');
  } catch (e) {
    if (e.status === 401) { state.user = null; state.nextHash = location.hash; location.hash = '#/login'; return; }
    html = silent ? null : `<div class="notice err">${esc(e.message)}</div><button class="btn" data-act="reload">Réessayer</button>`;
  }
  if (my !== renderId || html === null || html === undefined) { if (my === renderId) renderChrome(); return; }
  if (silent && document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  $('#app').innerHTML = html;
  renderChrome();
  window.scrollTo(0, silent ? y : 0);
}

// ================= ACTIONS =================
async function resizeImage(file, max = 1000) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise((ok, ko) => cv.toBlob((b) => (b ? ok(b) : ko(new Error('Photo illisible'))), 'image/jpeg', 0.85));
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = Number(el.dataset.id);
  if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
  try {
    if (act === 'logout') { await api('POST', '/api/auth/logout', {}); state.user = null; state.restaurant = null; location.hash = '#/'; await render(); }
    else if (act === 'reload') { location.reload(); }
    else if (act === 'kind') { ev.preventDefault(); state.kind = el.dataset.kind; await render(); }
    else if (act === 'add') { cartAdd(id); repaintResto(); }
    else if (act === 'inc') { cartChange(id, 1); repaintResto(); }
    else if (act === 'dec') { cartChange(id, -1); repaintResto(); }
    else if (act === 'cinc' || act === 'cdec') { cartChange(id, act === 'cinc' ? 1 : -1); await render(); }
    else if (act === 'cancel-order') {
      if (!confirm('Annuler cette commande ?')) return;
      await api('POST', `/api/orders/${id}/status`, { status: 'cancelled' }); toast('Commande annulée'); await render();
    } else if (act === 'status') { await api('POST', `/api/orders/${id}/status`, { status: el.dataset.status }); toast('Statut mis à jour'); await render(); }
    else if (act === 'del-product') { await api('DELETE', `/api/my/products/${id}`); toast('Produit supprimé'); location.hash = '#/pro/products'; }
    else if (act === 'resto-status') { await api('POST', `/api/admin/restaurants/${id}/status`, { status: el.dataset.status }); toast('Enregistré'); await render(); }
  } catch (e) { toast(e.message, true); await render(); }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset && 'draft' in t.dataset) state.draft[t.name] = t.value;
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (!t.matches || !t.matches('input[data-photo]') || !t.files[0]) return;
  try {
    toast('Envoi de la photo…');
    const blob = await resizeImage(t.files[0]);
    const res = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'image/jpeg' }, body: blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Échec de l’envoi de la photo');
    t.form.elements.imageUrl.value = data.url;
    const prev = $('#photo-prev'); prev.src = data.url; prev.hidden = false;
    toast('Photo ajoutée ✓');
  } catch (e) { toast(e.message || 'Photo illisible', true); }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  const data = Object.fromEntries(new FormData(form));
  btn.disabled = true;
  try {
    switch (form.dataset.form) {
      case 'login': case 'register': {
        const body = form.dataset.form === 'register' ? { ...data, role: form.dataset.role } : data;
        await api('POST', '/api/auth/' + form.dataset.form, body);
        await refreshMe();
        const next = state.nextHash; state.nextHash = null;
        toast(form.dataset.form === 'register' ? 'Compte créé. Bienvenue !' : 'Connecté');
        location.hash = next && next !== '#/login' && !next.startsWith('#/register') ? next : '#/';
        await render();
        break;
      }
      case 'order': {
        const { order } = await api('POST', '/api/orders', {
          restaurantId: cart.restaurantId, address: data.address, phone: data.phone, notes: data.notes,
          items: cart.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        });
        cart = { restaurantId: null, restaurantName: '', items: [] }; saveCart(); state.draft = { phone: data.phone };
        toast('Commande envoyée au restaurant ✓');
        location.hash = '#/orders/' + order.id;
        break;
      }
      case 'product': {
        const body = { name: data.name, description: data.description, price: data.price, category: data.category, imageUrl: data.imageUrl, available: !!form.elements.available.checked };
        if (form.dataset.id) await api('PUT', '/api/my/products/' + form.dataset.id, body); else await api('POST', '/api/my/products', body);
        toast('Produit enregistré ✓'); location.hash = '#/pro/products';
        break;
      }
      case 'resto': {
        await api('PUT', '/api/my/restaurant', { ...data, isOpen: !!form.elements.isOpen.checked });
        toast('Informations enregistrées ✓'); await render();
        break;
      }
    }
  } catch (e) { toast(e.message, true); btn.disabled = false; }
});

window.addEventListener('hashchange', () => render());

(async function boot() {
  try {
    const [, cfg] = await Promise.all([refreshMe(), api('GET', '/api/config')]);
    state.config = cfg;
  } catch (e) { /* le serveur est peut-être hors ligne : render() affichera l'erreur */ }
  await render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
