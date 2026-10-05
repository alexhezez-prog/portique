/**
 * Le Portique — relais serveur (Cloudflare Worker)
 *
 * Rôle : recevoir les demandes de l'application (photos de la leçon, réponses
 * de l'élève), appeler l'API Claude (Anthropic) avec la clé secrète et renvoyer
 * du JSON. La clé API ne quitte jamais ce serveur.
 *
 * Requêtes : { step: "analyse" | "fiche" | "qcm" | "courtes" | "exercice"
 *              | "corriger_courte" | "corriger_exercice", ... }
 *
 * Variables à définir dans Cloudflare (Settings > Variables and Secrets) :
 *   ANTHROPIC_API_KEY  (secret)  clé API Anthropic
 *   ACCESS_CODE        (secret)  code familial saisi dans l'appli (anti-abus)
 *   ALLOWED_ORIGIN     (texte)   ex. https://monpseudo.github.io   (ou * pour tester)
 *   MODEL              (texte, optionnel) défaut : claude-sonnet-5-5
 */

const DEFAULT_MODEL = "claude-sonnet-5-5";
// Modèles essayés dans l'ordre si le premier refuse la requête (400/404).
const FALLBACK_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001"];
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 6_000_000; // ~4,5 Mo par image après compression côté appli
const MAX_TEXT = 40_000;            // garde-fou sur les textes renvoyés par l'appli

/* =====================================================================
   OUTILS COMMUNS
   ===================================================================== */

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed === "*" ? "*" : (origin === allowed ? origin : allowed);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function checkImages(list, max) {
  const images = Array.isArray(list) ? list.slice(0, max) : [];
  for (const img of images) {
    if (!img || typeof img.data !== "string" || !/^image\/(jpeg|png|webp)$/.test(img.media_type || "")) {
      throw new UserError("Format de photo non pris en charge.");
    }
    if (img.data.length > MAX_IMAGE_BASE64) throw new UserError("Photo trop lourde.", 413);
  }
  return images;
}

const imageBlocks = (images) => images.map((img) => ({
  type: "image",
  source: { type: "base64", media_type: img.media_type, data: img.data },
}));

function text(v, max = MAX_TEXT) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Certains modèles renvoient parfois un tableau ou un objet sous forme de texte JSON
 * (ex. notions: "[{...}]"). On les remet en forme, récursivement.
 */
function normalize(v, depth = 0) {
  if (depth > 6) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
      try { return normalize(JSON.parse(t), depth + 1); } catch { return v; }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normalize(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = normalize(x, depth + 1);
    return o;
  }
  return v;
}
const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * Appelle Claude et récupère l'entrée de l'outil demandé.
 * tool_choice "auto" + consigne explicite : compatible avec tous les modèles récents.
 * En cas de refus du modèle (400/404) ou de réponse sans outil, on essaie le suivant.
 */
async function callTool(env, { system, content, tool, maxTokens = 4096 }) {
  const models = [...new Set([env.MODEL || DEFAULT_MODEL, ...FALLBACK_MODELS])];
  let lastError = "Réponse inattendue du service d'IA.";

  for (const model of models) {
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: system + `\n\nTu dois OBLIGATOIREMENT répondre en appelant l'outil ${tool.name}, sans aucun texte autour.`,
          tools: [tool],
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content }],
        }),
      });
    } catch {
      throw new UserError("Impossible de joindre le service d'IA. Réessaie dans un instant.", 502);
    }

    if (!res.ok) {
      const detail = await res.text();
      console.log("Anthropic error", model, res.status, detail);
      if (res.status === 429 || res.status === 529) {
        throw new UserError("Le service est très demandé. Réessaie dans une minute.", 502);
      }
      if (res.status === 400 || res.status === 404) {
        lastError = "Le service d'IA a renvoyé une erreur (" + res.status + ").";
        continue; // modèle indisponible ou paramètre refusé : on tente le suivant
      }
      throw new UserError("Le service d'IA a renvoyé une erreur (" + res.status + ").", 502);
    }

    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === "tool_use" && b.name === tool.name);
    if (block && data.stop_reason !== "max_tokens") {
      return { input: normalize(block.input || {}), usage: data.usage || null, model };
    }
    lastError = data.stop_reason === "max_tokens"
      ? "La réponse était trop longue. Essaie avec moins de pages."
      : "Réponse inattendue du service d'IA.";
    console.log("No usable tool_use", model, data.stop_reason);
  }
  throw new UserError(lastError, 502);
}

