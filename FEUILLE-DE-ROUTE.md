# First Delivery — feuille de route

Document de référence : ce que veut le propriétaire du projet et où nous en sommes.
Mis à jour le 10 octobre 2026.

## Vision

First Delivery n'est pas qu'une application de repas : c'est une **plateforme de livraison pour plusieurs types de marchands**.

- **Marchands** : restaurants (déjà fait), **produits du quotidien** (épiceries, supermarchés…), **autres catégories** à définir. Les catégories doivent pouvoir être créées et modifiées par l'administrateur, sans toucher au code.
- **Clients** : parcourent les catégories et les marchands, commandent, **suivent leur commande et le livreur en temps réel sur une carte**.
- **Marchands** : gèrent leur boutique (produits, catégories, photos, prix), reçoivent et préparent les commandes.
- **Livreurs** : reçoivent des missions, récupèrent chez le marchand, livrent au client, partagent leur position.
- **Entreprises de livraison partenaires** : contrat avec First Delivery ; reçoivent des missions et affectent leurs propres livreurs.
- **Administrateur (le propriétaire)** : gère tout — marchands, catégories, clients, livreurs, entreprises partenaires, commandes, commissions.

## Règle de livraison (décision du propriétaire)

Pour chaque commande acceptée, le marchand indique **une** option :

1. **« J'ai un livreur »** : le marchand livre avec son propre livreur (ou le client vient chercher).
2. **« Je n'ai pas de livreur en ce moment »** : la demande est signalée à l'administrateur, qui contacte l'entreprise de livraison partenaire ; celle-ci affecte un livreur qui récupère la commande chez le marchand et la livre au client.

Statuts à prévoir en plus de l'existant : *livreur demandé*, *livreur affecté*, *récupérée*, *en livraison*, *livrée*.

## État actuel (Phase 1 — terminée et en ligne en version de test)

Comptes (client / restaurant / administrateur), restaurants et menus avec photos, panier, commandes enregistrées, suivi du statut, annulation, espace restaurant (produits, catégories de produits, acceptation/refus, préparation), validation des restaurants par l'administrateur, application web installable. 38 tests automatiques.

## À faire, dans l'ordre proposé

1. **Demain (avec un ordinateur)** — fondations
   - Hébergement durable (Render payant ≈ 7 $/mois + disque 0,25 $/Go) : sans cela, les données disparaissent.
   - Créer les comptes développeur **Apple** et **Google** tôt (la vérification d'Apple peut prendre plusieurs jours).
   - Corriger l'affichage des restaurants de démonstration sur la version en ligne (variable `DEMO_DATA=1`).
2. **Marchands multi-catégories** : types de marchands (restaurant, produits du quotidien, autres), catégories gérées par l'administrateur, page d'accueil par catégorie, renommer « restaurant » en « marchand » dans l'interface.
3. **Phase 2 — livraison** : espace livreur, espace entreprise partenaire, option « j'ai un livreur / je n'ai pas de livreur », file de demandes pour l'administrateur, affectation, statuts de livraison.
4. **Phase 3 — administration complète** : gestion des utilisateurs, marchands, partenaires, catégories ; calcul et suivi des commissions ; paiement Mobile Money.
5. **Phase 4 — GPS et cartes** : position du livreur en temps réel, carte côté client, itinéraire.
6. **Publication App Store / Play Store.**

## Points techniques à décider

- **GPS en temps réel** : un site web ne suit pas fiablement la position quand l'écran est éteint. L'application **livreur** devra donc être une vraie application (Android et iPhone) avec autorisation de localisation en arrière-plan. C'est une raison de plus de passer par les boutiques.
- **Adresses** : au Burkina Faso, beaucoup d'adresses ne sont pas des adresses officielles. Prévoir que le client **place un repère sur la carte** (en plus du texte) pour que le livreur trouve.
- **Cartes** : fournisseur à choisir (OpenStreetMap, gratuit, ou Google Maps, payant).
- **Applications** : une seule application avec connexion par rôle (client, marchand, livreur), ou une application « First Delivery Pro » séparée pour les marchands et livreurs ? À décider.
- **Suivi en direct** : aujourd'hui l'écran se rafraîchit toutes les 10 secondes ; passer aux notifications instantanées avec les applications.
- **Règles locales** : certaines catégories (médicaments, alcool…) peuvent demander des règles particulières. À vérifier avant de les ouvrir.
- **Apple** : politique de confidentialité en ligne, suppression de compte depuis l'application, fonctions propres au téléphone (notifications, localisation) pour ne pas être refusée comme simple site emballé.
