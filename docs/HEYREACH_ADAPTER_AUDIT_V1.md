# HEYREACH ADAPTER — API & SAFETY AUDIT V1

Date: 2026-10-01
Status: campagne existante inspectée en lecture seule ; aucune campagne créée, modifiée ou démarrée.

## État réel du workspace vérifié le 2026-09-30

- campagne cible existante : `VOIDRIP — BOFU — Invitation + M1–M5` ;
- identifiant HeyReach : `623081` ;
- statut : `DRAFT` ;
- liste sélectionnée : `VOIDRIP — BOFU — Prospects validés` ;
- volume actuel : `0 lead` ;
- cinq exclusions de sécurité visibles et activées ;
- séquence présente : invitation LinkedIn puis M1–M5 avec délais ;
- séquence API revalidée : 15 nœuds et variables `FIRST_NAME`, `specific_project`, `platform`, `specific_observation`, `specific_observation_2` présentes ;
- aucun compte LinkedIn n’est actuellement assigné à la campagne ;
- le seul compte visible dans le workspace est inactif ;
- scheduler local non installé et désactivé par défaut.

Cette campagne est la cible autoritative de l'adapter V1. Le moteur ne doit pas créer de campagne de remplacement.

## Sources vérifiées

- [HeyReach Campaign API](https://www.heyreach.io/blog/campaign-api)
- [HeyReach public API Postman collection](https://documenter.getpostman.com/view/23808049/2sA2xb5F75)
- [HeyReach — add leads to campaigns](https://help.heyreach.io/en/articles/11657798-how-to-add-leads-to-campaigns)
- [HeyReach webhooks](https://help.heyreach.io/en/articles/9877965-webhooks)

## Contrat confirmé

- Base URL: `https://api.heyreach.io/api/public`.
- Authentification: header `X-API-KEY` ; validation par `GET /auth/CheckApiKey`.
- `POST /campaign/Create` crée une campagne en état `DRAFT` ; le démarrage nécessite un appel séparé à `POST /campaign/StartCampaign`.
- Une campagne DRAFT exige une `USER_LIST`, au moins un compte LinkedIn valide, un schedule valide et une séquence dont chaque branche finit par `END`.
- `POST /list/AddLeadsToListV2` permet de préparer la liste existante reliée à la campagne sans appeler l’ajout direct à la campagne.
- `POST /campaign/AddLeadsToCampaignV2` peut alimenter une campagne existante. HeyReach avertit que l’ajout par API à une campagne en pause ou terminée peut la réactiver.
- Les résultats et états de leads sont lisibles via `GetLeadsFromCampaign`, `GetOverallStatsByCampaign` et `GetConversationsV2`.
- Les exclusions workspace sont lisibles et modifiables via les endpoints `/blacklist/*`.
- Les réponses et acceptations peuvent aussi être reçues par webhooks, mais la création d’un webhook est immédiatement active et reste hors scope de cet audit local.

## Décision LOCKED

Chemin autorisé avant tout accord d'activation :

`campagne existante 623081 → inspection read-only → qualification locale → revue humaine → accord d’import → liste existante → accord de lancement distinct`

L'adapter V1 ne crée ni liste ni campagne. Une mise en pause ou une exclusion restent des mutations explicites, jamais déclenchées par l'inspection.

Actions `SEND_CAPABLE`, bloquées en `SEND_MODE=locked` :

- `StartCampaign` ;
- reprise de campagne ;
- ajout direct de leads à une campagne ;
- message direct ou toute action pouvant contacter un prospect.

Même en mode `live`, une action `SEND_CAPABLE` exige une autorisation explicite sur l’appel concerné. Aucun démarrage ne doit être réalisé sans l’accord explicite de Jen dans la session courante.

## Fiabilité

- L'identifiant explicite de campagne évite toute sélection par nom ambiguë.
- L'inspection vérifie l'identité retournée, le statut, le volume et l'absence de leads en cours.
- Un état externe autre que `DRAFT` n'est jamais réinterprété comme sûr.
- Aucun chemin de création automatique n'existe dans l'adapter V1.
- Les erreurs `429` et `Retry-After` sont déjà gérées par le client HTTP. La limite exacte publiquement garantie n’a pas été trouvée dans l’autorité officielle ; le défaut local reste volontairement conservateur à 60 requêtes/minute jusqu’à vérification authentifiée.

## Hors scope avant accord explicite

- création d’une liste ou campagne dans le workspace ;
- `StartCampaign`, resume, ajout direct à une campagne ou envoi ;
- installation d’un webhook ;
- passage de `SEND_MODE` à `live`.