const validQcm = (q) =>
  q && typeof q.question === "string" && Array.isArray(q.choices) && q.choices.length === 4 &&
  Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index <= 3;


/* =====================================================================
   PARCOURS LYCÉE (index.html)
   Étapes : analyse → (fiche + qcm + courtes + exercice en parallèle)
            → corriger_courte / corriger_exercice → bilan (calculé dans l'appli)
   Après l'analyse, on ne renvoie plus les photos : on travaille sur la
   transcription du cours, plus rapide et moins coûteux.
   ===================================================================== */

const NIVEAUX = ["2de", "1re", "Tle", "inconnu"];

const LYCEE_BASE = `Tu es un professeur de lycée expérimenté (programmes français en vigueur : seconde, première, terminale, y compris les spécialités). Tu aides un lycéen à réviser un cours qu'il a photographié.

Principes communs :
- Le cours de l'élève est la référence. N'introduis aucune notion absente du cours. Tu peux en revanche créer de nouvelles situations, de nouveaux nombres ou de courts documents pour faire APPLIQUER les notions du cours.
- Niveau d'exigence : celui d'un contrôle de lycée ou du bac pour le niveau indiqué. Vocabulaire disciplinaire précis, ton direct et respectueux, sans infantiliser.
- Formules mathématiques ou scientifiques : écris-les en LaTeX entre \\( et \\) (en ligne) ou \\[ et \\] (centrées). N'utilise jamais le symbole $ comme délimiteur. Les unités et les nombres décimaux suivent l'usage français (virgule décimale).
- Pour mettre un mot en valeur, utilise **gras**. Pas d'autre mise en forme Markdown que le gras et les listes commençant par "- ".`;

function coursContext(body) {
  const notions = Array.isArray(body.notions) ? body.notions.slice(0, 12) : [];
  const listing = notions
    .filter((n) => n && typeof n.id === "string")
    .map((n) => `- ${n.id} : ${text(n.label, 200)}${n.resume ? " — " + text(n.resume, 400) : ""}`)
    .join("\n");
  const transcription = text(body.transcription);
  if (!transcription) throw new UserError("Le cours analysé est manquant. Recommence l'analyse.");
  return {
    ids: notions.map((n) => n && n.id).filter(Boolean),
    text:
      `Matière : ${text(body.matiere, 80) || "non précisée"}\nNiveau : ${NIVEAUX.includes(body.niveau) ? body.niveau : "inconnu"}\n` +
      `Titre du cours : ${text(body.titre, 200)}\n\nNotions à travailler (identifiants à réutiliser) :\n${listing}\n\n` +
      `<cours>\n${transcription}\n</cours>`,
  };
}

function avoidList(body) {
  const avoid = Array.isArray(body.avoid) ? body.avoid.slice(0, 40).map((s) => text(s, 300)).filter(Boolean) : [];
  return avoid.length ? `\n\nQuestions déjà posées à l'élève (n'en reprends aucune, change d'angle) :\n- ${avoid.join("\n- ")}` : "";
}

