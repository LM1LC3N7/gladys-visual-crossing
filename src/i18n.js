// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button) in English
// and French. They name fields, never their values.
// -----------------------------------------------------------------------------

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

const FIELD_NAMES = {
  api_key: { en: 'API key', fr: 'clé API' },
  alerts: { en: 'alerts', fr: 'alertes' },
  refresh_minutes: { en: 'refresh interval', fr: 'intervalle de lecture' },
  daily_budget: { en: 'daily cap', fr: 'plafond quotidien' },
};

const names = (fields, lang) => fields.map((f) => FIELD_NAMES[f]?.[lang] ?? f).join(', ');

export const T = {
  notConfigured: {
    en: 'Enter the API key of your Visual Crossing account.',
    fr: 'Saisissez la clé API de votre compte Visual Crossing.',
  },
  invalid: (fields) => ({
    en: `Invalid configuration: ${names(fields, 'en')}. Nothing is sent to Visual Crossing until it is fixed.`,
    fr: `Configuration invalide : ${names(fields, 'fr')}. Rien n'est envoyé à Visual Crossing avant correction.`,
  }),
  ready: {
    en: 'Ready: waiting for the first weather request of Gladys.',
    fr: 'Prêt : en attente de la première demande météo de Gladys.',
  },
  ok: {
    en: 'Visual Crossing answers.',
    fr: 'Visual Crossing répond.',
  },
  refused: {
    en: 'Visual Crossing refused this API key (HTTP 401): nothing more is sent with it. Check the key and your account, then save a new key or press "Test Visual Crossing".',
    fr: "Visual Crossing a refusé cette clé API (HTTP 401) : plus rien n'est envoyé avec elle. Vérifiez la clé et votre compte, puis enregistrez une nouvelle clé ou appuyez sur « Tester Visual Crossing ».",
  },
  paused429: (ms) => ({
    en: `Visual Crossing asked to slow down or the account limit is reached (HTTP 429): next request in ${minutes(ms)} min.`,
    fr: `Visual Crossing a demandé de ralentir ou la limite du compte est atteinte (HTTP 429) : prochaine requête dans ${minutes(ms)} min.`,
  }),
  pausedError: (reason, ms) => ({
    en: `Visual Crossing did not answer properly (${reason}): next request in ${minutes(ms)} min.`,
    fr: `Visual Crossing n'a pas répondu correctement (${reason}) : prochaine requête dans ${minutes(ms)} min.`,
  }),
  budget: (budget) => ({
    en: `Daily cap reached (${budget} records): no request to Visual Crossing before midnight UTC.`,
    fr: `Plafond quotidien atteint (${budget} enregistrements) : aucune requête à Visual Crossing avant minuit UTC.`,
  }),
  notServed: (reason) => ({
    en: `Visual Crossing does not serve this location (${reason}): asked again after one refresh interval.`,
    fr: `Visual Crossing ne sert pas ce lieu (${reason}) : redemandé après un intervalle de lecture.`,
  }),
  held: (ms) => ({
    en: `The last call for this location failed: asked again in ${minutes(ms)} min (a failed call may have been billed).`,
    fr: `Le dernier appel pour ce lieu a échoué : redemandé dans ${minutes(ms)} min (un appel en échec a pu être facturé).`,
  }),
  noTime: {
    en: 'Not enough time left to ask Visual Crossing before Gladys gives up: nothing sent.',
    fr: "Plus assez de temps pour interroger Visual Crossing avant que Gladys n'abandonne : rien envoyé.",
  },
  notCounted: {
    en: 'The call could not be counted in /data/state.json: nothing sent (the daily cap must survive a restart).',
    fr: "L'appel n'a pas pu être compté dans /data/state.json : rien envoyé (le plafond quotidien doit survivre à un redémarrage).",
  },
  unreadable: (reason) => ({
    en: `Visual Crossing answered, but the answer is unreadable (${reason}).`,
    fr: `Visual Crossing a répondu, mais la réponse est illisible (${reason}).`,
  }),
  stateUnreadable: {
    en: '/data/state.json is unreadable: read again every 10 s, nothing is sent to Visual Crossing meanwhile.',
    fr: "/data/state.json est illisible : relu toutes les 10 s, rien n'est envoyé à Visual Crossing en attendant.",
  },
  configUnread: (ms) => ({
    en: `The configuration could not be read from Gladys: new try in ${Math.ceil(ms / 1000)} s.`,
    fr: `La configuration n'a pas pu être lue depuis Gladys : nouvel essai dans ${Math.ceil(ms / 1000)} s.`,
  }),
  badLocation: {
    en: 'Invalid coordinates.',
    fr: 'Coordonnées invalides.',
  },
  testWait: (ms) => ({
    en: `A test ran less than a minute ago: try again in ${Math.ceil(ms / 1000)} s.`,
    fr: `Un test a eu lieu il y a moins d'une minute : réessayez dans ${Math.ceil(ms / 1000)} s.`,
  }),
  testOk: ({ cost, records, budget }) => ({
    en: `Visual Crossing accepted the key. This test cost ${cost} record(s). Records counted today (UTC): ${records} of ${budget}.`,
    fr: `Visual Crossing a accepté la clé. Ce test a coûté ${cost} enregistrement(s). Enregistrements comptés aujourd'hui (UTC) : ${records} sur ${budget}.`,
  }),
};

/** The English text of a message, for the errors that Gladys logs. */
export const en = (message) => message.en;
