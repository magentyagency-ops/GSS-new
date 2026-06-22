// ─── Overlay de la synthèse IA sur AO RNE.pdf ───
// Au lieu d'éditer le .docx (où le texte reflue et décale la mise en page), on DESSINE le texte
// par-dessus le PDF figé, à l'intérieur du cadre délimité par les balises « Contexte sur mesure
// début » (haut) et « … fin » (bas). Rien ne peut refluer : la mise en page reste intacte.

import fs from 'fs';
// @ts-ignore — types fournis par @types/pdf-parse
import pdfParse from 'pdf-parse';
import { PDFDocument, PDFFont, PDFPage, PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, decodePDFRawStream, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// ─── Réglages (ajustables après validation visuelle) ───
const BOX_LEFT = 93;          // bord gauche du cadre (le « des marqueurs est à x≈95)
const BOX_RIGHT = 503;        // bord droit (≈ largeur de contenu des titres de la page)
const FONT_SIZE = 10.5;       // taille du corps de texte (pt)
const LINE_LEADING = 1.32;    // interligne (× taille)
const PARA_INDENT = 18;       // alinéa de 1re ligne de chaque paragraphe (pt)
const TOP_INSET = 2;          // marge sous le marqueur d'ouverture avant la 1re ligne
const BOTTOM_INSET = 4;       // marge au-dessus du marqueur « fin »
const MASK_PAD_TOP = 15;      // recouvrement au-dessus de la base du marqueur (hauteur de glyphe)
const MASK_PAD_BOTTOM = 6;
const MODERATE_FILL = 0.92;   // remplissage quasi complet des cadres (petite marge anti-débordement)

// Couleurs du design (mêmes que les autres pages) — ajustables.
const BG_HEX = 'D9D9D9';      // aplat gris clair des pages de corps
const TEXT_HEX = '1A1A1A';    // texte sombre, lisible sur le gris

export interface ZoneBox {
  pageIndex: number;          // index 0-based de la page
  topY: number;               // y (PDF, origine bas) du marqueur d'ouverture = haut du cadre
  bottomY: number;            // y du marqueur « fin » = bas du cadre
}

/** Contexte client pour reconstruire les libellés personnalisés (sites / nom / référence du marché). */
export interface RefContext { sites: string[]; client: string; marketRef: string; }

/**
 * Règle de remplacement d'une référence figée (ancien client/sites) par sa valeur personnalisée.
 * `match` est testé sur la chaîne de CHAQUE item de texte du PDF ; `build` reconstruit l'item entier.
 * Couleurs par défaut = corps gris du design ; à surcharger si le libellé est sur un autre fond.
 */
export interface RefReplacement {
  match: RegExp;
  build: (ctx: RefContext) => string;
  bgHex?: string;
  textHex?: string;
}

/** Zone surlignée par l'utilisateur dans le PDF (annotation /Highlight) + texte existant dessous. */
export interface HighlightRegion {
  pageIndex: number;
  left: number; right: number; top: number; bottom: number;  // bbox en points (origine bas-gauche)
  text: string;                                               // texte existant sous le surlignage
  fontSize?: number;                                          // taille de police d'origine (pt)
  maxBottom?: number;                                         // y-plancher : un bloc ajouté peut descendre jusque-là (sans recouvrir le texte en dessous)
}

/** Zone surlignée + texte personnalisé à dessiner à la place. */
export interface HighlightFill extends HighlightRegion {
  newText: string;
  bgHex?: string;
  textHex?: string;
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const CONTEXT_RE = /contexte\s+sur\s+mesure/i;
const FIN_RE = /\bfin\b/i;

/**
 * Repère les cadres éditables dans le PDF : sur chaque page, le marqueur d'ouverture
 * (« Contexte sur mesure [début] » SANS « fin ») donne le haut du cadre, et « … fin » le bas.
 * Renvoie une zone par page concernée, dans l'ordre des pages.
 */
export async function findZoneBoxes(pdfBuffer: Buffer): Promise<ZoneBox[]> {
  const boxes: ZoneBox[] = [];
  await pdfParse(pdfBuffer, {
    pagerender: (pd: any) => pd.getTextContent().then((tc: any) => {
      const page: number = pd.pageNumber;
      let openY: number | null = null;
      let finY: number | null = null;
      for (const it of tc.items) {
        const t = (it.str || '').trim();
        if (!t || !CONTEXT_RE.test(t)) continue;
        const y = it.transform[5];
        if (FIN_RE.test(t)) finY = y;       // « Contexte sur mesure fin »
        else openY = y;                     // « Contexte sur mesure » / « … début »
      }
      // Marqueurs parfois éclatés en items séparés : reconstituer via le voisinage.
      if (openY === null || finY === null) {
        const ys = tc.items.filter((it: any) => CONTEXT_RE.test((it.str || '')))
          .map((it: any) => it.transform[5]);
        const fins = tc.items.filter((it: any) => FIN_RE.test((it.str || '')) && it.transform[5] < 200)
          .map((it: any) => it.transform[5]);
        if (openY === null && ys.length) openY = Math.max(...ys);
        if (finY === null && fins.length) finY = Math.min(...fins);
      }
      if (openY !== null && finY !== null && openY > finY) {
        boxes.push({ pageIndex: page - 1, topY: openY, bottomY: finY });
      }
      return '';
    }),
  });
  return boxes.sort((a, b) => a.pageIndex - b.pageIndex);
}

/** bbox (union des QuadPoints) d'une annotation /Highlight, ou null si illisible. */
function highlightBBox(dict: PDFDict): { left: number; right: number; top: number; bottom: number } | null {
  let arr = dict.lookupMaybe(PDFName.of('QuadPoints'), PDFArray);
  if (!arr) arr = dict.lookupMaybe(PDFName.of('Rect'), PDFArray); // repli : rectangle de l'annotation
  if (!arr) return null;
  const nums = arr.asArray().map((o) => (o instanceof PDFNumber ? o.asNumber() : NaN)).filter((n) => !isNaN(n));
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(nums[i]); ys.push(nums[i + 1]); }
  if (!xs.length) return null;
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) };
}