/* ---------- 1. Analyse des photos ---------- */
const ANALYSE_TOOL = {
  name: "analyser_cours",
  description: "Enregistre la transcription fidèle du cours et les notions clés.",
  input_schema: {
    type: "object",
    properties: {
      readable: { type: "boolean", description: "false si les photos ne montrent pas un cours exploitable" },
      problem: { type: "string", description: "Si readable=false : explication courte (photo floue, coupée, pas un cours…)" },
      matiere: { type: "string", description: "Matière, ex. Mathématiques, Physique-chimie, SVT, SES, Histoire, Géographie, HGGSP, Français, Philosophie, Anglais, NSI…" },
      niveau: { type: "string", enum: NIVEAUX, description: "Niveau estimé d'après le contenu (inconnu si impossible à dire)" },
      titre: { type: "string", description: "Titre du chapitre ou de la leçon" },
      transcription: { type: "string", description: "Restitution fidèle et complète du contenu du cours (définitions, propriétés, formules, dates, exemples, schémas décrits en mots), organisée par parties. Pas de résumé : tout ce qui est utile pour réviser." },
      notions: {
        type: "array",
        minItems: 2, maxItems: 8,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "n1, n2, n3…" },
            label: { type: "string", description: "Nom court de la notion (2 à 6 mots)" },
            resume: { type: "string", description: "Ce que l'élève doit savoir sur cette notion, en une phrase" },
          },
          required: ["id", "label", "resume"],
        },
      },
    },
    required: ["readable"],
  },
};

async function stepAnalyse(env, body) {
  const images = checkImages(body.images, MAX_IMAGES);
  if (images.length === 0) throw new UserError("Aucune photo reçue.");
  const content = imageBlocks(images);
  content.push({
    type: "text",
    text: `Voici ${images.length} photo(s) d'un cours de lycée (manuel, polycopié ou cahier, parfois manuscrit), dans l'ordre.
Transcris fidèlement le cours, puis découpe-le en 2 à 8 notions clés (identifiants n1, n2…), dans l'ordre du cours. Une notion = un savoir ou un savoir-faire évaluable.
Si les photos sont illisibles ou ne montrent pas un cours, mets readable à false.`,
  });
  const { input, usage } = await callTool(env, { system: LYCEE_BASE, content, tool: ANALYSE_TOOL, maxTokens: 8000 });

  if (input.readable === false) {
    return { readable: false, problem: input.problem || "Je n'arrive pas à lire le cours. Reprends les photos bien à plat, avec de la lumière." };
  }
  const notions = asArray(input.notions)
    .filter((n) => n && n.label)
    .map((n, i) => ({ id: "n" + (i + 1), label: String(n.label), resume: String(n.resume || "") }));
  if (!input.transcription || notions.length < 1) {
    return { readable: false, problem: "Le cours est trop court ou peu lisible. Ajoute une photo ou reprends-la de plus près." };
  }
  return {
    readable: true,
    matiere: input.matiere || "Cours",
    niveau: NIVEAUX.includes(input.niveau) ? input.niveau : "inconnu",
    titre: input.titre || "Mon cours",
    transcription: input.transcription,
    notions,
    usage,
  };
}

/* ---------- 2. Fiche flash ---------- */
const FICHE_TOOL = {
  name: "creer_fiche",
  description: "Enregistre la fiche de révision flash.",
  input_schema: {
    type: "object",
    properties: {
      essentiel: { type: "string", description: "L'idée directrice du chapitre en 2 phrases maximum" },
      blocs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            notion_id: { type: "string" },
            type: { type: "string", enum: ["definition", "propriete", "formule", "date", "methode", "exemple", "vocabulaire"] },
            titre: { type: "string" },
            contenu: { type: "string", description: "Contenu à retenir, concis (1 à 4 lignes)" },
          },
          required: ["notion_id", "type", "titre", "contenu"],
        },
      },
      pieges: {
        type: "array", maxItems: 4,
        items: {
          type: "object",
          properties: {
            piege: { type: "string", description: "L'erreur fréquente" },
            correction: { type: "string", description: "Ce qu'il faut faire ou dire à la place" },
          },
          required: ["piege", "correction"],
        },
      },
      carte: {
        type: "object",
        description: "Carte mentale du chapitre. Texte simple, SANS LaTeX ni Markdown (symboles Unicode autorisés : Δ, α, ², √, →, ≤, ×).",
        properties: {
          centre: { type: "string", description: "Sujet central, 2 à 5 mots" },
          branches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                notion_id: { type: "string" },
                label: { type: "string", description: "Nom de la branche, 1 à 4 mots" },
                feuilles: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" }, description: "Idées clés, 3 à 9 mots chacune" },
              },
              required: ["notion_id", "label", "feuilles"],
            },
          },
        },
        required: ["centre", "branches"],
      },
    },
    required: ["essentiel", "blocs", "pieges", "carte"],
  },
};

