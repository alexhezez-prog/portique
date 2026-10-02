# Le Portique

*Le Portique (Stoa) d'Athènes, où Zénon enseignait, a donné son nom au stoïcisme.*

Révision de cours pour lycéens. L'élève photographie son cours ; l'application en tire une fiche flash, un test en trois paliers corrigé par Claude et un bilan de ses notions fragiles.

## Parcours

1. **Analyse** : les photos (1 à 4 pages) sont transcrites et découpées en notions clés. L'élève vérifie le niveau (seconde, première, terminale) et décoche les notions qu'il ne veut pas travailler.
2. **Fiche flash** : l'essentiel du chapitre, des blocs courts par notion (définitions, formules, dates, méthodes), les pièges classiques.
3. **Test en trois paliers**, préparés en parallèle pendant la lecture de la fiche :
   - QCM de connaissances ;
   - questions rédigées notées sur 3 (un point par critère), réponse tapée ou en photo ;
   - exercice type contrôle ou bac, adapté à la matière (problème, analyse de document, question de méthode), copie tapée ou photographiée.
4. **Bilan par notion** : maîtrisée (≥ 75 %), à consolider (≥ 50 %), fragile. « Retravailler mes points faibles » relance des questions nouvelles sur ces seules notions, avec comparaison avant/après.

Les photos ne sont envoyées qu'une fois : les étapes suivantes travaillent sur la transcription. Une séance interrompue peut être reprise depuis l'accueil ; aucun historique n'est conservé d'une séance à l'autre. Formules rendues avec KaTeX.

## Carte mentale

Générée avec la fiche (même appel) : le sujet au centre, une branche par notion, deux à quatre idées clés par branche.
- Dans la fiche : onglet **Carte mentale**, avec une vue **Arbre** lisible sur téléphone et une vue **Carte** (radiale, avec zoom).
- Dans le bilan : la même carte, chaque branche colorée selon la maîtrise (vert, orange, rouge) avec son pourcentage.

## Consultation pendant la correction

Après chaque correction (réponse au QCM, note d'une question rédigée, note de l'exercice), deux boutons **Fiche flash** et **Carte mentale** ouvrent un panneau par-dessus le test ; « Reprendre » ramène exactement au même endroit. Ils n'apparaissent pas avant la réponse.

## Impression du bilan

Bouton **Imprimer** dans le bilan. On choisit les sections, puis l'aperçu d'impression du téléphone ou de l'ordinateur permet d'imprimer ou d'enregistrer un PDF :
- page de bilan (score global, scores par palier, maîtrise par notion, appréciation de l'exercice) ;
- erreurs à revoir (question, bonne réponse ou corrigé) ;
- carte mentale colorée, sur une page paysage ;
- fiche flash.

Mise en page A4 claire, indépendante du thème sombre de l'écran.

## Architecture

```
Téléphone ──► index.html (GitHub Pages, public)
                  │  photos compressées / réponses + code d'accès
                  ▼
            worker.js (Cloudflare Worker « portique »)
                  │  clé API secrète
                  ▼
            API Claude (Anthropic) ──► JSON
```

## Mise en ligne

### 1. Clé API Anthropic
Sur <https://console.anthropic.com> : **API Keys > Create Key**. Une clé dédiée à Le Portique permet de suivre sa consommation séparément. **Settings > Limits** : fixer un plafond mensuel.

### 2. Worker Cloudflare
1. **Workers & Pages > Create > Create Worker**, nom `portique`, puis **Deploy**.
2. **Edit code** : remplacer tout le contenu par `worker.js`, puis **Deploy**.
3. **Settings > Variables and Secrets** :
   | Nom | Type | Valeur |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Secret | la clé `sk-ant-…` |
   | `ACCESS_CODE` | Secret | un code d'accès propre à Le Portique |
   | `ALLOWED_ORIGIN` | Text | `https://alexhezez-prog.github.io` |
4. Adresse du Worker : `https://portique.alexhezez.workers.dev` (déjà inscrite dans `index.html`, constante `DEFAULT_WORKER_URL`).

### 3. Site GitHub Pages
1. Nouveau dépôt **public** `portique`, y déposer `index.html`, `worker.js`, `wrangler.toml`, `icon-180.png`, `README.md`, `.gitignore`.
2. **Settings > Pages** : *Deploy from a branch*, `main`, `/ (root)`.
3. Site : `https://alexhezez-prog.github.io/portique/`.

### 4. Activer un appareil (une fois)
Ouvrir dans Safari `https://alexhezez-prog.github.io/portique/#cle=VOTRE-CODE`, puis **Partager > Sur l'écran d'accueil**. Le code reste sur l'appareil, jamais dans le code public.

Démonstration sans appel à l'IA : `https://alexhezez-prog.github.io/portique/#demo`.

## Réglages
En haut du script de `index.html` : `SIZES` (nombre de questions par palier), `SEUIL_MAITRISE` et `SEUIL_FRAGILE` (seuils du bilan). Dans Cloudflare, la variable `MODEL` change le modèle (défaut `claude-sonnet-5-5`, avec repli automatique si le modèle est refusé).

## Coût
Une séance complète représente environ 7 à 13 appels : 1 analyse avec photos, 4 générations sur texte, 1 correction par question rédigée, 1 pour l'exercice. Tarifs en vigueur : <https://www.anthropic.com/pricing>. Le plafond de la console limite la dépense.

## Confidentialité
- Dépôt et site publics : aucune photo de cours ou de copie dans le dépôt (le `.gitignore` les bloque).
- La clé API n'existe que dans Cloudflare ; le code d'accès empêche un tiers d'utiliser le relais.
- Les photos transitent vers l'API puis sont oubliées ; rien n'est stocké côté serveur.
