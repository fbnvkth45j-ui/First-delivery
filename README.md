# First Delivery

Application de commande et de livraison de repas (Burkina Faso).
**Phase 1 terminée** : restaurants, menus, photos, panier, commandes enregistrées en base, espace restaurant, validation par l'administrateur.

## Lancer l'application sur un ordinateur

1. Installer **Node.js version 22 ou plus récente** (gratuit) : https://nodejs.org
2. Ouvrir un terminal dans le dossier `first-delivery`, puis :

```
node server.js
```

3. Ouvrir http://localhost:3000 dans le navigateur.

Au premier démarrage, le terminal affiche le **compte administrateur** (e-mail + mot de passe généré). Notez-le : il ne sera plus affiché.
Aucune installation de bibliothèque n'est nécessaire.

## Comptes de démonstration (tests uniquement)

| Rôle | E-mail | Mot de passe |
|---|---|---|
| Restaurant | demo.awa@firstdelivery.local | demo1234 |
| Restaurant | demo.burger@firstdelivery.local | demo1234 |

Les clients s'inscrivent eux-mêmes. Les restaurants de démo sont créés par défaut sur un ordinateur de test. En mode production (`NODE_ENV=production`, par exemple chez Render) ils sont **absents**, sauf si vous ajoutez `DEMO_DATA=1` pendant la période de test. `DEMO_DATA=0` les désactive toujours. **Retirez `DEMO_DATA` avant l'ouverture aux vrais clients** : leur mot de passe est public.

## Réglages (variables d'environnement)

| Nom | Rôle | Valeur par défaut |
|---|---|---|
| `PORT` | port du serveur | 3000 |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | compte administrateur au premier démarrage | e-mail par défaut + mot de passe généré |
| `DELIVERY_FEE` | frais de livraison (FCFA) | 500 (provisoire) |
| `COMMISSION_RATE` | commission de la plateforme | 0.15 = 15 % (provisoire) |
| `DB_PATH`, `UPLOAD_DIR` | emplacement de la base et des photos | dossier `data/` |
| `NODE_ENV=production` | mode réel (cookies sécurisés, pas de données démo) | — |

Les frais et la commission ci-dessus sont des valeurs de test : à fixer avant le lancement commercial.

## Vérifier que tout fonctionne

```
node test.js
```

Joue le parcours complet (compte, commande, restaurant, sécurité) sur une base temporaire.

## Sur téléphone

C'est une application web installable (PWA) : une fois le serveur accessible en ligne en HTTPS, ouvrez-le avec Chrome (Android) ou Safari (iPhone) puis « Ajouter à l'écran d'accueil ». Elle s'ouvre alors en plein écran avec son icône, comme une application.

## Ce qui n'est pas encore fait

- Espace livreur et entreprise partenaire, attribution des commandes (Phase 2) : statuts « en livraison » et « livrée » à venir.
- Paiement : uniquement espèces à la livraison. Mobile Money à intégrer (Phase 3).
- Espace administrateur : validation des restaurants, commandes et statistiques de base. Gestion complète des utilisateurs et des commissions en Phase 3.
- GPS et cartes (Phase 4).
- Pas de récupération de mot de passe oublié pour l'instant.
