import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  Behavior,
  GoogleGenAI,
  Modality,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Part,
  type Tool,
} from '@google/genai';
import type {
  ChatRequestPayload,
  DocxPatchSpec,
  ExcelDocSpec,
  GeneratedDocument,
  GeneratedMusic,
  GeneratedVisual,
  GroundingSource,
  LiveVoiceName,
  MemoryEventNotice,
  MusicSectionSpec,
  MusicTrackSpec,
  PdfPatchSpec,
  PhotoEditSpec,
  WordPdfDocSpec,
  WorldInstrumentId,
  WorldRhythmPreset,
} from './src/types/chat.ts';
import {
  type AuthenticatedRequest,
  authenticateToken,
  checkAndConsumeDailyLimit,
  extractSessionToken,
  registerAuthRoutes,
  requireAuth,
} from './server/auth.js';
import { registerConversationRoutes } from './server/conversations.js';
import { registerAdminRoutes } from './server/admin.js';
import { APP_VERSION } from './server/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MODEL_PRIMARY = 'gemini-3.1-flash-lite';
const MODEL_FALLBACK = 'gemini-4-hydrogen';
const MODEL_TTS = 'gemini-3.8-flash-lite-tts';
const MODEL_LIVE = 'gemini-3.8-live';

function shouldAutoEnableSearch(webSearchToggle: boolean, lastText: string): boolean {
  if (webSearchToggle) return true;
  const q = lastText.toLowerCase();
  // Avoid slowing down offline-solvable creative, music, coding, or math questions
  if (q.length < 18 && !/\b(météo|prix|actualit|score|cours|weather|news)\b/.test(q)) {
    return false;
  }
  const triggers = [
    'actualité', 'actualités', 'dernières nouvelles', "aujourd'hui", 'cette semaine', 'ce mois-ci',
    'en ce moment', 'prix actuel', 'tarif actuel', 'météo', 'quel temps fait',
    'bourse', 'cours du ', 'résultat du match', 'score du', 'élection',
    'recherche sur internet', 'cherche sur internet', 'cherche sur google', 'sur le web',
    'latest news', 'current price', 'weather today', '2026',
  ];
  return triggers.some((kw) => q.includes(kw));
}

function getAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('MISSING_API_KEY');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: 30000,
      retryOptions: {
        attempts: 1,
      },
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getAIVersionedClient(apiVersion: 'v1beta' | 'v1alpha' = 'v1beta'): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('MISSING_API_KEY');
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion,
    httpOptions: {
      timeout: 25000,
      retryOptions: { attempts: 1 },
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function fetchFallbackWebContext(query: string): Promise<{
  contextText: string;
  sources: GroundingSource[];
}> {
  const cleanQuery = query.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!cleanQuery) return { contextText: '', sources: [] };

  const sources: GroundingSource[] = [];
  const snippets: string[] = [];

  const fetchNews = async () => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQuery)}&hl=fr&gl=FR&ceid=FR:fr`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!res.ok) return;
    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = itemRegex.exec(xml)) !== null && count < 4) {
      const block = match[1];
      const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim();
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim();
      if (title && link) {
        count++;
        snippets.push(`- [Actualité] ${title}${pubDate ? ` (${pubDate})` : ''} — ${link}`);
        sources.push({ title, uri: link });
      }
    }
  };

  const fetchWiki = async () => {
    const url = `https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&format=json&srlimit=3&utf8=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4500) });
    if (!res.ok) return;
    const data = (await res.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> };
    };
    for (const item of data.query?.search ?? []) {
      const cleanSnippet = item.snippet.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
      const wikiUrl = `https://fr.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`;
      snippets.push(`- [Wikipédia : ${item.title}] ${cleanSnippet} — ${wikiUrl}`);
      sources.push({ title: `${item.title} — Wikipédia`, uri: wikiUrl });
    }
  };

  await Promise.allSettled([fetchNews(), fetchWiki()]);

  if (snippets.length === 0) {
    return { contextText: '', sources: [] };
  }

  return {
    contextText: `[Résultats de recherche web en direct pour "${cleanQuery}" :\n${snippets.join('\n')}\nUtilise ces informations récentes et fiables pour enrichir ta réponse sans inventer d'autres faits ni liens.]`,
    sources,
  };
}

function cleanTextForSpeech(markdown: string): string {
  let txt = markdown
    .replace(/```[\s\S]*?```/g, ' (bloc de code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\s*\|?[-:\s|]+\|?\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (txt.length > 2400) {
    const cut = txt.slice(0, 2400);
    const lastPeriod = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    txt = (lastPeriod > 1200 ? cut.slice(0, lastPeriod + 1) : cut).trim();
  }
  return txt;
}