/**
 * Repère les zones surlignées (annotations /Highlight) dans le PDF et récupère le texte existant
 * dessous (items dont la base tombe dans la bbox). Une zone par annotation. Sert à laisser
 * l'utilisateur DÉSIGNER, surligneur en main, les passages à personnaliser.
 */
export async function findHighlightRegions(pdfBuffer: Buffer): Promise<HighlightRegion[]> {
  const doc = await PDFDocument.load(pdfBuffer);
  const pages = doc.getPages();
  const boxesPerPage: Array<Array<{ left: number; right: number; top: number; bottom: number }>> = pages.map(() => []);

  pages.forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookupMaybe(i, PDFDict);
      if (!dict) continue;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.asString() !== '/Highlight') continue;
      const bb = highlightBBox(dict);
      if (bb) boxesPerPage[pi].push(bb);
    }
  });

  const total = boxesPerPage.reduce((s, b) => s + b.length, 0);
  if (total === 0) return [];

  const regions: HighlightRegion[] = [];
  await pdfParse(pdfBuffer, {
    pagerender: (pd: any) => pd.getTextContent().then((tc: any) => {
      const pi = pd.pageNumber - 1;
      const boxes = boxesPerPage[pi];
      if (!boxes || !boxes.length) return '';
      const buckets: Array<Array<{ x: number; y: number; s: string }>> = boxes.map(() => []);
      for (const it of tc.items) {
        const s = (it.str || '');
        if (!s.trim()) continue;
        const x = it.transform[4], y = it.transform[5];
        for (let bi = 0; bi < boxes.length; bi++) {
          const b = boxes[bi];
          if (x >= b.left - 2 && x <= b.right + 2 && y >= b.bottom - 2 && y <= b.top + 2) { buckets[bi].push({ x, y, s }); break; }
        }
      }
      boxes.forEach((b, bi) => {
        const items = buckets[bi].sort((a, c) => (Math.abs(a.y - c.y) > 3 ? c.y - a.y : a.x - c.x));
        const text = items.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();
        regions.push({ pageIndex: pi, left: b.left, right: b.right, top: b.top, bottom: b.bottom, text });
      });
      return '';
    }),
  });
  return regions.filter((r) => r.text).sort((a, b) => a.pageIndex - b.pageIndex || b.top - a.top);
}

/** Supprime toutes les annotations /Highlight (sinon le jaune resterait visible par-dessus le masque). */
function stripHighlightAnnotations(doc: PDFDocument) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const subtype = dict?.get(PDFName.of('Subtype'));
      if (subtype instanceof PDFName && subtype.asString() === '/Highlight') annots.remove(i);
    }
  }
}