async function stepFiche(env, body) {
  const ctx = coursContext(body);
  const { input, usage } = await callTool(env, {
    system: LYCEE_BASE,
    tool: FICHE_TOOL,
    maxTokens: 5000,
    content: [{ type: "text", text: ctx.text + `

Rédige une fiche de révision FLASH d'une page sur les notions listées uniquement : l'essentiel, puis des blocs courts (définitions, propriétés, formules, dates, méthodes, exemples types) rattachés à leur notion, puis 2 à 4 pièges classiques à éviter (erreurs typiques des lycéens sur ce chapitre). Chaque bloc doit pouvoir être mémorisé en moins d'une minute.
Construis aussi la carte mentale : le sujet au centre, une branche par notion listée (même notion_id, dans l'ordre), 2 à 4 feuilles par branche qui résument les idées à retenir en quelques mots.` }],
  });
  const carte = input.carte && typeof input.carte === "object" && Array.isArray(input.carte.branches) ? {
    centre: String(input.carte.centre || body.titre || "Cours").slice(0, 80),
    branches: input.carte.branches
      .filter((b) => b && b.label)
      .slice(0, 8)
      .map((b) => ({
        notion_id: ctx.ids.includes(b.notion_id) ? b.notion_id : "",
        label: String(b.label).slice(0, 60),
        feuilles: (Array.isArray(b.feuilles) ? b.feuilles : []).slice(0, 4).map((f) => String(f).slice(0, 90)),
      })),
  } : null;
  return {
    essentiel: input.essentiel || "",
    blocs: asArray(input.blocs).filter((b) => b && b.contenu),
    pieges: asArray(input.pieges).filter((p) => p && p.piege),
    carte,
    usage,
  };
}

/* ---------- 3a. Palier 1 : QCM de connaissances ---------- */
const QCM_TOOL = {
  name: "creer_qcm",
  description: "Enregistre les questions à choix multiples.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            notion_id: { type: "string" },
            question: { type: "string" },
            choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
            answer_index: { type: "integer", minimum: 0, maximum: 3 },
            explanation: { type: "string", description: "Pourquoi la bonne réponse est juste et pourquoi le piège principal est faux (2 phrases max)" },
          },
          required: ["notion_id", "question", "choices", "answer_index", "explanation"],
        },
      },
    },
    required: ["questions"],
  },
};

async function stepQcm(env, body) {
  const ctx = coursContext(body);
  const count = Math.min(Math.max(parseInt(body.count, 10) || 6, 3), 10);
  const { input, usage } = await callTool(env, {
    system: LYCEE_BASE,
    tool: QCM_TOOL,
    maxTokens: 4000,
    content: [{ type: "text", text: ctx.text + avoidList(body) + `

Crée exactement ${count} questions à choix multiples, réparties équitablement entre les notions listées (rattache chaque question à son notion_id).
- Moitié connaissances exactes (définition, formule, date, condition d'application), moitié compréhension (reconnaître un cas, appliquer à un exemple nouveau, repérer une erreur de raisonnement).
- 4 choix, une seule bonne réponse sans ambiguïté ; distracteurs = erreurs typiques de lycéen, jamais absurdes. Varie la position de la bonne réponse. Pas de "toutes/aucune de ces réponses".` }],
  });
  const questions = asArray(input.questions).map((q) => (q && typeof q === "object" ? { ...q, answer_index: Number(q.answer_index) } : q)).filter(validQcm).map((q) => ({
    ...q, notion_id: ctx.ids.includes(q.notion_id) ? q.notion_id : ctx.ids[0],
  }));
  if (questions.length < 2) throw new UserError("Les questions n'ont pas pu être générées. Réessaie.", 502);
  return { questions, usage };
}