async function fetchRealWikimediaPhoto(
  ai: GoogleGenAI,
  userPrompt: string,
): Promise<{
  title: string;
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sourceUrl: string;
} | null> {
  try {
    let searchTerms = userPrompt.trim();
    try {
      const kwRes = await ai.models.generateContent({
        model: MODEL_PRIMARY,
        contents: `Translate this photo request into 2 to 4 concise English search keywords for Wikimedia Commons (no quotes, no punctuation, keywords only): "${userPrompt}"`,
      });
      const candidate = (kwRes.text ?? '').replace(/["'\n.,:;!?]/g, ' ').replace(/\s+/g, ' ').trim();
      if (candidate && candidate.length <= 70) {
        searchTerms = candidate;
      }
    } catch {
      // Keep original query
    }

    const ua = 'GaiusIA/1.0 (https://gaius-ia.app; contact@gaius-ia.app)';
    const tryQuery = async (queryStr: string) => {
      const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`${queryStr} filetype:bitmap`)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=1024&format=json`;
      const metaRes = await fetch(apiUrl, {
        headers: { 'User-Agent': ua },
        signal: AbortSignal.timeout(5500),
      });
      if (!metaRes.ok) return null;

      const metaJson = (await metaRes.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title?: string;
              index?: number;
              imageinfo?: Array<{
                thumburl?: string;
                url?: string;
                mime?: string;
                thumbwidth?: number;
                thumbheight?: number;
                width?: number;
                height?: number;
                descriptionurl?: string;
              }>;
            }
          >;
        };
      };

      const pages = Object.values(metaJson.query?.pages ?? {}).sort(
        (a, b) => (a.index ?? 99) - (b.index ?? 99),
      );

      const excludedWords = ['map', 'diagram', 'logo', 'flag', 'coat_of_arms', 'icon', 'chart', 'schema'];
      for (const page of pages) {
        const rawTitle = (page.title ?? '').toLowerCase();
        if (excludedWords.some((w) => rawTitle.includes(w))) continue;
        const info = page.imageinfo?.[0];
        if (!info) continue;
        const mime = info.mime ?? '';
        if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') continue;
        const imgUrl = info.thumburl || info.url;
        if (!imgUrl) continue;

        const imgRes = await fetch(imgUrl, {
          headers: { 'User-Agent': ua },
          signal: AbortSignal.timeout(6500),
        });
        if (!imgRes.ok) {
          console.warn('Wikimedia image fetch status:', imgRes.status, imgUrl);
          continue;
        }

        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length === 0 || buf.length > 6 * 1024 * 1024) continue;

        const finalMime = imgRes.headers.get('content-type')?.split(';')[0] || mime;
        const cleanTitle = (page.title ?? 'Photographie')
          .replace(/^File:/i, '')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/_/g, ' ');

        return {
          title: cleanTitle,
          dataUrl: `data:${finalMime};base64,${buf.toString('base64')}`,
          mimeType: finalMime,
          width: info.thumbwidth || info.width || 1024,
          height: info.thumbheight || info.height || 683,
          sourceUrl: info.descriptionurl || imgUrl,
        };
      }
      return null;
    };

    const first = await tryQuery(searchTerms);
    if (first) return first;

    const words = searchTerms.split(' ').filter((w) => w.length > 2);
    if (words.length > 2) {
      return await tryQuery(words.slice(0, 2).join(' '));
    }
    return null;
  } catch (err) {
    console.warn('fetchRealWikimediaPhoto failed:', err);
    return null;
  }
}

function buildSystemInstruction(
  webSearchEnabled: boolean,
  memories?: Array<{ id: string; content: string; category?: string }>,
  projectContext?: ChatRequestPayload['projectContext'],
  responseLanguage?: string,
): string {
  const currentDate = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const memoryBlock =
    memories && memories.length > 0
      ? `\n\nMÉMOIRES PERSISTANTES SUR L'UTILISATEUR (à utiliser naturellement dans tes réponses) :\n${memories
          .map((m) => `- ${m.category ? `[${m.category}] ` : ''}${m.content}`)
          .join('\n')}`
      : '';

  const projectBlock = projectContext
    ? `\n\nCONTEXTE DU PROJET ACTIF (prioritaire pour cette discussion) :
- Nom du projet : ${projectContext.title}
- Domaine / Catégorie : ${projectContext.category}
- Objectif / Description : ${projectContext.description}${
        projectContext.instructions
          ? `\n- Instructions permanentes de l'utilisateur pour ce projet : ${projectContext.instructions}`
          : ''
      }
Adapte systématiquement tes conseils, plans d'action, documents, tableaux, illustrations et créations musicales aux objectifs concrets de ce projet.`
    : '';

  const langLine =
    responseLanguage && responseLanguage.trim()
      ? `- Langue souhaitée par l'utilisateur : réponds en **${responseLanguage.trim()}** (sauf si l'utilisateur écrit explicitement dans une autre langue pour une traduction ou demande précise).`
      : '- Tu réponds par défaut en français (ou dans la langue exacte utilisée par l\'utilisateur).';

  return `Tu es Gaius (Gaius IA), une référence intellectuelle, scientifique, créative et humaine d'exception — encyclopédique, sage, inspirant, rapide, rigoureux et profondément bienveillant.
Date actuelle : ${currentDate}.${memoryBlock}${projectBlock}

IDENTITÉ, SAGESSE ET MAÎTRISE UNIVERSELLE :
- Tu accompagnes aussi bien les élèves, étudiants, professeurs, chercheurs, médecins, entrepreneurs, développeurs, poètes, chanteurs, musiciens, artistes, joueurs que tous les esprits curieux.
- Tu maîtrises les sciences exactes et fondamentales (physique, chimie, biologie, médecine à titre informatif rigoureux, astrophysique, mathématiques pures et appliquées), l'informatique, le droit, l'économie, l'histoire, la philosophie, la littérature, la poésie, la musique, les jeux vidéo/stratégies et les grands mystères de la science et de la vie.
- Tu combines exactitude scientifique, créativité brillante, force motivatrice et grande sagesse pratique.
${langLine}

RAPIDITÉ ET PROFONDEUR ADAPTATIVE (JUSQU'À 30 PAGES ET PLUS) :
- **Questions simples ou directes** : Sois fulgurant, clair, précis et concis sans bavardage superflu.
- **Questions complexes, analyses, cours, mémoires ou travaux fleuves** : Va droit au cœur du sujet avec une structuration exemplaire, sans remplissage. Lorsque l'utilisateur demande une étude exhaustive, un cours complet, un livre, un mémoire ou un document pouvant couvrir **10, 20, 30 pages ou davantage** :
  1. Organise la réponse en **Parties et Chapitres numérotés** avec une rigueur académique ou littéraire maximale.
  2. Développe chaque partie en profondeur sans résumer artificiellement.
  3. Si le sujet demande un volume massif sur plusieurs volets, rédige un premier grand volet complet et indique clairement à la fin que l'utilisateur peut cliquer sur **« Continuer (+) »** (ou demander la suite) pour générer les chapitres suivants jusqu'à épuisement complet du sujet — ou te demander d'exporter l'ensemble en Word (.docx) ou PDF.

CAPACITÉS ET RÈGLES D'UTILISATION DES OUTILS :
1. Mémoire persistante (\`save_memory\`, \`delete_memory\`) :
   - Dès que l'utilisateur demande explicitement de retenir, noter ou mémoriser une information (ex: « Mémorise que... », « Souviens-toi que... », « Retiens mon nom... », « N'oublie pas que... »), appelle immédiatement \`save_memory\` avec une formulation claire et concise, puis confirme-le naturellement dans ta réponse.
   - Si l'utilisateur demande d'oublier ou de supprimer un souvenir, appelle \`delete_memory\`.

2. Recherche sur Internet (Google Search) :
   - ${webSearchEnabled ? "L'utilisateur a activé la recherche web : utilise Google Search pour vérifier les informations actuelles et citer les sources fiables." : "Utilise Google Search uniquement lorsque la question porte sur l'actualité, des événements récents, des prix actuels, la météo, le sport ou des faits récents."}
   - Ne jamais inventer de sources, d'URLs ni de faits.

3. Analyse, modification fidèle et utilisation comme modèle de fichiers Word (.docx) et PDF (.pdf) :
   - **RÈGLE D'OR (ZÉRO DÉGRADATION / ZÉRO DÉFORMATION)** : Lorsque l'utilisateur envoie un fichier Word (.docx) ou PDF (.pdf) et demande de **modifier un élément précis**, **compléter un champ** ou **l'utiliser comme modèle (template)** :
     a) **Modification ciblée d'un Word (.docx)** : Utilise en priorité \`modify_uploaded_word_document\` avec la liste exacte des remplacements (\`{ find, replace }\`) en copiant les fragments exacts présents dans le texte du fichier joint pour conserver **100 % de la mise en page d'origine**.
     b) **Modification/remplissage ciblé d'un PDF (.pdf)** : Utilise \`modify_uploaded_pdf_document\` pour conserver le PDF d'origine intact sans aucune dégradation.
     c) **Utilisation comme modèle ou ajout de nouvelles sections complètes** : Utilise \`create_word_document\` ou \`create_pdf_document\` en **reproduisant mot pour mot et tableau pour tableau** chaque partie non modifiée du document source.

4. Modification et création de photos / visuels sans déformation :
   - **Modification d'une photo jointe** : Appelle \`modify_attached_photo\` pour retoucher, recadrer, pivoter, ajuster les couleurs ou ajouter un texte/cadre sans altérer les pixels d'origine.
   - **Photographies réelles** : Appelle \`find_real_photo\` pour les paysages, monuments, animaux, ciels étoilés et scènes réelles.
   - **Rendus 3D & illustrations** : Appelle \`create_visual_illustration\` avec un SVG \`1200x780\` riche et détaillé.

5. Création de tableurs Excel (.xlsx) :
   - Utilise \`create_excel_spreadsheet\` avec de vraies formules Excel (\`=SUM(...)\`, \`=AVERAGE(...)\`, etc.).

6. Création musicale internationale (\`compose_music_track\`) :
   - Dès que l'utilisateur demande de créer, composer ou modifier une chanson, une musique, un hymne, un beat ou des paroles sur n'importe quel rythme du monde (Rumba congolaise, Soukous, Afrobeats, Amapiano, Salsa, Reggaeton, Bossa Nova, Reggae, Raï/Oriental, Flamenco, Bollywood, Hip-Hop/Trap, Pop, Rock, Jazz, Électro, Classique, Gospel, Lo-Fi), appelle \`compose_music_track\` avec :
     - \`rhythmPreset\` choisi parmi les 18 rythmes authentiques,
     - \`instruments\` adaptés à la tradition du style (guitare, piano, kora/marimba, oud/sitar, basse, cuivres, cordes, synthé, flûte),
     - une vraie \`chordProgression\`, une \`melodyNotes\` chantante (ex: \`["C4","E4","G4","A4","G4","E4","D4","C4"]\`), et des \`sections\` complètes (Intro, Couplet 1, Refrain, Couplet 2, Pont, Refrain final) avec paroles inspirées.

COMPORTEMENT ET ÉTHIQUE :
- Si une demande est ambiguë, pose une question courte de clarification avant d'agir.
- Pour les questions médicales ou juridiques, apporte une explication scientifique/informative claire et rigoureuse tout en rappelant de consulter un professionnel qualifié pour tout diagnostic ou décision personnelle.
- Respecte la vie privée et refuse poliment tout contenu dangereux, illégal ou haineux.`;
}

const sectionSchema = {
  type: Type.OBJECT,
  properties: {
    heading: {
      type: Type.STRING,
      description: 'Titre optionnel de la section.',
    },
    paragraphs: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Paragraphes de texte de la section.',
    },
    bullets: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Liste à puces optionnelle.',
    },
    table: {
      type: Type.OBJECT,
      properties: {
        headers: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        rows: {
          type: Type.ARRAY,
          items: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
      },
      required: ['headers', 'rows'],
      description: 'Tableau structuré optionnel.',
    },
  },
};

const createWordDocumentDecl: FunctionDeclaration = {
  name: 'create_word_document',
  description:
    'Crée un document Word (.docx) structuré et prêt à télécharger (ou reproduit fidèlement un modèle avec de nouvelles sections/modifications).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nom du fichier se terminant par .docx.',
      },
      title: {
        type: Type.STRING,
        description: 'Titre principal du document.',
      },
      subtitle: {
        type: Type.STRING,
        description: 'Sous-titre ou objet optionnel.',
      },
      sections: {
        type: Type.ARRAY,
        items: sectionSchema,
        description: 'Liste ordonnée des sections du document.',
      },
    },
    required: ['filename', 'title', 'sections'],
  },
};

const modifyUploadedWordDecl: FunctionDeclaration = {
  name: 'modify_uploaded_word_document',
  description:
    "Modifie chirurgicalement un fichier Word (.docx) envoyé par l'utilisateur en remplaçant uniquement les textes ciblés tout en conservant 100 % du formatage, des styles, tableaux, polices et images d'origine.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sourceAttachmentName: {
        type: Type.STRING,
        description: 'Nom exact du fichier Word (.docx) joint par l’utilisateur.',
      },
      outputFilename: {
        type: Type.STRING,
        description: 'Nom du fichier modifié à télécharger (.docx).',
      },
      replacements: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            find: {
              type: Type.STRING,
              description: 'Texte exact présent dans le document Word d’origine à remplacer.',
            },
            replace: {
              type: Type.STRING,
              description: 'Nouveau texte de remplacement.',
            },
          },
          required: ['find', 'replace'],
        },
        description: 'Liste des remplacements exacts à effectuer sans toucher au reste du document.',
      },
      summary: {
        type: Type.STRING,
        description: 'Court résumé des modifications appliquées.',
      },
    },
    required: ['sourceAttachmentName', 'outputFilename', 'replacements'],
  },
};

const createPdfDocumentDecl: FunctionDeclaration = {
  name: 'create_pdf_document',
  description:
    'Crée un document PDF (.pdf) mis en page et prêt à télécharger (ou reproduit fidèlement un modèle PDF avec les ajouts/modifications demandés).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nom du fichier se terminant par .pdf.',
      },
      title: {
        type: Type.STRING,
        description: 'Titre principal du PDF.',
      },
      subtitle: {
        type: Type.STRING,
        description: 'Sous-titre optionnel.',
      },
      sections: {
        type: Type.ARRAY,
        items: sectionSchema,
        description: 'Liste ordonnée des sections du PDF.',
      },
    },
    required: ['filename', 'title', 'sections'],
  },
};