/**
 * Mesure la capacité des cadres pour dimensionner le texte à générer EN AMONT (évite de coder en
 * dur un nombre de mots). Renvoie le nombre de zones, le total de lignes utiles (toutes zones, 2
 * colonnes, plafonné par `MODERATE_FILL`) et le nombre de caractères tenant sur une ligne de colonne.
 */
export async function measureZonesCapacity(
  pdfBuffer: Buffer, fontBytes: Buffer | null,
): Promise<{ zones: number; totalLines: number; charsPerLine: number; perZoneLines: number[] }> {
  const boxes = await findZoneBoxes(pdfBuffer);
  const doc = await PDFDocument.load(pdfBuffer);
  let font: PDFFont;
  if (fontBytes) { doc.registerFontkit(fontkit); font = await doc.embedFont(fontBytes, { subset: true }); }
  else font = await doc.embedFont(StandardFonts.Helvetica);

  const lineHeight = FONT_SIZE * LINE_LEADING;
  const blockWidth = BOX_RIGHT - BOX_LEFT;   // 1 colonne pleine largeur
  // Capacité (lignes) PAR zone, dans le MÊME ordre que `findZoneBoxes` (ordre de lecture des pages),
  // pour dimensionner le texte de chaque page indépendamment.
  const perZoneLines = boxes.map((b) => columnCapacity(b, lineHeight));
  const totalLines = perZoneLines.reduce((sum, n) => sum + n, 0);

  // Largeur moyenne d'un caractère « courant » à FONT_SIZE → nb de car. par ligne pleine largeur.
  const avgCharW = font.widthOfTextAtSize('en ara ti on le re', FONT_SIZE) / 18;
  const charsPerLine = Math.max(1, Math.floor(blockWidth / avgCharW));
  return { zones: boxes.length, totalLines, charsPerLine, perZoneLines };
}

/** Nb de lignes utiles dans UNE colonne d'un cadre (hauteur exploitable / interligne × remplissage). */
function columnCapacity(b: ZoneBox, lineHeight: number): number {
  const usable = (b.topY - TOP_INSET) - (b.bottomY + BOTTOM_INSET);
  const perCol = Math.max(0, Math.floor(usable / lineHeight));
  return Math.floor(perCol * MODERATE_FILL);
}

/** Découpe un paragraphe en lignes tenant dans `maxWidth` (sans couper les mots, sauf mot trop long).
 * `firstIndent` réserve un alinéa sur la 1re ligne (largeur dispo réduite d'autant). */