/* ---------- 3b. Palier 2 : questions courtes rédigées ---------- */
const COURTES_TOOL = {
  name: "creer_questions_courtes",
  description: "Enregistre les questions à réponse courte rédigée, avec leur barème.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            notion_id: { type: "string" },
            verbe: { type: "string", enum: ["Définir", "Justifier", "Calculer", "Expliquer", "Démontrer", "Comparer", "Citer", "Situer", "Traduire"] },
            question: { type: "string", description: "Consigne précise, réponse attendue en 1 à 5 lignes" },
            reponse_attendue: { type: "string", description: "Réponse modèle complète et rédigée" },
            criteres: {
              type: "array", minItems: 3, maxItems: 3,
              items: { type: "string" },
              description: "Exactement 3 critères, 1 point chacun, vérifiables (ex. 'cite la condition a ≠ 0', 'donne le bon résultat avec l'unité')",
            },
          },
          required: ["notion_id", "verbe", "question", "reponse_attendue", "criteres"],
        },
      },
    },
    required: ["questions"],
  },
};

async function stepCourtes(env, body) {
  const ctx = coursContext(body);
  const count = Math.min(Math.max(parseInt(body.count, 10) || 4, 1), 6);
  const { input, usage } = await callTool(env, {
    system: LYCEE_BASE,
    tool: COURTES_TOOL,
    maxTokens: 4000,
    content: [{ type: "text", text: ctx.text + avoidList(body) + `

Crée exactement ${count} questions à réponse courte rédigée, sur des notions différentes si possible, notées sur 3 points avec 3 critères d'un point.
Varie les verbes (définir, justifier, calculer, expliquer…). Chaque question doit obliger l'élève à restituer ou à raisonner, pas à recopier. Une réponse doit tenir en 1 à 5 lignes sur un téléphone.` }],
  });
  const questions = asArray(input.questions)
    .filter((q) => q && q.question && q.reponse_attendue && Array.isArray(q.criteres) && q.criteres.length >= 1)
    .map((q) => ({
      ...q,
      criteres: q.criteres.slice(0, 3),
      notion_id: ctx.ids.includes(q.notion_id) ? q.notion_id : ctx.ids[0],
    }));
  if (questions.length < 1) throw new UserError("Les questions n'ont pas pu être générées. Réessaie.", 502);
  return { questions, usage };
}

/* ---------- 3c. Palier 3 : exercice d'application ---------- */
const EXERCICE_TOOL = {
  name: "creer_exercice",
  description: "Enregistre l'exercice d'application type contrôle ou bac.",
  input_schema: {
    type: "object",
    properties: {
      titre: { type: "string" },
      format: { type: "string", description: "Ex. Problème, Analyse de document, Étude de cas, Question de méthode" },
      enonce: { type: "string", description: "Mise en situation et données nécessaires" },
      document: { type: "string", description: "Document à analyser si l'exercice en comporte un (texte, données chiffrées, tableau décrit en lignes). Vide sinon." },
      sous_questions: {
        type: "array", minItems: 2, maxItems: 5,
        items: {
          type: "object",
          properties: {
            notion_id: { type: "string" },
            consigne: { type: "string" },
            points: { type: "integer", minimum: 1, maximum: 4 },
            corrige: { type: "string", description: "Corrigé rédigé, avec les étapes" },
            criteres: { type: "array", items: { type: "string" }, description: "Un critère par point" },
          },
          required: ["notion_id", "consigne", "points", "corrige", "criteres"],
        },
      },
      duree_min: { type: "integer", description: "Durée conseillée en minutes (10 à 25)" },
    },
    required: ["titre", "format", "enonce", "sous_questions"],
  },
};