const modifyUploadedPdfDecl: FunctionDeclaration = {
  name: 'modify_uploaded_pdf_document',
  description:
    "Complète ou modifie un PDF envoyé par l'utilisateur en conservant les pages originales intactes (remplissage des champs de formulaire PDF ou ajout propre de texte sur les pages).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sourceAttachmentName: {
        type: Type.STRING,
        description: 'Nom exact du fichier PDF joint par l’utilisateur.',
      },
      outputFilename: {
        type: Type.STRING,
        description: 'Nom du fichier PDF généré (.pdf).',
      },
      formFields: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            fieldName: { type: Type.STRING },
            value: { type: Type.STRING },
          },
          required: ['fieldName', 'value'],
        },
        description: 'Champs de formulaire PDF AcroForm à remplir.',
      },
      overlays: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER, description: 'Numéro de page (1 = première page).' },
            x: { type: Type.NUMBER, description: 'Position horizontale en % (0 à 100).' },
            y: { type: Type.NUMBER, description: 'Position verticale depuis le haut en % (0 à 100).' },
            text: { type: Type.STRING, description: 'Texte à écrire proprement.' },
            fontSize: { type: Type.NUMBER, description: 'Taille de police (défaut 11).' },
            color: { type: Type.STRING, description: 'Couleur hexadécimale (défaut #0f172a).' },
            coverWidthPct: { type: Type.NUMBER, description: 'Largeur optionnelle en % d’un fond blanc propre pour masquer l’ancien texte.' },
            coverHeightPct: { type: Type.NUMBER, description: 'Hauteur optionnelle en % du fond blanc.' },
          },
          required: ['page', 'x', 'y', 'text'],
        },
        description: 'Ajouts ou remplacements localisés de texte sur les pages PDF d’origine.',
      },
      summary: {
        type: Type.STRING,
        description: 'Résumé court des éléments complétés ou modifiés.',
      },
    },
    required: ['sourceAttachmentName', 'outputFilename'],
  },
};

const createExcelSpreadsheetDecl: FunctionDeclaration = {
  name: 'create_excel_spreadsheet',
  description:
    'Crée un classeur Excel (.xlsx) avec une ou plusieurs feuilles, en-têtes, données numériques ou textuelles et formules Excel (=SUM, =AVERAGE, etc.).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filename: {
        type: Type.STRING,
        description: 'Nom du fichier se terminant par .xlsx.',
      },
      sheets: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            headers: { type: Type.ARRAY, items: { type: Type.STRING } },
            rows: {
              type: Type.ARRAY,
              items: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            columnWidths: { type: Type.ARRAY, items: { type: Type.NUMBER } },
          },
          required: ['name', 'headers', 'rows'],
        },
      },
    },
    required: ['filename', 'sheets'],
  },
};

const modifyAttachedPhotoDecl: FunctionDeclaration = {
  name: 'modify_attached_photo',
  description:
    "Retouche, recadre, pivote, ajuste les couleurs ou ajoute un texte/cadre sur la photo envoyée par l'utilisateur en préservant intégralement ses pixels d'origine sans déformer la scène ni les visages.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sourceAttachmentName: {
        type: Type.STRING,
        description: 'Nom du fichier image joint (ex: photo.jpg).',
      },
      title: { type: Type.STRING, description: 'Titre descriptif en français.' },
      caption: { type: Type.STRING, description: 'Courte explication des ajustements appliqués.' },
      brightness: { type: Type.NUMBER, description: 'Luminosité en % (100 = normal, 125 = plus lumineux).' },
      contrast: { type: Type.NUMBER, description: 'Contraste en % (100 = normal).' },
      saturation: { type: Type.NUMBER, description: 'Saturation des couleurs en % (100 = normal, 0 = désaturé).' },
      grayscale: { type: Type.NUMBER, description: 'Noir et blanc en % (0 à 100).' },
      sepia: { type: Type.NUMBER, description: 'Effet sépia en % (0 à 100).' },
      hueRotate: { type: Type.NUMBER, description: 'Décalage de teinte en degrés (-180 à 180).' },
      blur: { type: Type.NUMBER, description: 'Flou doux en pixels (0 à 20).' },
      warmth: { type: Type.NUMBER, description: 'Chaleur de couleur (-50 froid à +50 chaud).' },
      vignette: { type: Type.NUMBER, description: 'Vignettage cinématique en % (0 à 100).' },
      rotateDeg: { type: Type.INTEGER, description: 'Rotation en degrés : 0, 90, 180 ou 270.' },
      flipHorizontal: { type: Type.BOOLEAN, description: 'Miroir horizontal.' },
      flipVertical: { type: Type.BOOLEAN, description: 'Miroir vertical.' },
      crop: {
        type: Type.OBJECT,
        properties: {
          xPct: { type: Type.NUMBER },
          yPct: { type: Type.NUMBER },
          widthPct: { type: Type.NUMBER },
          heightPct: { type: Type.NUMBER },
        },
        required: ['xPct', 'yPct', 'widthPct', 'heightPct'],
      },
      overlayText: { type: Type.STRING, description: 'Texte ou légende nette à incruster sur la photo.' },
      overlayPosition: { type: Type.STRING, description: '"top", "center" ou "bottom".' },
      overlayColor: { type: Type.STRING, description: 'Couleur hex du texte (défaut #ffffff).' },
      borderColor: { type: Type.STRING, description: 'Couleur hex du cadre optionnel.' },
      borderWidth: { type: Type.NUMBER, description: 'Épaisseur du cadre (ex: 24).' },
      outputFormat: { type: Type.STRING, description: '"png", "jpeg" ou "webp".' },
    },
    required: ['title', 'caption'],
  },
};

const findRealPhotoDecl: FunctionDeclaration = {
  name: 'find_real_photo',
  description:
    'Recherche et affiche une véritable photographie haute résolution (paysages, villes, déserts, étoiles, monuments, animaux, nature, architecture) directement dans la conversation.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'Description précise de la photographie réelle recherchée.' },
      title: { type: Type.STRING, description: 'Titre descriptif en français pour la photo.' },
    },
    required: ['query', 'title'],
  },
};

const createVisualIllustrationDecl: FunctionDeclaration = {
  name: 'create_visual_illustration',
  description:
    'Crée une composition visuelle ou un rendu 3D / cinématique haute netteté (1200x780) en SVG avec éclairage volumétrique, ombres réalistes et profondeur, téléchargeable en PNG et SVG.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING },
      prompt: { type: Type.STRING },
      style: { type: Type.STRING, description: '"3d" ou "illustration".' },
      width: { type: Type.INTEGER },
      height: { type: Type.INTEGER },
      svgMarkup: {
        type: Type.STRING,
        description: 'Code SVG complet commençant par <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 780">...</svg>.',
      },
    },
    required: ['title', 'prompt', 'svgMarkup'],
  },
};

const saveMemoryDecl: FunctionDeclaration = {
  name: 'save_memory',
  description:
    "Enregistre de façon persistante une information, préférence, consigne ou fait que l'utilisateur demande à Gaius de mémoriser pour les conversations futures.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      content: {
        type: Type.STRING,
        description: 'Énoncé clair et autonome de ce qu’il faut retenir (en français).',
      },
      category: {
        type: Type.STRING,
        description: 'Catégorie courte optionnelle (ex: Identité, Préférence, Projet, Travail).',
      },
    },
    required: ['content'],
  },
};

const deleteMemoryDecl: FunctionDeclaration = {
  name: 'delete_memory',
  description:
    "Supprime un souvenir ou une information précédemment mémorisée lorsque l'utilisateur demande de l'oublier.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Mot-clé ou description du souvenir à oublier.',
      },
    },
    required: ['query'],
  },
};

const ALLOWED_RHYTHMS: WorldRhythmPreset[] = [
  'rumba',
  'afrobeats',
  'amapiano',
  'salsa',
  'reggaeton',
  'bossanova',
  'reggae',
  'rai_oriental',
  'flamenco',
  'bollywood',
  'hiphop_trap',
  'pop',
  'rock',
  'jazz',
  'electro',
  'classical',
  'gospel',
  'lofi',
];

const ALLOWED_INSTRUMENTS: WorldInstrumentId[] = [
  'guitar',
  'piano',
  'kora_marimba',
  'oud_sitar',
  'bass',
  'brass',
  'strings',
  'synth_lead',
  'flute',
];

const musicTrackSchemaProperties = {
  title: { type: Type.STRING, description: 'Titre inspirant de la chanson.' },
  genre: { type: Type.STRING, description: 'Nom du style musical (ex: Rumba congolaise, Afrobeats, Salsa, Raï, Pop, Classique…).' },
  origin: { type: Type.STRING, description: 'Région ou tradition culturelle d’origine (ex: Afrique centrale, Caraïbes, Maghreb, Brésil…).' },
  rhythmPreset: {
    type: Type.STRING,
    description: `Un identifiant exact parmi : ${ALLOWED_RHYTHMS.join(', ')}.`,
  },
  bpm: { type: Type.INTEGER, description: 'Tempo en battements par minute (entre 60 et 165).' },
  musicalKey: { type: Type.STRING, description: 'Tonalité (ex: Do majeur, La mineur, Ré mineur).' },
  mood: { type: Type.STRING, description: 'Ambiance émotionnelle (ex: Dansant, Épique, Doux, Inspirant).' },
  instruments: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: `Liste de 2 à 5 identifiants d'instruments parmi : ${ALLOWED_INSTRUMENTS.join(', ')}.`,
  },
  instrumentLabels: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: 'Noms lisibles en français des instruments utilisés (ex: Guitare solo sebene, Basse, Congas, Cuivres).',
  },
  chordProgression: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: 'Progression de 4 accords (ex: ["C", "F", "G", "C"] ou ["Am", "F", "C", "G"]).',
  },
  melodyNotes: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: 'Séquence mélodique de 8 à 16 notes avec octave (ex: ["C4", "E4", "G4", "A4", "G4", "E4", "D4", "C4"]).',
  },
  sections: {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'Ex: Couplet 1, Refrain, Pont, Couplet 2, Final.' },
        lyrics: { type: Type.STRING, description: 'Paroles poétiques et chantantes complètes de la section.' },
        chords: { type: Type.ARRAY, items: { type: Type.STRING } },
        energy: { type: Type.STRING, description: '"low", "medium" ou "high".' },
      },
      required: ['name', 'lyrics', 'chords'],
    },
    description: 'Structure complète de la chanson avec ses paroles.',
  },
  description: {
    type: Type.STRING,
    description: 'Courte présentation artistique de la composition.',
  },
};