function wrapParagraph(text: string, maxWidth: number, font: PDFFont, size: number, firstIndent = 0): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const w = (s: string) => font.widthOfTextAtSize(s, size);
  const limit = () => maxWidth - (lines.length === 0 ? firstIndent : 0); // alinéa seulement sur la 1re ligne
  for (let word of words) {
    // mot plus large qu'une ligne → on le coupe caractère par caractère
    while (w(word) > limit() && word.length > 1) {
      let k = word.length;
      while (k > 1 && w(word.slice(0, k)) > limit()) k--;
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, k));
      word = word.slice(k);
    }
    const trial = cur ? cur + ' ' + word : word;
    if (w(trial) <= limit()) cur = trial;
    else { if (cur) lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

interface Line { text: string; justify: boolean; indent: number; }

/** Transforme des paragraphes en lignes (justification + alinéa de 1re ligne + respiration entre §). */
function paragraphsToLines(paras: string[], maxWidth: number, font: PDFFont, size: number, indent = 0): Line[] {
  const out: Line[] = [];
  paras.forEach((p, pi) => {
    const wl = wrapParagraph(p, maxWidth, font, size, indent);
    // dernière ligne d'un § non justifiée ; alinéa appliqué uniquement à la 1re ligne du §
    wl.forEach((t, i) => out.push({ text: t, justify: i < wl.length - 1, indent: i === 0 ? indent : 0 }));
    if (pi < paras.length - 1) out.push({ text: '', justify: false, indent: 0 });
  });
  return out;
}

/** Dessine une ligne ; si `justify`, répartit l'espace pour atteindre `width` (texte aligné des 2 côtés).
 * `line.indent` décale le début de ligne (alinéa) et réduit d'autant la largeur de justification. */
function drawLine(page: PDFPage, line: Line, x: number, y: number, width: number, font: PDFFont, size: number, color: any) {
  if (!line.text) return;
  const ind = line.indent || 0;
  const startX = x + ind;
  const lineWidth = width - ind;
  const words = line.text.split(' ');
  if (!line.justify || words.length === 1) {
    page.drawText(line.text, { x: startX, y, size, font, color });
    return;
  }
  const wordsWidth = words.reduce((s, wd) => s + font.widthOfTextAtSize(wd, size), 0);
  const gap = (lineWidth - wordsWidth) / (words.length - 1);
  let cursor = startX;
  for (const wd of words) {
    page.drawText(wd, { x: cursor, y, size, font, color });
    cursor += font.widthOfTextAtSize(wd, size) + gap;
  }
}

/** Dessine un ensemble de lignes dans UNE colonne (de haut en bas), borné à `maxLines`. */
function drawColumn(page: PDFPage, lines: Line[], x: number, topY: number, colWidth: number,
  lineHeight: number, font: PDFFont, size: number, color: any) {
  let y = topY - size;                 // 1re ligne juste sous le haut du cadre
  for (const line of lines) {
    drawLine(page, line, x, y, colWidth, font, size, color);
    y -= lineHeight;
  }
}

/**
 * Dessine la synthèse (texte continu) sur le PDF : répartit le texte sur les zones (pages 5–8),
 * 2 colonnes équilibrées par zone, mêmes couleurs/fond, sans déborder du cadre. Renvoie le PDF final.
 */
export async function overlaySynthesis(
  pdfBuffer: Buffer, fullText: string, fontBytes: Buffer | null,
  replacements: RefReplacement[] = [], refCtx?: RefContext, highlightFills: HighlightFill[] = [],
  opts: { zoneTexts?: string[]; docTitle?: string } = {},
): Promise<{ bytes: Uint8Array; zonesUsed: number; linesDrawn: number; truncated: boolean; refsReplaced: number; highlightsFilled: number }> {
  const boxes = await findZoneBoxes(pdfBuffer);
  const doc = await PDFDocument.load(pdfBuffer);
  // Titre interne du PDF (onglet du lecteur) : remplace celui hérité du template (ancien client).
  if (opts.docTitle?.trim()) doc.setTitle(opts.docTitle.trim());
  let font: PDFFont;
  if (fontBytes) { doc.registerFontkit(fontkit); font = await doc.embedFont(fontBytes, { subset: true }); }
  else font = await doc.embedFont(StandardFonts.Helvetica);

  const pages = doc.getPages();
  const bg = hexToRgb(BG_HEX);
  const textColor = hexToRgb(TEXT_HEX);
  const blockWidth = BOX_RIGHT - BOX_LEFT;   // un seul bloc pleine largeur (au lieu de 2 colonnes)
  const lineHeight = FONT_SIZE * LINE_LEADING;

  // Capacité (lignes, 1 colonne pleine largeur) par zone, plafonnée par le taux de remplissage.
  const caps = boxes.map((b) => columnCapacity(b, lineHeight));

  // Mode PAR ZONE : un texte propre à chaque page (zoneTexts[i]). Sinon (fallback rétro-compatible),
  // un seul bloc continu réparti proportionnellement sur toutes les zones.
  const perZoneMode = Array.isArray(opts.zoneTexts) && opts.zoneTexts.length > 0;
  const toLines = (txt: string) => paragraphsToLines(
    txt.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean),
    blockWidth, font, FONT_SIZE, PARA_INDENT,
  );
  // Fallback : tout le texte découpé une fois, réparti à la ligne.
  const allLines = perZoneMode ? [] : toLines(fullText);

  let cursor = 0, linesDrawn = 0, zonesUsed = 0;
  let truncated = false;

  boxes.forEach((b, i) => {
    const page = pages[b.pageIndex];
    if (!page) return;
    // Masque : recouvre le cadre (et les marqueurs) avec l'aplat de fond du design.
    const rectBottom = b.bottomY - MASK_PAD_BOTTOM;
    const rectTop = b.topY + MASK_PAD_TOP;
    page.drawRectangle({ x: BOX_LEFT - 4, y: rectBottom, width: (BOX_RIGHT - BOX_LEFT) + 8, height: rectTop - rectBottom, color: bg });

    let zoneLines: Line[];
    if (perZoneMode) {
      // Le texte de CETTE page, borné à la capacité du cadre (surplus tronqué, jamais de débordement).
      const zLines = toLines(opts.zoneTexts![i] || '');
      if (zLines.length > caps[i]) truncated = true;
      zoneLines = zLines.slice(0, caps[i]);
    } else {
      // Répartition PROPORTIONNELLE à la capacité restante : si le texte ne suffit pas à tout remplir,
      // il est étalé sur TOUTES les zones (aucune page laissée vide) ; s'il y en a assez, chaque cadre
      // est rempli jusqu'à SA capacité et le surplus est tronqué.
      const remainingLines = allLines.length - cursor;
      const remainingCap = caps.slice(i).reduce((s, c) => s + c, 0) || 1;
      const isLast = i === boxes.length - 1;
      const take = Math.min(
        caps[i],
        remainingLines,
        isLast ? remainingLines : Math.round(remainingLines * (caps[i] / remainingCap)),
      );
      if (take <= 0) return;
      zoneLines = allLines.slice(cursor, cursor + take);
      cursor += take;
    }
    if (!zoneLines.length) return;
    zonesUsed++;
    linesDrawn += zoneLines.filter((l) => l.text).length;

    // Un seul bloc paragraphé pleine largeur (justifié, alinéa de 1re ligne) de haut en bas.
    drawColumn(page, zoneLines, BOX_LEFT, b.topY - TOP_INSET, blockWidth, lineHeight, font, FONT_SIZE, textColor);
  });

  if (!perZoneMode && cursor < allLines.filter((l) => l.text).length) truncated = true;

  // Personnalisation des références figées (ancien client / sites / libellés) par masque+redraw.
  let refsReplaced = 0;
  if (replacements.length && refCtx) {
    refsReplaced = await applyRefReplacements(pdfBuffer, pages, font, replacements, refCtx);
  }

  // Personnalisation des passages surlignés par l'utilisateur : RÉÉCRITURE EN PLACE. On SUPPRIME
  // d'abord l'ancien texte du flux PDF (plus rien de copiable dessous), puis on MASQUE le surlignage
  // jaune restant avec le fond local détecté et on redessine le texte personnalisé à la MÊME TAILLE,
  // de `top` vers le bas, étendu si besoin dans l'espace libre (jusqu'à `maxBottom`).
  // `newText` = le remplacement complet du passage.
  //
  // La suppression doit précéder TOUT dessin pdf-lib sur ces pages (elle remplace le flux Contents) :
  // on regroupe donc les zones par page et on purge le texte AVANT la boucle de redessin.
  const fillsByPage = new Map<number, HighlightFill[]>();
  for (const f of highlightFills) {
    if (!f.newText?.trim()) continue;
    (fillsByPage.get(f.pageIndex) || fillsByPage.set(f.pageIndex, []).get(f.pageIndex)!).push(f);
  }
  let textBlocksRemoved = 0;
  for (const [pi, pageFills] of fillsByPage) {
    const page = pages[pi];
    if (!page) continue;
    textBlocksRemoved += removeTextInRegions(page, pageFills.map((f) => ({ left: f.left, right: f.right, top: f.top, bottom: f.bottom })));
  }
  if (textBlocksRemoved) console.log(`[pdf_overlay] ${textBlocksRemoved} bloc(s) de texte surligné retiré(s) du flux PDF (suppression réelle).`);

  let highlightsFilled = 0;
  for (const f of highlightFills) {
    const page = pages[f.pageIndex];
    if (!page || !f.newText?.trim()) continue;
    drawTextBlock(
      page, f.newText.trim(),
      { left: f.left, right: f.right, top: f.top, bottom: f.bottom, maxBottom: f.maxBottom, fontSize: f.fontSize },
      font, hexToRgb(f.bgHex || BG_HEX), hexToRgb(f.textHex || TEXT_HEX), true,
    );
    highlightsFilled++;
  }
  if (highlightFills.length) stripHighlightAnnotations(doc);

  return { bytes: await doc.save(), zonesUsed, linesDrawn, truncated, refsReplaced, highlightsFilled };
}