async function stepExercice(env, body) {
  const ctx = coursContext(body);
  const { input, usage } = await callTool(env, {
    system: LYCEE_BASE,
    tool: EXERCICE_TOOL,
    maxTokens: 5000,
    content: [{ type: "text", text: ctx.text + avoidList(body) + `

Crée UN exercice d'application du type de ceux donnés en contrôle ou au bac pour cette matière et ce niveau, qui mobilise plusieurs des notions listées, en 2 à 5 sous-questions progressives (de l'application directe à un raisonnement plus complet), 10 points au total environ.
Adapte le format à la matière :
- Mathématiques, physique-chimie, NSI : problème avec données numériques nouvelles, étapes de calcul ou de démonstration.
- SVT, SES, histoire, géographie, HGGSP : analyse d'un court document que tu rédiges (texte, données chiffrées, tableau décrit en lignes), fidèle au cours et plausible ; ne présente jamais un document inventé comme une citation réelle d'un auteur existant.
- Français, philosophie : question de méthode (dégager une problématique, construire un plan, analyser un court extrait libre de droits ou rédigé par toi).
- Langues : compréhension d'un court texte que tu rédiges puis courte production.
Le corrigé de chaque sous-question doit être complet et ses critères (un par point) vérifiables.` }],
  });
  const sous = asArray(input.sous_questions)
    .filter((s) => s && s.consigne && s.corrige)
    .map((s, i) => ({
      id: "q" + (i + 1),
      notion_id: ctx.ids.includes(s.notion_id) ? s.notion_id : ctx.ids[0],
      consigne: s.consigne,
      points: Math.min(Math.max(parseInt(s.points, 10) || 2, 1), 4),
      corrige: s.corrige,
      criteres: Array.isArray(s.criteres) ? s.criteres.slice(0, 4) : [],
    }));
  if (sous.length < 1) throw new UserError("L'exercice n'a pas pu être généré. Réessaie.", 502);
  return {
    titre: input.titre || "Exercice",
    format: input.format || "",
    enonce: input.enonce || "",
    document: input.document || "",
    duree_min: Math.min(Math.max(parseInt(input.duree_min, 10) || 15, 5), 40),
    sous_questions: sous,
    usage,
  };
}

/* ---------- 4a. Correction d'une question courte ---------- */
const CORRIGER_COURTE_TOOL = {
  name: "noter_reponse",
  description: "Enregistre la correction de la réponse de l'élève.",
  input_schema: {
    type: "object",
    properties: {
      criteres_valides: { type: "array", items: { type: "boolean" }, description: "Un booléen par critère, dans l'ordre" },
      commentaire: { type: "string", description: "2 phrases max, adressées à l'élève (tu) : ce qui est juste, ce qui manque précisément" },
    },
    required: ["criteres_valides", "commentaire"],
  },
};

const CORRECTEUR = LYCEE_BASE + `

Tu corriges maintenant la réponse d'un élève. Sois juste et exigeant comme un correcteur de bac :
- Accorde un critère si l'idée est présente et correcte, même formulée autrement ou avec des notations tapées au clavier (x^2, sqrt(x), racine de x, ->, etc.). Ignore les fautes de frappe sans conséquence.
- N'accorde pas un critère pour une réponse vague, incomplète sur ce point, ou juste par hasard sans justification quand la justification est demandée.
- Si l'élève a joint une photo de sa copie, lis-la et note ce qui y est écrit.
- Le commentaire s'adresse à l'élève (tutoiement), sans formule creuse : dis précisément ce qui manque ou ce qui est faux.`;

async function stepCorrigerCourte(env, body) {
  const q = body.question || {};
  const criteres = Array.isArray(q.criteres) ? q.criteres.slice(0, 4).map((c) => text(c, 400)) : [];
  if (!q.question || criteres.length === 0) throw new UserError("Question à corriger manquante.");
  const images = checkImages(body.images, 2);
  const reponse = text(body.reponse, 4000);
  if (!reponse.trim() && images.length === 0) throw new UserError("Réponse vide.");

  const content = imageBlocks(images);
  content.push({
    type: "text",
    text: `Matière : ${text(body.matiere, 80)} — Niveau : ${text(body.niveau, 10)}

Question : ${text(q.question, 2000)}
Réponse modèle : ${text(q.reponse_attendue, 3000)}
Critères (1 point chacun) :
${criteres.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Réponse de l'élève :
<reponse>
${reponse || "(voir la photo jointe)"}
</reponse>`,
  });
  const { input, usage } = await callTool(env, { system: CORRECTEUR, content, tool: CORRIGER_COURTE_TOOL, maxTokens: 1500 });
  const valides = criteres.map((_, i) => Boolean(asArray(input.criteres_valides)[i]));
  return {
    criteres_valides: valides,
    points: valides.filter(Boolean).length,
    max: criteres.length,
    commentaire: input.commentaire || "",
    usage,
  };
}