const composeMusicTrackDecl: FunctionDeclaration = {
  name: 'compose_music_track',
  description:
    'Compose une chanson originale jouable (audio multi-instruments synthétisé + paroles + accords + téléchargement WAV) dans n’importe quel rythme et tradition instrumentale du monde.',
  parameters: {
    type: Type.OBJECT,
    properties: musicTrackSchemaProperties,
    required: [
      'title',
      'genre',
      'origin',
      'rhythmPreset',
      'bpm',
      'musicalKey',
      'mood',
      'instruments',
      'instrumentLabels',
      'chordProgression',
      'melodyNotes',
      'sections',
      'description',
    ],
  },
};

function normalizeMusicSpec(raw: Record<string, unknown>, fallbackPrompt: string): MusicTrackSpec {
  const rawPreset = String(raw.rhythmPreset ?? 'pop').toLowerCase().trim() as WorldRhythmPreset;
  const rhythmPreset: WorldRhythmPreset = ALLOWED_RHYTHMS.includes(rawPreset) ? rawPreset : 'pop';

  const rawInstruments = Array.isArray(raw.instruments)
    ? raw.instruments
        .map((i) => String(i).toLowerCase().trim() as WorldInstrumentId)
        .filter((i) => ALLOWED_INSTRUMENTS.includes(i))
    : [];
  const instruments: WorldInstrumentId[] =
    rawInstruments.length > 0 ? rawInstruments.slice(0, 5) : ['guitar', 'piano', 'bass'];

  const instrumentLabels =
    Array.isArray(raw.instrumentLabels) && raw.instrumentLabels.length > 0
      ? raw.instrumentLabels.map((l) => String(l))
      : ['Guitare', 'Piano', 'Basse', 'Percussions'];

  const chordProgression =
    Array.isArray(raw.chordProgression) && raw.chordProgression.length > 0
      ? raw.chordProgression.map((c) => String(c))
      : ['C', 'F', 'G', 'C'];

  const melodyNotes =
    Array.isArray(raw.melodyNotes) && raw.melodyNotes.length >= 4
      ? raw.melodyNotes.map((n) => String(n))
      : ['C4', 'E4', 'G4', 'A4', 'G4', 'E4', 'D4', 'C4'];

  const sections: MusicSectionSpec[] = Array.isArray(raw.sections) && raw.sections.length > 0
    ? raw.sections.map((s) => {
        const rec = (s ?? {}) as Record<string, unknown>;
        return {
          name: String(rec.name ?? 'Couplet'),
          lyrics: String(rec.lyrics ?? ''),
          chords: Array.isArray(rec.chords) ? rec.chords.map((c) => String(c)) : chordProgression,
          energy:
            rec.energy === 'low' || rec.energy === 'medium' || rec.energy === 'high'
              ? rec.energy
              : 'medium',
        };
      })
    : [
        {
          name: 'Couplet 1',
          lyrics: `Mélodie inspirée par : ${fallbackPrompt}`,
          chords: chordProgression,
          energy: 'medium',
        },
      ];

  const bpmNum = Number(raw.bpm);
  const bpm = Number.isFinite(bpmNum) ? Math.min(170, Math.max(58, Math.round(bpmNum))) : 112;

  return {
    title: String(raw.title ?? 'Composition originale Gaius'),
    genre: String(raw.genre ?? 'World Fusion'),
    origin: String(raw.origin ?? 'Internationale'),
    rhythmPreset,
    bpm,
    musicalKey: String(raw.musicalKey ?? 'Do majeur'),
    mood: String(raw.mood ?? 'Inspirant'),
    instruments,
    instrumentLabels,
    chordProgression,
    melodyNotes,
    sections,
    description: String(raw.description ?? `Composition originale inspirée de « ${fallbackPrompt} ».`),
  };
}

const liveSaveMemoryDecl: FunctionDeclaration = {
  ...saveMemoryDecl,
  behavior: Behavior.NON_BLOCKING,
};

const liveDeleteMemoryDecl: FunctionDeclaration = {
  ...deleteMemoryDecl,
  behavior: Behavior.NON_BLOCKING,
};

function sanitizeFilename(raw: string, ext: 'docx' | 'pdf' | 'xlsx'): string {
  const cleaned = (raw || `document_gaius.${ext}`)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.toLowerCase().endsWith(`.${ext}`) ? cleaned : `${cleaned}.${ext}`;
}

function sanitizeSvg(svg: string): string {
  let clean = svg.trim();
  clean = clean.replace(/^```(?:svg|xml)?\s*/i, '').replace(/```\s*$/i, '').trim();
  clean = clean
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
  if (!clean.includes('xmlns="http://www.w3.org/2000/svg"')) {
    clean = clean.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return clean;
}

function svgToDataUrl(svgMarkup: string): string {
  const base64 = Buffer.from(svgMarkup, 'utf-8').toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

function coerceExcelCellValue(val: unknown): string | number | boolean | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  const s = String(val).trim();
  if (s === '') return '';
  if (s.startsWith('=')) return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (Number.isFinite(num)) return num;
  }
  return String(val);
}

const MAX_HISTORY_MESSAGES_FOR_GEMINI = 24;

function buildGeminiContents(messages: ChatRequestPayload['messages']): Content[] {
  const contents: Content[] = [];
  const windowMessages =
    messages.length > MAX_HISTORY_MESSAGES_FOR_GEMINI
      ? messages.slice(-MAX_HISTORY_MESSAGES_FOR_GEMINI)
      : messages;

  for (const msg of windowMessages) {
    const parts: Part[] = [];

    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        if ((att.kind === 'image' || att.kind === 'pdf') && att.base64) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType,
              data: att.base64,
            },
          });
          parts.push({
            text: `[Fichier joint : ${att.name} (${att.mimeType})${att.extractedText ? ` — ${att.extractedText}` : ''}]`,
          });
        } else if (att.extractedText) {
          parts.push({
            text: `[Contenu extrait du fichier "${att.name}" (${att.kind})]\n\n${att.extractedText}\n\n[Fin du fichier "${att.name}"]`,
          });
        }
      }
    }

    if (msg.content && msg.content.trim()) {
      parts.push({ text: msg.content });
    } else if (parts.length > 0 && msg.role === 'user') {
      parts.push({ text: 'Analyse ce fichier en détail.' });
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }

  return contents;
}

function mapGeminiErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (raw === 'MISSING_API_KEY' || lower.includes('api_key_invalid') || lower.includes('api key not valid')) {
    return "La clé API Gemini n'est pas configurée ou est invalide. Vérifiez-la dans le panneau Settings > Secrets.";
  }
  if (lower.includes('permission_denied') || lower.includes('403')) {
    return "Accès refusé par l'API Gemini. Vérifiez votre clé API dans le panneau Settings > Secrets.";
  }
  if (lower.includes('resource_exhausted') || lower.includes('429') || lower.includes('quota')) {
    return "Le quota de requêtes Gemini a été temporairement atteint. Réessayez dans quelques instants ou vérifiez votre clé dans Settings > Secrets.";
  }
  if (lower.includes('not_found') || lower.includes('404')) {
    return 'Le modèle IA demandé est indisponible pour le moment. Veuillez réessayer.';
  }
  if (lower.includes('safety') || lower.includes('blocked')) {
    return 'Cette demande a été bloquée par les filtres de sécurité.';
  }
  return `Une erreur est survenue lors de la communication avec Gaius : ${raw}`;
}

