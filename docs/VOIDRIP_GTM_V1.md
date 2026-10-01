# VOIDRIP GTM SYSTEM V1 — guide actif

Ce document décrit le chemin actif du moteur. Les guides Max/Overloop hérités du repo amont sont conservés comme références techniques, mais ne gouvernent pas VOIDRIP V1.

## Chemin actif

```text
Market Intelligence
→ GTM Boundary
→ Market Mapping & Sourcing
→ Qualification Codex
→ Intent / Signals
→ Buffer de revue humaine
→ accord d’import
→ liste HeyReach
→ accord de lancement distinct
→ Results / Replies / Scan / Sales
→ propositions de Learning
→ validation humaine
```

Le Market Map est persistant. `Person + Project` est l’unité de qualification. FIT et INTENT restent séparés. Seuls les `PASS_OUTBOUND_V1` avec signal public actuel ou récent peuvent entrer dans le buffer de 20 cas.

La collecte quotidienne ne commence pas par une recherche libre de personnes ni par le
pool des founders déjà connus. Codex lit le moteur d’Acquisition Intelligence gouverné
dans Drive :

`Need Territories → Retrieval Routes → BOFU Query Families → BOFU DAILY QUEUE`.

Le premier quota de 20 porte sur des `BOFU_CANDIDATE` high-recall : signal HOT/WARM,
comportement actif de résolution, projet ou project hint, Kernel plausible et identité
publique résolvable. Ces candidats entrent ensuite dans le Market Map par
`gtm_ingest_candidates`, avec la Query Family comme `source_lane_id`. Ils ne deviennent
jamais automatiquement des prospects activables. La résolution Person + Project, la
Boundary, le besoin structurel actuel, la priorité et la rédaction restent des gates
séparés.

Un MVP livré prouve qu’une première structure existe déjà ; sa sortie, son lancement ou
sa demande de feedback n’est donc jamais un signal que la personne a besoin de VOIDRIP
pour structurer le projet. Un cas ne peut revenir dans l’activation que sur la preuve
distincte d’un besoin actuel de restructuration du projet entier. La participation
actuelle à Y Combinator bloque l’activation ; l’appartenance à tout autre programme ne
constitue jamais à elle seule un signal d’intention.

HeyReach est l’exécuteur LinkedIn V1. Max et Overloop restent des adapters hérités optionnels ; ils ne font pas partie du chemin actif.

## Sécurité par défaut

- `SEND_MODE=locked` ;
- `GTM_SCHEDULE_ENABLED=false` ;
- aucune tâche système installée ;
- premier accord explicite pour importer des candidats nommés dans la liste ;
- second accord explicite pour lancer ;
- lancement possible uniquement avec `SEND_MODE=live` et `confirm=LAUNCH` ;
- aucun envoi automatique de réponse ;
- learning proposal-only, jamais de modification autonome de la Boundary.

L’import est préparé dans la liste reliée à la campagne, pas directement dans la campagne. La campagne reste ainsi `DRAFT` entre les deux décisions.

## Vérification

```bash
npm ci
npm run check
npm run doctor
```

`doctor` inspecte en lecture seule le Market Map, la campagne HeyReach, la liste, les variables de séquence, les comptes LinkedIn, SQLite, Codex CLI et le scheduler. Il ne crée rien, n’importe rien et ne lance rien.

## Boucle quotidienne

La skill `.agents/skills/gtm-daily-loop/SKILL.md` exécute :

1. preflight et readiness ;
2. lecture des résultats et réponses déjà lancés ;
3. reprise du Kernel en cours dans `BOFU DAILY QUEUE`, puis collecte via les Query
   Families jusqu’au quota ou au cap mesuré ;
4. ingestion dédupliquée dans le Market Map et rafraîchissement des sources existantes ;
5. résolution Person + Project et Boundary Qualification ;
6. rafraîchissement séparé des signaux ;
7. scoring d’activation ;
8. rédaction et lint des séquences ;
9. constitution du buffer de 20 cas réellement activables ;
10. brief quotidien avec les deux déficits, BOFU_CANDIDATE et activation ;
11. éventuelle proposition de learning fondée uniquement sur des résultats réels.

Elle s’arrête à la revue humaine. Elle n’importe pas et ne lance pas.

## Deux validations HeyReach

### Accord 1 — import dans la liste

1. `gtm_get_activation_readiness` ;
2. `gtm_approve_heyreach_import` avec les IDs validés ;
3. `gtm_stage_heyreach_import` ;
4. contrôle que la campagne reste `DRAFT` et que les profils sont bien présents.

### Accord 2 — lancement

1. relecture du volume, de la séquence et de l’expéditeur actif ;
2. `gtm_approve_heyreach_launch` avec les IDs déjà importés ;
3. passage volontaire de `SEND_MODE` à `live` ;
4. `gtm_launch_heyreach` avec `confirm=LAUNCH`.

Sans ces conditions, le moteur bloque avant l’appel réseau.

## Résultats, réponses et learning

- `gtm_sync_heyreach_results` ajoute des événements idempotents ;
- `gtm_sync_heyreach_replies` récupère les conversations ;
- `gtm_get_market_reply_queue` expose le texte exact et le contexte ;
- `gtm_save_market_reply_triage` classe et prépare un brouillon sans envoyer ;
- `gtm_record_market_outcome` rattache réunion, Scan et vente à `Person + Project` ;
- `gtm_get_market_performance` compare Kernel, signal, tier, route, hook, intent et version ;
- `gtm_save_market_learning_proposal` crée une proposition ;
- `gtm_review_market_learning` est la seule porte d’application humaine.

Zéro résultat réel interdit toute proposition. Moins de 20 résultats réels force une confiance faible.

## Configuration active

| Variable | Défaut | Usage |
|---|---:|---|
| `HEYREACH_API_KEY` | — | Clé du workspace |
| `HEYREACH_CAMPAIGN_ID` | `0` | Campagne existante autoritative |
| `SEND_MODE` | `locked` | Position normale de sécurité |
| `GTM_DAILY_NEW_LEADS` | `20` | Cible quotidienne |
| `GTM_DAILY_SEQUENCES` | `20` | Taille du buffer |
| `GTM_DAILY_PUSH_LIMIT` | `20` | Maximum importable après accord |
| `GTM_SCHEDULE_ENABLED` | `false` | Aucun fonctionnement régulier par défaut |

La base est `data/gtm.db`, les backups dans `data/backups/` et les briefs dans `reports/`. Ces données locales ne sont pas commitées.

## Scheduler

Installation explicite seulement, une fois tout validé :

```bash
npm run schedule
```

Contrôle et arrêt :

```bash
node bin/gtm.mjs schedule status
npm run unschedule
```