/* ---------- 4b. Correction de l'exercice ---------- */
const CORRIGER_EXO_TOOL = {
  name: "noter_copie",
  description: "Enregistre la correction de la copie de l'élève.",
  input_schema: {
    type: "object",
    properties: {
      resultats: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            points_obtenus: { type: "number", description: "Par pas de 0,5" },
            commentaire: { type: "string", description: "1 à 2 phrases à l'élève : ce qui est juste, l'erreur précise" },
          },
          required: ["id", "points_obtenus", "commentaire"],
        },
      },
      appreciation: { type: "string", description: "Appréciation globale en 2 phrases : point fort, priorité de travail" },
    },
    required: ["resultats", "appreciation"],
  },
};

async function stepCorrigerExercice(env, body) {
  const ex = body.exercice || {};
  const sous = Array.isArray(ex.sous_questions) ? ex.sous_questions.slice(0, 6) : [];
  if (sous.length === 0) throw new UserError("Exercice à corriger manquant.");
  const reponses = body.reponses && typeof body.reponses === "object" ? body.reponses : {};
  const images = checkImages(body.images, 3);

  const blocs = sous.map((s) => `### ${s.id} (${s.points} pt)
Consigne : ${text(s.consigne, 2000)}
Corrigé : ${text(s.corrige, 3000)}
Critères : ${(s.criteres || []).map((c) => text(c, 300)).join(" | ")}
Réponse de l'élève : ${text(reponses[s.id], 4000) || "(rien saisi" + (images.length ? " — voir la photo de copie" : "") + ")"}`).join("\n\n");

  const content = imageBlocks(images);
  content.push({
    type: "text",
    text: `Matière : ${text(body.matiere, 80)} — Niveau : ${text(body.niveau, 10)}

Exercice : ${text(ex.titre, 200)}
Énoncé : ${text(ex.enonce, 4000)}
${ex.document ? "Document : " + text(ex.document, 6000) + "\n" : ""}
${blocs}

Note chaque sous-question (id identique) en points, par pas de 0,5, sans dépasser son barème. Une sous-question sans réponse vaut 0.`,
  });
  const { input, usage } = await callTool(env, { system: CORRECTEUR, content, tool: CORRIGER_EXO_TOOL, maxTokens: 3000 });

  const byId = Object.fromEntries(asArray(input.resultats).filter((r) => r && r.id).map((r) => [r.id, r]));
  const resultats = sous.map((s) => {
    const r = byId[s.id] || {};
    const pts = Math.round(Math.min(Math.max(Number(r.points_obtenus) || 0, 0), s.points) * 2) / 2;
    return { id: s.id, points: pts, max: s.points, commentaire: r.commentaire || "" };
  });
  return { resultats, appreciation: input.appreciation || "", usage };
}

const LYCEE_STEPS = {
  analyse: stepAnalyse,
  fiche: stepFiche,
  qcm: stepQcm,
  courtes: stepCourtes,
  exercice: stepExercice,
  corriger_courte: stepCorrigerCourte,
  corriger_exercice: stepCorrigerExercice,
};

/* =====================================================================
   POINT D'ENTRÉE
   ===================================================================== */

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405, cors);

    // Code d'accès familial : évite que n'importe qui utilise votre crédit API.
    if (!env.ACCESS_CODE || request.headers.get("X-Access-Code") !== env.ACCESS_CODE) {
      return json({ error: "Code d'accès incorrect. Vérifie le code d'activation." }, 401, cors);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Clé API absente côté serveur." }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Requête invalide." }, 400, cors); }

    try {
      const step = LYCEE_STEPS[body.step];
      if (!step) return json({ error: "Étape inconnue." }, 400, cors);
      return json(await step(env, body), 200, cors);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status, cors);
      console.log("Unexpected", e && e.stack);
      return json({ error: "Erreur interne du serveur (" + String((e && e.message) || e).slice(0, 160) + ")." }, 500, cors);
    }
  },
};