/**
 * Lit le flux de contenu (Contents) d'une page, décompressé, sous forme de chaîne latin1.
 * Concatène les sous-flux si Contents est un tableau.
 */
function readPageContent(page: PDFPage): string {
  const contents = page.node.Contents();
  const dec = (s: any) => Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1');
  if (contents instanceof PDFArray) {
    let out = '';
    for (let i = 0; i < contents.size(); i++) out += dec(contents.lookup(i)) + '\n';
    return out;
  }
  if (contents instanceof PDFRawStream) return dec(contents);
  return '';
}

/**
 * SUPPRIME RÉELLEMENT du flux PDF le texte des paragraphes surlignés (au lieu de seulement le masquer) :
 * plus rien n'est sélectionnable/copiable sous le nouveau texte. Chaque bloc de texte du flux est un
 * `BT … x y Tm … [(...)] TJ … ET` à matrice de texte ABSOLUE : on calcule sa ligne de base (x, y) et,
 * si elle tombe dans la bbox d'un paragraphe surligné, on vide ses opérandes d'affichage de texte
 * (`[…] TJ` → `[] TJ`, `(…) Tj` → `() Tj`) en conservant tout le positionnement → aucun autre bloc n'est
 * décalé. Le surlignage jaune (aplat vectoriel) reste, lui, recouvert par le masque du redessin.
 * Renvoie le nombre de blocs vidés.
 */