async function executeToolCall(
  ai: GoogleGenAI,
  call: FunctionCall,
  callbacks: {
    emitDoc: (doc: GeneratedDocument) => void;
    emitVisual: (visual: GeneratedVisual) => void;
    emitMusic: (music: GeneratedMusic) => void;
    emitPhotoEdit: (spec: PhotoEditSpec) => void;
    emitMemory: (notice: MemoryEventNotice & { category?: string }) => void;
  },
): Promise<Record<string, unknown>> {
  const args = (call.args ?? {}) as Record<string, unknown>;

  if (call.name === 'compose_music_track') {
    const spec = normalizeMusicSpec(args, String(args.title ?? 'Composition Gaius'));
    const music: GeneratedMusic = {
      id: `mus_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      prompt: String(args.title ?? spec.genre),
      spec,
      createdAt: Date.now(),
    };
    callbacks.emitMusic(music);
    return {
      status: 'success',
      title: spec.title,
      genre: spec.genre,
      rhythmPreset: spec.rhythmPreset,
      bpm: spec.bpm,
      sectionsCount: spec.sections.length,
    };
  }

  if (call.name === 'save_memory') {
    const content = String(args.content ?? '').trim();
    const category = args.category ? String(args.category).trim() : undefined;
    if (!content) return { status: 'error', message: 'Contenu vide' };
    callbacks.emitMemory({ action: 'saved', content, category });
    return { status: 'saved', content, category };
  }

  if (call.name === 'delete_memory') {
    const query = String(args.query ?? '').trim();
    if (!query) return { status: 'error', message: 'Requête vide' };
    callbacks.emitMemory({ action: 'deleted', content: query });
    return { status: 'deleted', query };
  }

  if (call.name === 'modify_uploaded_word_document') {
    const sourceAttachmentName = String(args.sourceAttachmentName ?? '');
    const outputFilename = sanitizeFilename(
      String(args.outputFilename ?? `modifie_${sourceAttachmentName || 'document.docx'}`),
      'docx',
    );
    const replacements = Array.isArray(args.replacements)
      ? (args.replacements as Array<{ find: string; replace: string }>).map((r) => ({
          find: String(r.find ?? ''),
          replace: String(r.replace ?? ''),
        }))
      : [];

    const spec: DocxPatchSpec = {
      kind: 'docx_patch',
      sourceAttachmentName,
      replacements,
    };

    const doc: GeneratedDocument = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      format: 'docx',
      filename: outputFilename,
      summary:
        String(args.summary ?? '').trim() ||
        `${replacements.length} modification${replacements.length > 1 ? 's' : ''} fidèle${replacements.length > 1 ? 's' : ''} (mise en page d'origine préservée)`,
      spec,
    };
    callbacks.emitDoc(doc);
    return { status: 'success', filename: outputFilename, replacementsCount: replacements.length };
  }

  if (call.name === 'modify_uploaded_pdf_document') {
    const sourceAttachmentName = String(args.sourceAttachmentName ?? '');
    const outputFilename = sanitizeFilename(
      String(args.outputFilename ?? `complete_${sourceAttachmentName || 'document.pdf'}`),
      'pdf',
    );
    const formFields = Array.isArray(args.formFields)
      ? (args.formFields as Array<{ fieldName: string; value: string }>)
      : undefined;
    const overlays = Array.isArray(args.overlays)
      ? (args.overlays as PdfPatchSpec['overlays'])
      : undefined;

    const spec: PdfPatchSpec = {
      kind: 'pdf_patch',
      sourceAttachmentName,
      formFields,
      overlays,
    };

    const count = (formFields?.length ?? 0) + (overlays?.length ?? 0);
    const doc: GeneratedDocument = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      format: 'pdf',
      filename: outputFilename,
      summary:
        String(args.summary ?? '').trim() ||
        `${count} élément${count > 1 ? 's' : ''} modifié${count > 1 ? 's' : ''} sur le PDF d'origine`,
      spec,
    };
    callbacks.emitDoc(doc);
    return { status: 'success', filename: outputFilename, updatedElements: count };
  }

  if (call.name === 'create_word_document' || call.name === 'create_pdf_document') {
    const format = call.name === 'create_word_document' ? 'docx' : 'pdf';
    const filename = sanitizeFilename(String(args.filename ?? `document.${format}`), format);
    const sections = Array.isArray(args.sections)
      ? (args.sections as WordPdfDocSpec['sections'])
      : [];

    const spec: WordPdfDocSpec = {
      title: String(args.title ?? 'Document sans titre'),
      subtitle: args.subtitle ? String(args.subtitle) : undefined,
      date: new Date().toLocaleDateString('fr-FR'),
      sections,
    };

    const tableCount = sections.filter((s) => Boolean(s.table)).length;
    const summaryParts = [`${sections.length} section${sections.length > 1 ? 's' : ''}`];
    if (tableCount > 0) {
      summaryParts.push(`${tableCount} tableau${tableCount > 1 ? 'x' : ''}`);
    }

    const doc: GeneratedDocument = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      format,
      filename,
      summary: summaryParts.join(' · '),
      spec,
    };
    callbacks.emitDoc(doc);

    return {
      status: 'success',
      filename,
      format,
      sectionsCount: sections.length,
    };
  }

  if (call.name === 'create_excel_spreadsheet') {
    const filename = sanitizeFilename(String(args.filename ?? 'tableau.xlsx'), 'xlsx');
    const rawSheets = Array.isArray(args.sheets) ? args.sheets : [];

    const sheets = rawSheets.map((sheet: Record<string, unknown>, idx: number) => {
      const headers = Array.isArray(sheet.headers)
        ? sheet.headers.map((h) => String(h ?? ''))
        : [];
      const rows = Array.isArray(sheet.rows)
        ? sheet.rows.map((row) =>
            Array.isArray(row) ? row.map(coerceExcelCellValue) : [],
          )
        : [];
      const columnWidths = Array.isArray(sheet.columnWidths)
        ? sheet.columnWidths.map((w) => Number(w) || 16)
        : undefined;

      return {
        name: String(sheet.name ?? `Feuille ${idx + 1}`).slice(0, 31),
        headers,
        rows,
        columnWidths,
      };
    });

    const spec: ExcelDocSpec = { sheets };
    const totalRows = sheets.reduce((acc, s) => acc + s.rows.length, 0);
    const summary = `${sheets.length} feuille${sheets.length > 1 ? 's' : ''} · ${totalRows} ligne${totalRows > 1 ? 's' : ''}`;

    const doc: GeneratedDocument = {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      format: 'xlsx',
      filename,
      summary,
      spec,
    };
    callbacks.emitDoc(doc);

    return {
      status: 'success',
      filename,
      format: 'xlsx',
      sheetsCount: sheets.length,
    };
  }

  if (call.name === 'modify_attached_photo') {
    const spec: PhotoEditSpec = {
      sourceAttachmentName: args.sourceAttachmentName ? String(args.sourceAttachmentName) : undefined,
      title: String(args.title ?? 'Photo retouchée'),
      caption: String(args.caption ?? 'Retouche haute fidélité effectuée sur votre photo.'),
      brightness: typeof args.brightness === 'number' ? args.brightness : undefined,
      contrast: typeof args.contrast === 'number' ? args.contrast : undefined,
      saturation: typeof args.saturation === 'number' ? args.saturation : undefined,
      grayscale: typeof args.grayscale === 'number' ? args.grayscale : undefined,
      sepia: typeof args.sepia === 'number' ? args.sepia : undefined,
      hueRotate: typeof args.hueRotate === 'number' ? args.hueRotate : undefined,
      blur: typeof args.blur === 'number' ? args.blur : undefined,
      warmth: typeof args.warmth === 'number' ? args.warmth : undefined,
      vignette: typeof args.vignette === 'number' ? args.vignette : undefined,
      rotateDeg: typeof args.rotateDeg === 'number' ? args.rotateDeg : undefined,
      flipHorizontal: typeof args.flipHorizontal === 'boolean' ? args.flipHorizontal : undefined,
      flipVertical: typeof args.flipVertical === 'boolean' ? args.flipVertical : undefined,
      crop: args.crop as PhotoEditSpec['crop'] | undefined,
      overlayText: args.overlayText ? String(args.overlayText) : undefined,
      overlayPosition: args.overlayPosition as PhotoEditSpec['overlayPosition'] | undefined,
      overlayColor: args.overlayColor ? String(args.overlayColor) : undefined,
      borderColor: args.borderColor ? String(args.borderColor) : undefined,
      borderWidth: typeof args.borderWidth === 'number' ? args.borderWidth : undefined,
      outputFormat: args.outputFormat as PhotoEditSpec['outputFormat'] | undefined,
    };
    callbacks.emitPhotoEdit(spec);
    return { status: 'success', title: spec.title };
  }

  if (call.name === 'find_real_photo') {
    const query = String(args.query ?? '');
    const customTitle = String(args.title ?? query);
    const photo = await fetchRealWikimediaPhoto(ai, query);
    if (photo) {
      const visual: GeneratedVisual = {
        id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: customTitle || photo.title,
        prompt: query,
        dataUrl: photo.dataUrl,
        width: photo.width,
        height: photo.height,
        isRaster: true,
        mimeType: photo.mimeType,
        style: 'photo',
        sourceUrl: photo.sourceUrl,
        note: 'Photographie haute résolution · Wikimedia Commons',
      };
      callbacks.emitVisual(visual);
      return { status: 'success', title: visual.title, sourceUrl: photo.sourceUrl };
    }
    return {
      status: 'not_found',
      message:
        'Aucune photographie correspondante trouvée directement. Utilise create_visual_illustration pour générer un visuel détaillé.',
    };
  }

  if (call.name === 'create_visual_illustration') {
    const title = String(args.title ?? 'Visuel Gaius');
    const prompt = String(args.prompt ?? title);
    const style = String(args.style ?? 'illustration') === '3d' ? '3d' : 'illustration';
    const width = Number(args.width) || 1200;
    const height = Number(args.height) || 780;
    const svgMarkup = sanitizeSvg(String(args.svgMarkup ?? ''));

    if (svgMarkup.startsWith('<svg')) {
      const visual: GeneratedVisual = {
        id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title,
        prompt,
        svgMarkup,
        dataUrl: svgToDataUrl(svgMarkup),
        width,
        height,
        style,
        note:
          style === '3d'
            ? 'Rendu 3D vectoriel haute netteté (export PNG 2400px & SVG)'
            : 'Composition visuelle haute netteté (export PNG 2400px & SVG)',
      };
      callbacks.emitVisual(visual);
      return { status: 'success', title };
    }
    return { status: 'error', message: 'SVG invalide' };
  }

  return { status: 'error', message: `Outil inconnu: ${call.name}` };
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);

  // CORS middleware for web & Android APK (WebView / Capacitor)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      version: APP_VERSION,
      model: MODEL_PRIMARY,
      hasKey: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  registerAuthRoutes(app);
  registerConversationRoutes(app);
  registerAdminRoutes(app);

  app.post('/api/chat', requireAuth, async (req: AuthenticatedRequest, res) => {
    const limitCheck = await checkAndConsumeDailyLimit(req.authUser!.id);
    if (!limitCheck.allowed) {
      res.status(429).json({
        error: `Limite quotidienne de ${limitCheck.limit} requêtes atteinte pour aujourd'hui. Réessayez demain.`,
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let clientClosed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientClosed = true;
      }
    });

    const sendEvent = (event: string, data: unknown) => {
      if (clientClosed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const body = req.body as ChatRequestPayload;
      if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        sendEvent('error', { message: 'Aucun message fourni.' });
        res.end();
        return;
      }

      const ai = getAIClient();
      const webSearchEnabled = Boolean(body.webSearchEnabled);
      const memories =
        req.authUser?.preferences?.memoryEnabled === false
          ? []
          : Array.isArray(body.memories)
            ? body.memories
            : [];
      const projectContext = body.projectContext;
      const responseLanguage =
        req.authUser?.preferences?.responseLanguage ||
        req.authUser?.questionnaire?.preferredLanguage ||
        undefined;
      const lastUserMsg = [...body.messages].reverse().find((m) => m.role === 'user');
      const enableSearch = shouldAutoEnableSearch(webSearchEnabled, lastUserMsg?.content ?? '');
      let contents = buildGeminiContents(body.messages);

      const functionDeclsTool: Tool = {
        functionDeclarations: [
          saveMemoryDecl,
          deleteMemoryDecl,
          modifyUploadedWordDecl,
          modifyUploadedPdfDecl,
          createWordDocumentDecl,
          createPdfDocumentDecl,
          createExcelSpreadsheetDecl,
          modifyAttachedPhotoDecl,
          findRealPhotoDecl,
          createVisualIllustrationDecl,
          composeMusicTrackDecl,
        ],
      };

      const buildTools = (withSearch: boolean): Tool[] =>
        withSearch ? [{ googleSearch: {} }, functionDeclsTool] : [functionDeclsTool];

      let activeModel = MODEL_PRIMARY;
      let activeTools = buildTools(enableSearch);
      const fallbackSources: GroundingSource[] = [];

      sendEvent('status', { stage: enableSearch ? 'searching' : 'thinking' });

      const createStream = async (
        model: string,
        toolsList: Tool[],
        withHybridConfig: boolean,
        customContents: Content[],
      ) => {
        return ai.models.generateContentStream({
          model,
          contents: customContents,
          config: {
            systemInstruction: buildSystemInstruction(
              webSearchEnabled,
              memories,
              projectContext,
              responseLanguage,
            ),
            maxOutputTokens: 16384,
            tools: toolsList,
            ...(withHybridConfig ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
          },
        });
      };

      let stream;
      try {
        stream = await createStream(activeModel, activeTools, enableSearch, contents);
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message.toLowerCase() : String(firstErr).toLowerCase();
        console.warn('Primary stream attempt failed:', firstErr);

        if (
          enableSearch &&
          (msg.includes('429') ||
            msg.includes('quota') ||
            msg.includes('resource_exhausted') ||
            msg.includes('400') ||
            msg.includes('403'))
        ) {
          activeTools = buildTools(false);
          const webFallback = await fetchFallbackWebContext(lastUserMsg?.content ?? '');
          if (webFallback.contextText && contents.length > 0) {
            fallbackSources.push(...webFallback.sources);
            const lastIdx = contents.length - 1;
            const lastContent = contents[lastIdx];
            contents = [
              ...contents.slice(0, lastIdx),
              {
                ...lastContent,
                parts: [...(lastContent.parts ?? []), { text: webFallback.contextText }],
              },
            ];
          }
          stream = await createStream(activeModel, activeTools, false, contents);
        } else if (
          msg.includes('429') ||
          msg.includes('quota') ||
          msg.includes('resource_exhausted') ||
          msg.includes('404') ||
          msg.includes('504')
        ) {
          activeModel = MODEL_FALLBACK;
          activeTools = buildTools(false);
          stream = await createStream(activeModel, activeTools, false, contents);
        } else {
          throw firstErr;
        }
      }

      let turn1Text = '';
      const turn1ExtraParts: Part[] = [];
      const collectedFunctionCalls: FunctionCall[] = [];
      const seenCallKeys = new Set<string>();
      const sourcesMap = new Map<string, GroundingSource>();

      for await (const chunk of stream) {
        if (clientClosed) break;

        if (chunk.text) {
          turn1Text += chunk.text;
          sendEvent('delta', { text: chunk.text });
        }

        const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
        if (Array.isArray(groundingChunks)) {
          for (const gc of groundingChunks) {
            const uri = gc.web?.uri;
            if (uri && !sourcesMap.has(uri)) {
              sourcesMap.set(uri, {
                uri,
                title: gc.web?.title || new URL(uri).hostname.replace(/^www\./, ''),
              });
            }
          }
        }

        const candidateParts = chunk.candidates?.[0]?.content?.parts;
        if (Array.isArray(candidateParts)) {
          for (const part of candidateParts) {
            if (part.functionCall || part.thoughtSignature) {
              if (!part.text) {
                turn1ExtraParts.push(part);
              }
            }
            if (part.functionCall) {
              const key = part.functionCall.id || `${part.functionCall.name}_${JSON.stringify(part.functionCall.args)}`;
              if (!seenCallKeys.has(key)) {
                seenCallKeys.add(key);
                collectedFunctionCalls.push(part.functionCall);
              }
            }
          }
        }

        if (Array.isArray(chunk.functionCalls)) {
          for (const fc of chunk.functionCalls) {
            const key = fc.id || `${fc.name}_${JSON.stringify(fc.args)}`;
            if (!seenCallKeys.has(key)) {
              seenCallKeys.add(key);
              collectedFunctionCalls.push(fc);
            }
          }
        }
      }

      for (const s of fallbackSources) {
        if (!sourcesMap.has(s.uri)) {
          sourcesMap.set(s.uri, s);
        }
      }

      if (sourcesMap.size > 0) {
        sendEvent('sources', { sources: Array.from(sourcesMap.values()) });
      }

      if (!clientClosed && collectedFunctionCalls.length > 0) {
        const isDocCall = collectedFunctionCalls.some((fc) =>
          fc.name === 'create_word_document' ||
          fc.name === 'create_pdf_document' ||
          fc.name === 'create_excel_spreadsheet' ||
          fc.name === 'modify_uploaded_word_document' ||
          fc.name === 'modify_uploaded_pdf_document',
        );
        const isVisualCall = collectedFunctionCalls.some((fc) =>
          fc.name === 'find_real_photo' ||
          fc.name === 'create_visual_illustration' ||
          fc.name === 'modify_attached_photo',
        );
        const isMusicCall = collectedFunctionCalls.some(
          (fc) => fc.name === 'compose_music_track',
        );
        if (isDocCall || isVisualCall || isMusicCall) {
          sendEvent('status', {
            stage: isDocCall
              ? 'generating_doc'
              : isMusicCall
                ? 'composing_music'
                : 'generating_visual',
          });
        }

        const functionResponseParts: Part[] = [];
        for (const fc of collectedFunctionCalls) {
          const result = await executeToolCall(ai, fc, {
            emitDoc: (doc) => sendEvent('document', { document: doc }),
            emitVisual: (visual) => sendEvent('visual', { visual }),
            emitMusic: (music) => sendEvent('music', { music }),
            emitPhotoEdit: (photoEdit) => sendEvent('photo_edit', { photoEdit }),
            emitMemory: (memory) => sendEvent('memory_event', { memory }),
          });
          functionResponseParts.push({
            functionResponse: {
              id: fc.id,
              name: fc.name ?? 'unknown',
              response: result,
            },
          });
        }

        const previousModelParts: Part[] = [];
        if (turn1Text) {
          previousModelParts.push({ text: turn1Text });
        }
        for (const p of turn1ExtraParts) {
          previousModelParts.push(p);
        }

        const followUpContents: Content[] = [
          ...contents,
          { role: 'model', parts: previousModelParts },
          { role: 'user', parts: functionResponseParts },
        ];

        const stream2 = await ai.models.generateContentStream({
          model: activeModel,
          contents: followUpContents,
          config: {
            systemInstruction: buildSystemInstruction(webSearchEnabled, memories, projectContext),
            maxOutputTokens: 16384,
            tools: activeTools,
            ...(activeTools.some((t) => 'googleSearch' in t)
              ? { toolConfig: { includeServerSideToolInvocations: true } }
              : {}),
          },
        });

        for await (const chunk of stream2) {
          if (clientClosed) break;
          if (chunk.text) {
            turn1Text += chunk.text;
            sendEvent('delta', { text: chunk.text });
          }
        }
      }

      if (!clientClosed && !turn1Text.trim() && collectedFunctionCalls.length === 0) {
        sendEvent('delta', {
          text: 'Je suis désolé, je n’ai pas pu formuler de réponse pour cette demande. Pouvez-vous reformuler ou préciser votre question ?',
        });
      }

      sendEvent('done', { usedWebSearch: sourcesMap.size > 0 });
      res.end();
    } catch (err) {
      console.error('Error in /api/chat:', err);
      sendEvent('error', { message: mapGeminiErrorMessage(err) });
      res.end();
    }
  });

  app.post('/api/tts', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { text } = req.body as { text?: string };
      const cleaned = cleanTextForSpeech(text ?? '');
      if (!cleaned) {
        res.status(400).json({ error: 'Aucun texte à lire.' });
        return;
      }

      const callTts = async (apiVer: 'v1beta' | 'v1alpha') => {
        const aiTts = getAIVersionedClient(apiVer);
        return aiTts.models.generateContent({
          model: MODEL_TTS,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: cleaned,
                  speechMetadata: {
                    style: 'Clear, natural, warm, articulate voice',
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
        });
      };

      let response;
      try {
        response = await callTts('v1beta');
      } catch (betaErr) {
        console.warn('TTS v1beta failed, trying v1alpha:', betaErr);
        response = await callTts('v1alpha');
      }

      const part = response.candidates?.[0]?.content?.parts?.find(
        (p) => p.inlineData?.data,
      );
      if (!part?.inlineData?.data) {
        res.status(502).json({ error: 'Audio non généré', fallback: true });
        return;
      }

      const mime = part.inlineData.mimeType || 'audio/wav';
      res.json({
        audioDataUrl: `data:${mime};base64,${part.inlineData.data}`,
      });
    } catch (err) {
      console.warn('Error in /api/tts:', err);
      res.status(503).json({
        error: mapGeminiErrorMessage(err),
        fallback: true,
      });
    }
  });

  app.post('/api/generate-image', requireAuth, async (req: AuthenticatedRequest, res) => {
    const limitCheck = await checkAndConsumeDailyLimit(req.authUser!.id);
    if (!limitCheck.allowed) {
      res.status(429).json({
        error: `Limite quotidienne de ${limitCheck.limit} requêtes atteinte pour aujourd'hui.`,
      });
      return;
    }
    try {
      const { prompt, style = 'auto', referenceImage } = req.body as {
        prompt?: string;
        style?: 'auto' | 'photo' | '3d' | 'illustration';
        referenceImage?: { mimeType: string; base64: string; name: string };
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Veuillez fournir une description pour créer l’image.' });
        return;
      }

      const ai = getAIClient();
      const cleanPrompt = prompt.trim();
      const lowerPrompt = cleanPrompt.toLowerCase();
      const wants3D =
        style === '3d' ||
        /\b3d\b|isométri|blender|rendu 3d|volumétri|futurist/i.test(lowerPrompt);

      // If user attached a real photo and asks to edit/adjust/crop/filter/annotate it without 3D/illustration reinterpretation
      const isPhotographicRetouch =
        Boolean(referenceImage?.base64) &&
        !wants3D &&
        style !== 'illustration' &&
        (style === 'photo' ||
          /luminos|contrast|satur|noir et blanc|gris|sépia|sepia|chaleur|chaud|froid|vignette|flou|net|recadr|rogne|pivot|tourne|rotation|miroir|texte|titre|légende|filigrane|cadre|bordure|retouche|améliore|éclairc|assombr|couleur/i.test(
            lowerPrompt,
          ));

      if (isPhotographicRetouch && referenceImage?.base64) {
        const editRes = await ai.models.generateContent({
          model: MODEL_PRIMARY,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: referenceImage.mimeType,
                    data: referenceImage.base64,
                  },
                },
                {
                  text: `L'utilisateur souhaite modifier sa photo (${referenceImage.name}) sans la déformer : "${cleanPrompt}".
Traduis exactement sa demande en paramètres numériques précis de retouche photo (brightness 100=normal, contrast 100=normal, saturation 100=normal, grayscale 0..100, sepia 0..100, hueRotate -180..180, blur 0..20, warmth -50..+50, vignette 0..100, rotateDeg 0/90/180/270, flipHorizontal, flipVertical, crop xPct/yPct/widthPct/heightPct, overlayText, overlayPosition, overlayColor, borderColor, borderWidth, outputFormat). Ne renseigne que les paramètres pertinents.`,
                },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                caption: { type: Type.STRING },
                brightness: { type: Type.NUMBER },
                contrast: { type: Type.NUMBER },
                saturation: { type: Type.NUMBER },
                grayscale: { type: Type.NUMBER },
                sepia: { type: Type.NUMBER },
                hueRotate: { type: Type.NUMBER },
                blur: { type: Type.NUMBER },
                warmth: { type: Type.NUMBER },
                vignette: { type: Type.NUMBER },
                rotateDeg: { type: Type.INTEGER },
                flipHorizontal: { type: Type.BOOLEAN },
                flipVertical: { type: Type.BOOLEAN },
                overlayText: { type: Type.STRING },
                overlayPosition: { type: Type.STRING },
                overlayColor: { type: Type.STRING },
                borderColor: { type: Type.STRING },
                borderWidth: { type: Type.NUMBER },
                outputFormat: { type: Type.STRING },
              },
              required: ['title', 'caption'],
            },
          },
        });

        const parsedEdit = JSON.parse((editRes.text ?? '{}').trim()) as PhotoEditSpec;
        res.json({
          photoEdit: {
            ...parsedEdit,
            sourceAttachmentName: referenceImage.name,
          },
          caption: parsedEdit.caption || `Voici votre photo retouchée sans altération (« ${cleanPrompt} »).`,
        });
        return;
      }

      const wantsRealPhoto =
        !referenceImage?.base64 &&
        !wants3D &&
        style !== 'illustration' &&
        (style === 'photo' ||
          /photo|paysage|coucher|soleil|désert|montagne|mer|océan|ville|galaxie|étoile|ciel|aurore|forêt|animal|chat|chien|lion|fleur|tour eiffel|paris|tokyo|new york/i.test(
            lowerPrompt,
          ));

      if (wantsRealPhoto) {
        const realPhoto = await fetchRealWikimediaPhoto(ai, cleanPrompt);
        if (realPhoto) {
          const visual: GeneratedVisual = {
            id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title: realPhoto.title,
            prompt: cleanPrompt,
            dataUrl: realPhoto.dataUrl,
            width: realPhoto.width,
            height: realPhoto.height,
            isRaster: true,
            mimeType: realPhoto.mimeType,
            style: 'photo',
            sourceUrl: realPhoto.sourceUrl,
            note: 'Photographie réelle haute résolution · Wikimedia Commons',
          };
          res.json({
            visual,
            caption: `Voici une photographie réelle correspondant à « ${cleanPrompt} ».`,
          });
          return;
        }
      }

      // Ultra-detailed 1200x780 3D / volumetric / atmospheric render
      const parts: Part[] = [];
      if (referenceImage?.base64) {
        parts.push({
          inlineData: {
            mimeType: referenceImage.mimeType,
            data: referenceImage.base64,
          },
        });
        parts.push({
          text: `Voici une image de référence (${referenceImage.name}). Réinterprète, améliore ou transforme cette scène en une composition SVG haute définition (1200x780) ultra-détaillée avec lumières, ombres, dégradés réalistes et profondeur selon : "${cleanPrompt}".`,
        });
      } else if (wants3D) {
        parts.push({
          text: `Crée un RENDU 3D ultra-détaillé et photoréaliste en SVG (viewBox="0 0 1200 780") pour : "${cleanPrompt}".
Exigences impératives de réalisme 3D :
- Perspective 3D rigoureuse (faces éclairées, faces ombrées, réflexions spéculaires, occlusions ambiantes).
- Utilise des filtres SVG (<feGaussianBlur>, <feDropShadow>, <feSpecularLighting>, <feDiffuseLighting>) et au moins 12 dégradés multi-stops (<linearGradient>, <radialGradient>) pour simuler la lumière globale, les reflets métalliques/vitreux et la profondeur de champ.
- Minimum 40 primitives géométriques et organiques superposées avec arrière-plan complet, sol texturé/réfléchissant et éclairage atmosphérique.`,
        });
      } else {
        parts.push({
          text: `Crée une composition visuelle cinématique haute définition (viewBox="0 0 1200 780") extrêmement réaliste et riche en détails pour : "${cleanPrompt}".
Exigences impératives :
- Multiples plans de profondeur (ciel atmosphérique multi-dégradés, horizon brumeux avec feGaussianBlur, plan intermédiaire détaillé, premier plan net avec ombres portées et reflets réalistes sur l'eau ou le sol).
- Minimum 40 éléments SVG soignés, éclairage directionnel cohérent, halo solaire/stellaire réaliste et palettes naturelles riches.`,
        });
      }

      const runImageGen = (model: string) =>
        ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction:
              "Tu es un directeur artistique et spécialiste 3D/rendu photoréaliste. Tu produis des scènes SVG 1200x780 d'une richesse visuelle exceptionnelle (éclairages volumétriques, dégradés complexes, ombres, reflets, profondeur, aucun script ni ressource externe). Réponds strictement selon le schéma JSON.",
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                caption: { type: Type.STRING },
                width: { type: Type.INTEGER },
                height: { type: Type.INTEGER },
                svgMarkup: { type: Type.STRING },
              },
              required: ['title', 'caption', 'width', 'height', 'svgMarkup'],
            },
          },
        });

      let response;
      try {
        response = await runImageGen(MODEL_PRIMARY);
      } catch (imgErr) {
        const msg = imgErr instanceof Error ? imgErr.message.toLowerCase() : String(imgErr).toLowerCase();
        if (msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted')) {
          response = await runImageGen(MODEL_FALLBACK);
        } else {
          throw imgErr;
        }
      }

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        title?: string;
        caption?: string;
        width?: number;
        height?: number;
        svgMarkup?: string;
      };

      const svgMarkup = sanitizeSvg(parsed.svgMarkup ?? '');
      if (!svgMarkup.startsWith('<svg')) {
        res.status(500).json({ error: "Impossible de générer le visuel demandé. Réessayez avec une description plus précise." });
        return;
      }

      const visual: GeneratedVisual = {
        id: `vis_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: parsed.title || 'Visuel Gaius',
        prompt: cleanPrompt,
        svgMarkup,
        dataUrl: svgToDataUrl(svgMarkup),
        width: parsed.width || 1200,
        height: parsed.height || 780,
        style: wants3D ? '3d' : 'illustration',
        note: wants3D
          ? 'Rendu 3D haute netteté (export PNG 2400px & SVG · rendu photo IA pixel par pixel via clé API payante dans Settings > Secrets)'
          : 'Composition visuelle haute netteté (export PNG 2400px & SVG)',
      };

      res.json({
        visual,
        caption: parsed.caption || `Voici le visuel créé pour « ${cleanPrompt} ».`,
      });
    } catch (err) {
      console.error('Error in /api/generate-image:', err);
      res.status(500).json({ error: mapGeminiErrorMessage(err) });
    }
  });

  app.post('/api/generate-music', requireAuth, async (req: AuthenticatedRequest, res) => {
    const limitCheck = await checkAndConsumeDailyLimit(req.authUser!.id);
    if (!limitCheck.allowed) {
      res.status(429).json({
        error: `Limite quotidienne de ${limitCheck.limit} requêtes atteinte pour aujourd'hui.`,
      });
      return;
    }
    try {
      const { prompt, projectContext } = req.body as {
        prompt?: string;
        projectContext?: ChatRequestPayload['projectContext'];
      };

      if (!prompt || !prompt.trim()) {
        res.status(400).json({ error: 'Veuillez décrire la chanson ou le style musical souhaité.' });
        return;
      }

      const ai = getAIClient();
      const cleanPrompt = prompt.trim();
      const projectNote = projectContext
        ? `\nProjet associé : ${projectContext.title} (${projectContext.category}) — ${projectContext.description}.`
        : '';

      const runMusicGen = (model: string) =>
        ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Compose une chanson complète, authentique et inspirante pour la demande suivante : "${cleanPrompt}".${projectNote}
Choisis le rythme le plus fidèle parmi : ${ALLOWED_RHYTHMS.join(', ')}.
Choisis 3 à 5 instruments adaptés parmi : ${ALLOWED_INSTRUMENTS.join(', ')}.
Crée une progression de 4 accords, une mélodie de 8 à 16 notes (ex: C4, E4, G4, A4, G4, E4, D4, C4) et au moins 4 sections de paroles complètes (Couplet 1, Refrain, Couplet 2, Pont / Refrain final) dans la langue demandée (français par défaut, ou lingala/anglais/espagnol/arabe selon le style demandé).`,
                },
              ],
            },
          ],
          config: {
            systemInstruction:
              'Tu es un compositeur, arrangeur et parolier international de génie maîtrisant tous les rythmes du monde (rumba congolaise, afrobeats, amapiano, salsa, reggaeton, bossa nova, reggae, raï, flamenco, bollywood, hip-hop, pop, rock, jazz, électro, classique, gospel, lo-fi). Réponds uniquement en JSON valide conforme au schéma.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: musicTrackSchemaProperties,
              required: [
                'title',
                'genre',
                'origin',
                'rhythmPreset',
                'bpm',
                'musicalKey',
                'mood',
                'instruments',
                'instrumentLabels',
                'chordProgression',
                'melodyNotes',
                'sections',
                'description',
              ],
            },
          },
        });

      let response;
      try {
        response = await runMusicGen(MODEL_PRIMARY);
      } catch (musicErr) {
        const msg = musicErr instanceof Error ? musicErr.message.toLowerCase() : String(musicErr).toLowerCase();
        if (msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted')) {
          response = await runMusicGen(MODEL_FALLBACK);
        } else {
          throw musicErr;
        }
      }

      const raw = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
      const spec = normalizeMusicSpec(raw, cleanPrompt);
      const music: GeneratedMusic = {
        id: `mus_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        prompt: cleanPrompt,
        spec,
        createdAt: Date.now(),
      };

      res.json({
        music,
        caption: `Voici votre composition **${spec.title}** (${spec.genre} · ${spec.origin}, ${spec.bpm} BPM). Vous pouvez écouter l'arrangement instrumental, lancer la voix sur les paroles ou télécharger le fichier audio WAV.`,
      });
    } catch (err) {
      console.error('Error in /api/generate-music:', err);
      res.status(500).json({ error: mapGeminiErrorMessage(err) });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const liveWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (request, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname;
    if (pathname === '/api/live') {
      const token = extractSessionToken(request);
      const auth = await authenticateToken(token);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      liveWss.handleUpgrade(request, socket, head, (ws) => {
        liveWss.emit('connection', ws, request);
      });
    }
  });

  liveWss.on('connection', (clientWs: WebSocket, req) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const initialVoiceParam = (urlObj.searchParams.get('voice') || 'Zephyr') as LiveVoiceName;

    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let closed = false;
    let initialized = false;

    const sendJson = (payload: Record<string, unknown>) => {
      if (!closed && clientWs.readyState === 1) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const startLiveSession = async (setup: {
      voice?: LiveVoiceName;
      memories?: Array<{ id: string; content: string; category?: string }>;
      contextSummary?: string;
    }) => {
      if (initialized || closed) return;
      initialized = true;

      const allowedVoices: LiveVoiceName[] = ['Zephyr', 'Kore', 'Puck', 'Charon', 'Fenrir'];
      const voiceName: LiveVoiceName = allowedVoices.includes(setup.voice ?? initialVoiceParam)
        ? (setup.voice ?? initialVoiceParam)
        : 'Zephyr';

      const memoriesBlock =
        setup.memories && setup.memories.length > 0
          ? `\nMémoires enregistrées sur l'utilisateur :\n${setup.memories
              .map((m) => `- ${m.content}`)
              .join('\n')}`
          : '';
      const contextBlock = setup.contextSummary?.trim()
        ? `\nContexte récent de la conversation écrite :\n${setup.contextSummary.slice(0, 1500)}`
        : '';

      const systemInstruction = `Tu es Gaius, un assistant vocal intelligent, chaleureux, cultivé et naturel.
Tu parles par défaut en français (ou dans la langue dans laquelle l'utilisateur te parle), de façon fluide, claire et concise comme dans une vraie discussion orale.
Si l'utilisateur te demande de mémoriser ou retenir quelque chose, appelle l'outil save_memory immédiatement et confirme-le oralement. Si l'utilisateur demande d'oublier quelque chose, appelle delete_memory.${memoriesBlock}${contextBlock}`;

      const connectWithVersion = async (apiVer: 'v1beta' | 'v1alpha') => {
        const aiLive = getAIVersionedClient(apiVer);
        return aiLive.live.connect({
          model: MODEL_LIVE,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction,
            tools: [{ functionDeclarations: [liveSaveMemoryDecl, liveDeleteMemoryDecl] }],
          },
          callbacks: {
            onopen: () => {
              sendJson({ type: 'ready', voice: voiceName });
            },
            onmessage: (message: LiveServerMessage) => {
              const sc = message.serverContent;
              if (sc?.inputTranscription?.text) {
                sendJson({ type: 'input_transcript', text: sc.inputTranscription.text });
              }
              if (sc?.outputTranscription?.text) {
                sendJson({ type: 'output_transcript', text: sc.outputTranscription.text });
              }
              if (sc?.interrupted) {
                sendJson({ type: 'interrupted' });
              }
              if (sc?.turnComplete) {
                sendJson({ type: 'turn_complete' });
              }

              for (const part of sc?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) {
                  sendJson({ type: 'audio', data: part.inlineData.data });
                }
              }

              for (const call of message.toolCall?.functionCalls ?? []) {
                if (call.name === 'save_memory') {
                  const content = String(call.args?.content ?? '').trim();
                  const category = call.args?.category ? String(call.args.category) : undefined;
                  if (content) {
                    sendJson({
                      type: 'memory_event',
                      memory: { action: 'saved', content, category },
                    });
                  }
                  session?.sendToolResponse({
                    functionResponses: [
                      {
                        id: call.id,
                        name: call.name,
                        response: { status: 'saved', content },
                      },
                    ],
                  });
                } else if (call.name === 'delete_memory') {
                  const query = String(call.args?.query ?? '').trim();
                  if (query) {
                    sendJson({
                      type: 'memory_event',
                      memory: { action: 'deleted', content: query },
                    });
                  }
                  session?.sendToolResponse({
                    functionResponses: [
                      {
                        id: call.id,
                        name: call.name,
                        response: { status: 'deleted', query },
                      },
                    ],
                  });
                }
              }
            },
            onerror: (err: unknown) => {
              console.warn('Gemini Live session error:', err);
              sendJson({ type: 'error', message: mapGeminiErrorMessage(err) });
            },
            onclose: () => {
              sendJson({ type: 'closed' });
            },
          },
        });
      };

      try {
        try {
          session = await connectWithVersion('v1beta');
        } catch (betaErr) {
          console.warn('Live v1beta failed, trying v1alpha:', betaErr);
          session = await connectWithVersion('v1alpha');
        }
        sendJson({ type: 'ready', voice: voiceName });
      } catch (err) {
        console.error('Failed to connect Gemini Live:', err);
        sendJson({ type: 'error', message: mapGeminiErrorMessage(err) });
      }
    };

    const autoInitTimer = setTimeout(() => {
      if (!initialized) {
        void startLiveSession({ voice: initialVoiceParam });
      }
    }, 1000);

    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          voice?: LiveVoiceName;
          memories?: Array<{ id: string; content: string; category?: string }>;
          contextSummary?: string;
          data?: string;
          text?: string;
        };

        if (msg.type === 'setup') {
          clearTimeout(autoInitTimer);
          void startLiveSession(msg);
          return;
        }

        if (!session) return;

        if (msg.type === 'audio' && msg.data) {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (msg.type === 'text' && msg.text) {
          session.sendRealtimeInput({ text: msg.text });
        }
      } catch {
        // Ignore malformed WS frame
      }
    });

    clientWs.on('close', () => {
      closed = true;
      clearTimeout(autoInitTimer);
      try {
        session?.close();
      } catch {
        // Ignore
      }
      session = null;
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Gaius IA server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
