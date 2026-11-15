# Visual Crossing pour Gladys

Connecteur **non officiel**, sans lien avec Visual Crossing Corporation. Il fait de **Visual Crossing** le
fournisseur météo de Gladys : conditions actuelles, prévisions sur 24 heures et 8 jours (Visual Crossing en donne
15, Gladys en garde 8), et les alertes en cours du lieu. Le widget météo, l'assistant et les déclencheurs de scène
d'alerte météo de Gladys s'en servent directement.

> Cette intégration n'a **jamais été testée avec un vrai compte** : elle est écrite d'après la documentation
> officielle de la Timeline Weather API de Visual Crossing. Les retours sont les bienvenus.

## Ce qu'il faut

- Votre propre compte Visual Crossing et sa **clé API** (inscription sur
  [visualcrossing.com](https://www.visualcrossing.com/sign-up), la clé est sur la page _Account_).
- Gladys 5.1 ou plus récent.

## Coûts

Visual Crossing compte des **enregistrements** (records). Une requête de prévision (celle qu'envoie cette
intégration) coûte **1 enregistrement**, quels que soient ses jours, ses heures et ses alertes ; l'intégration lit
le `queryCost` de chaque réponse et le compte.

- **Offre gratuite** : **1 000 enregistrements par jour**. Au-delà, Visual Crossing répond 429 jusqu'au lendemain.
- **Offre à l'usage** (pay-as-you-go) : les enregistrements au-delà des gratuits sont **facturés** par Visual
  Crossing (**0,0001 USD** l'enregistrement au moment de l'écriture, voir
  [les offres](https://www.visualcrossing.com/weather-data-editions)).
- Autres offres : voir votre compte.

L'intégration a son propre **plafond quotidien** (500 enregistrements par défaut), compté **avant** chaque appel et
gardé dans `/data` au redémarrage : atteint, plus rien n'est envoyé avant minuit UTC. Un appel qui a pu être
facturé n'est **pas réessayé** : après un délai dépassé, une erreur réseau ou une 5xx, le lieu attend 15 minutes ;
après une 401, la clé n'est plus utilisée. Avec la lecture par défaut toutes les 60 minutes, un lieu coûte au plus
24 enregistrements par jour.

## Configuration

| Champ                 | Rôle                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clé API               | Gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à Visual Crossing. Elle n'apparaît ni dans les journaux, ni dans le statut, ni dans les erreurs, ni dans `/data`. |
| Alertes météo         | Actives par défaut. Même coût (les alertes arrivent dans la même réponse).                                                                                                             |
| Intervalle de lecture | 60 minutes par défaut (60 à 180). Un lieu est lu chez Visual Crossing au plus une fois par intervalle ; Gladys reçoit la copie gardée entre-temps.                                     |
| Plafond quotidien     | 500 enregistrements par défaut (10 à 100 000), par jour UTC. Visual Crossing compte tous les usages de votre clé dans le même compte : gardez de la marge pour vos autres usages.      |

**Tester Visual Crossing** fait un appel (les conditions actuelles à Greenwich, 1 enregistrement, aucune donnée
personnelle) : il indique si la clé est acceptée et les enregistrements comptés aujourd'hui. Il fonctionne au plus
une fois par minute, ni pendant une pause demandée par Visual Crossing, ni une fois le plafond atteint.

## Rythme, pauses et erreurs

- Gladys demande la météo quand un tableau de bord l'affiche, quand l'assistant répond, et toutes les 30 minutes
  pour les alertes. L'intégration répond avec sa copie tant qu'elle est plus récente que l'intervalle.
- Un seul appel à la fois vers Visual Crossing, quel que soit le nombre de lieux.
- **HTTP 429** : pause aussi longue que le dit `Retry-After` (comparé à l'en-tête `Date` du serveur), entre 60 s
  et 6 heures ; sans l'en-tête, 60 s puis doublée jusqu'à 6 heures.
- **Délai dépassé (10 s), erreur réseau, erreur serveur, 403, réponse illisible ou trop grosse (plus de 1 Mo)** :
  pause de 60 s pour tous les lieux, doublée à chaque échec jusqu'à 1 heure, et **ce lieu** n'est pas redemandé
  avant 15 minutes (l'appel en échec a pu être facturé).
- **HTTP 400 ou 404** : le lieu n'est pas servi ; seul ce lieu est retenu pendant un intervalle de lecture.
- Gladys attend 15 s une réponse : un appel qui ne peut pas finir à temps ne part pas.
- Si le comptage d'un appel ne peut pas être écrit dans `/data` en 1 s, l'appel ne part pas (le plafond doit
  survivre à un redémarrage).
- Pendant une pause ou une panne, Gladys reçoit la dernière copie si elle a moins de 4 heures, avec sa propre date
  (jamais présentée comme neuve) ; sinon une erreur, et Gladys passe à son fournisseur suivant.
- La pause, les lieux retenus, le compteur et les copies sont gardés dans `/data` : un redémarrage ou une
  reconnexion ne déclenchent pas d'appel. Une configuration enregistrée demande à Gladys de relire la météo, servie
  par la copie tant qu'elle est plus récente que l'intervalle.

## Clé refusée

Un **HTTP 401** est un refus de la clé (Visual Crossing : problème de clé, de compte ou d'abonnement) : plus aucune
requête ne part avec elle, et elle n'est pas réessayée. `/data` ne garde qu'**un octet** d'une empreinte salée de
la clé : rien qui permette de vérifier une supposition (une sur 256 correspond). Enregistrer une autre clé pendant
que l'intégration tourne lève le refus aussitôt. Après un redémarrage, seul cet octet est connu : une nouvelle clé
dont l'octet tombe pareil (1 chance sur 256) reste retenue jusqu'à un succès de **Tester Visual Crossing**, qui
essaie même une clé refusée. Un 403 n'est pas pris pour un refus (il peut venir d'un proxy ou d'un pare-feu) : il met
en pause.

## Ce qui est envoyé à Visual Crossing

Les coordonnées de la maison arrondies à 3 décimales (environ 100 m) et la clé API (dans l'adresse de la requête,
comme Visual Crossing le demande ; cette adresse n'est jamais journalisée). Ni la langue ni le système d'unités ne
sont envoyés : la réponse est demandée en métrique et convertie ici, un seul appel sert donc tous les
utilisateurs. `/data/state.json` contient le compteur du jour, la pause, les lieux retenus, un octet marquant une
clé refusée, et les dernières réponses. Les réponses ne contiennent pas de coordonnées, mais chacune est rangée
sous une empreinte salée du lieu arrondi : avec le sel à côté, le lieu peut être retrouvé par force brute.
`/data` reste sur votre Gladys.

## Correspondances

| Icône Visual Crossing (jeu icons2)      | Gladys                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| clear-day, clear-night                  | clear                                                                         |
| partly-cloudy-day/night / cloudy        | partly-cloudy / cloud                                                         |
| fog / wind                              | fog / wind                                                                    |
| rain, showers-day/night                 | rain ; pouring dès 7,6 mm en une heure ; freezing-rain ou sleet selon le type |
| snow, snow-showers-day/night            | snow ; sleet quand pluie ou glace s'y mêlent                                  |
| thunder-rain, thunder-showers-day/night | thunderstorm (snow-thunderstorm avec neige seule)                             |
| toute autre icône                       | unknown                                                                       |

Le jour ou la nuit viennent des heures de lever et de coucher du soleil, sinon de l'icône (`-day`/`-night`).
Unités : le métrique est converti en m/s (vent) et km, ou en °F, mph, pouces et miles (US) ; la pression reste en
hPa ; humidité, couverture nuageuse et probabilité de précipitation en pourcentage. Une valeur absente reste
absente, jamais 0.

Alertes : Visual Crossing ne donne pas de niveau. Il est lu dans le titre : rouge ou extrême → extreme ; jaune,
modéré ou « watch » → moderate ; orange, sévère ou « warning » → severe ; sinon → minor (l'alerte est gardée). Le
phénomène (orage, vent, neige...) est lu dans le titre en anglais, français, allemand ou espagnol. Les alertes
terminées selon l'horloge du serveur sont retirées.

## Attribution

Données météo fournies par Visual Crossing (<https://www.visualcrossing.com/>). Le widget météo de Gladys ne peut
pas encore afficher d'attribution : elle figure sur l'écran de configuration et ici.

## Statuts

- « Saisissez la clé API... » : rien n'est configuré.
- « Configuration invalide : ... » : nomme les champs erronés (jamais leur valeur) ; rien n'est envoyé.
- « Prêt », puis « Visual Crossing répond ».
- « Visual Crossing a refusé cette clé API... », « a demandé de ralentir... », « n'a pas répondu correctement... »,
  « Plafond quotidien atteint... ».
- « /data/state.json est illisible » : relu toutes les 10 s, rien n'est envoyé en attendant (un fichier illisible
  n'est pas pris pour vide).
- « La configuration n'a pas pu être lue » : nouvel essai après 5 s, puis doublé jusqu'à 5 minutes.