function removeTextInRegions(page: PDFPage, boxes: Array<{ left: number; right: number; top: number; bottom: number }>): number {
  if (!boxes.length) return 0;
  const stream = readPageContent(page);
  if (!stream) return 0;
  const tmRe = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
  const tjArr = /\[[\s\S]*?\]\s*TJ/g;
  const tjStr = /\((?:[^()\\]|\\[\s\S])*\)\s*Tj/g;
  let hit = 0;
  const out = stream.replace(/\bBT\b([\s\S]*?)\bET\b/g, (m, inner) => {
    const tms = [...inner.matchAll(tmRe)];
    if (!tms.length) return m;
    const last = tms[tms.length - 1];
    const x = parseFloat(last[5]), y = parseFloat(last[6]);
    const inside = boxes.some((b) => x >= b.left - 6 && x <= b.right + 6 && y >= b.bottom - 4 && y <= b.top + 4);
    if (!inside) return m;
    hit++;
    return 'BT' + inner.replace(tjArr, '[] TJ').replace(tjStr, '() Tj') + 'ET';
  });
  if (!hit) return 0;
  // Remplace Contents par un flux unique (compressé) ; pdf-lib ajoutera ensuite ses propres opérateurs
  // de dessin (masque + nouveau texte) dans un flux distinct, donc PAR-DESSUS ce contenu nettoyé.
  const newStream = page.doc.context.flateStream(out);
  const ref = page.doc.context.register(newStream);
  page.node.set(PDFName.of('Contents'), ref);
  return hit;
}

/** Découpe un texte en phrases (fin = . ! ? … suivi d'un espace), pour pouvoir en retirer par la fin
 *  sans jamais couper au milieu d'une phrase. */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]+(?:["»)\]]+)?\s*|[^.!?…]+$/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : [text.trim()];
}

/**
 * Dessine un bloc de texte à la TAILLE D'ORIGINE (jamais rétréci) entre `box.top` (haut) et le plancher
 * (`maxBottom` si plus haut que `bottom`, sinon `bottom`). Si le texte ne tient pas, on retire des
 * PHRASES ENTIÈRES par la fin (jamais de coupe au milieu d'une phrase ni de réduction de police).
 * `mask=true` recouvre d'abord la zone (cas remplacement) ; `mask=false` n'écrit que par-dessus
 * l'existant sans rien masquer (cas AJOUT sous un paragraphe pristine — on ne touche pas l'original).
 */
function drawTextBlock(
  page: PDFPage, text: string,
  box: { left: number; right: number; top: number; bottom: number; fontSize?: number; maxBottom?: number },
  font: PDFFont, bg: any, color: any, mask = true,
) {
  const width = box.right - box.left;
  // Plancher = espace libre mesuré sous le surlignage (sinon, bas de la bbox d'origine).
  const floor = box.maxBottom !== undefined && box.maxBottom < box.bottom ? box.maxBottom : box.bottom;
  if (width <= 0 || box.top - floor <= 0) return;

  // Taille = celle du texte d'origine (corps standard en repli) — AUCUNE réduction (homogénéité).
  const lead = 1.2;
  const size = box.fontSize && box.fontSize > 4 ? box.fontSize : FONT_SIZE;
  const lineHeight = size * lead;
  // Nb de lignes qui tiennent du haut du cadre jusqu'au plancher (1re base à box.top − size).
  const maxLines = Math.max(1, Math.floor((box.top - size - floor) / lineHeight) + 1);

  // On retire des phrases entières par la fin jusqu'à tenir dans `maxLines`.
  let sentences = splitSentences(text);
  let lines = wrapParagraph(sentences.join(' '), width, font, size);
  while (lines.length > maxLines && sentences.length > 1) {
    sentences = sentences.slice(0, -1);
    lines = wrapParagraph(sentences.join(' '), width, font, size);
  }
  if (lines.length > maxLines) lines = lines.slice(0, maxLines); // garde-fou ultime (une seule phrase trop longue)

  // Masque (cas remplacement) borné à la hauteur RÉELLEMENT utilisée : on couvre au moins l'empreinte
  // d'origine (jusqu'à `box.bottom`) et on étend vers le bas seulement si la réécriture déborde dans
  // l'espace libre — évite de peindre un grand aplat dans l'espace vide sous le paragraphe.
  if (mask) {
    const lastBaseline = (box.top - size) - (lines.length - 1) * lineHeight;
    const usedBottom = lastBaseline - size * 0.28;            // marge sous le jambage de la dernière ligne
    const maskBottom = Math.min(usedBottom, box.bottom);
    page.drawRectangle({ x: box.left - 2, y: maskBottom - 2, width: width + 4, height: (box.top - maskBottom) + 4, color: bg });
  }

  let y = box.top - size;
  for (const ln of lines) {
    page.drawText(ln, { x: box.left, y, size, font, color });
    y -= lineHeight;
  }
}

/**
 * Remplace les références figées (ancien client/sites) repérées dans le PDF par leur valeur
 * personnalisée : pour chaque item de texte qui matche une règle, on masque son empreinte avec
 * l'aplat de fond puis on redessine la nouvelle valeur, calée pour NE PAS déborder de l'empreinte
 * d'origine (police réduite si besoin → jamais de recouvrement du texte voisin). Renvoie le nombre
 * de remplacements effectués.
 */
async function applyRefReplacements(
  pdfBuffer: Buffer, pages: PDFPage[], font: PDFFont, replacements: RefReplacement[], ctx: RefContext,
): Promise<number> {
  interface Hit { pageIndex: number; x: number; y: number; width: number; size: number; repl: RefReplacement; }
  const hits: Hit[] = [];
  await pdfParse(pdfBuffer, {
    pagerender: (pd: any) => pd.getTextContent().then((tc: any) => {
      for (const it of tc.items) {
        const t = (it.str || '');
        if (!t.trim()) continue;
        const repl = replacements.find((r) => r.match.test(t));
        if (!repl) continue;
        hits.push({
          pageIndex: pd.pageNumber - 1, x: it.transform[4], y: it.transform[5],
          width: it.width || 0, size: it.height || FONT_SIZE, repl,
        });
      }
      return '';
    }),
  });

  let done = 0;
  for (const h of hits) {
    const page = pages[h.pageIndex];
    if (!page || h.width <= 0) continue;
    const newStr = h.repl.build(ctx).trim();
    if (!newStr) continue;
    const bg = hexToRgb(h.repl.bgHex || BG_HEX);
    const col = hexToRgb(h.repl.textHex || TEXT_HEX);

    // Réduit la taille jusqu'à tenir dans l'empreinte d'origine (jamais de débordement latéral).
    let size = h.size;
    while (size > 5 && font.widthOfTextAtSize(newStr, size) > h.width) size -= 0.25;

    // Masque l'ancien texte (empreinte d'origine, marge verticale ~30 % / 30 %).
    page.drawRectangle({
      x: h.x - 1, y: h.y - h.size * 0.3, width: h.width + 2, height: h.size * 1.35, color: bg,
    });
    page.drawText(newStr, { x: h.x, y: h.y, size, font, color: col });
    done++;
  }
  return done;
}

/** Lit la police Trebuchet MS du système (Windows) pour coller au design ; null → repli Helvetica. */
export function loadTrebuchetFont(): Buffer | null {
  const candidates = [
    'C:/Windows/Fonts/trebuc.ttf',
    process.env.WINDIR ? `${process.env.WINDIR}/Fonts/trebuc.ttf` : '',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return fs.readFileSync(p); } catch { /* ignore */ }
  }
  return null;
}
