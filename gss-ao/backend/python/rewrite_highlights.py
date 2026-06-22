#!/usr/bin/env python3
"""
Réécriture des zones surlignées d'un PDF (pipeline : PyMuPDF -> GPT -> PyMuPDF).

1. PyMuPDF détecte les surlignages JAUNES (aplats vectoriels) et extrait le texte dessous,
   avec sa géométrie, sa taille de police, sa couleur et la couleur de fond locale.
2. GPT réécrit chaque passage, adapté au client du DCE, en gardant sens/logique, à longueur proche.
3. PyMuPDF SUPPRIME réellement l'ancien texte (rédaction = redaction) + recouvre le jaune, puis
   réinsère le texte réécrit à la MÊME taille, dans la même zone.

Usage:
  py rewrite_highlights.py --input IN.pdf --output OUT.pdf --context ctx.json
Env:
  OPENAI_API_KEY (requis), MEMOIRE_MODEL (def. gpt-4o-mini)

ctx.json: { "clientName": str, "sites": [str], "analysis": {...}, "gssContext": str }
"""
import argparse
import json
import os
import re
import sys
import time

import fitz  # PyMuPDF


# ─── Détection des surlignages ───

# Décalage horizontal (pt) au-delà duquel la 1re ligne d'un passage est considérée comme contournant
# une pastille numérotée (gouttière), et non comme un simple alinéa. ~22 pt ≈ 0,78 cm : au-dessus d'un
# alinéa courant, en dessous du décalage d'une pastille de rétroplanning. À AUGMENTER si des alinéas
# marqués déclenchent à tort le décalage ; à RÉDUIRE si du texte chevauche encore une pastille.
GUTTER_MIN_PT = 22.0


def is_yellow(c):
    """Couleur (tuple 0-1) proche du jaune surligneur."""
    return c is not None and len(c) >= 3 and c[0] > 0.78 and c[1] > 0.70 and c[2] < 0.6


def luminance(c):
    return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]


def int_to_rgb01(v):
    return ((v >> 16 & 255) / 255.0, (v >> 8 & 255) / 255.0, (v & 255) / 255.0)


def line_text(line):
    return re.sub(r"\s+", " ", "".join(sp.get("text", "") for sp in line.get("spans", []))).strip()


def line_hl_words(line_bbox, words, yrects):
    """Au niveau MOT (les spans PyMuPDF regroupent souvent toute la ligne, ce qui masque les
    surlignages partiels). Renvoie (taux de couverture en largeur, liste des MOTS surlignés)."""
    covered = 0.0
    total = 0.0
    hl_words = []
    for w in words:
        wr = fitz.Rect(w[:4])
        cy = (wr.y0 + wr.y1) / 2
        if not (line_bbox.y0 - 1 <= cy <= line_bbox.y1 + 1):
            continue
        ww = wr.width
        if ww <= 0:
            continue
        total += ww
        inter = 0.0
        for yr in yrects:
            ir = wr & yr
            if not ir.is_empty:
                inter = max(inter, ir.width)
        if inter > ww * 0.4:
            hl_words.append(w[4])
            covered += ww
    return (covered / total if total else 0.0), hl_words


def collapse_repeats(text):
    """Replie toute séquence de mots CONTIGUË répétée immédiatement (A B C A B C → A B C). Le PDF figé
    AO RNE.pdf contient du texte dupliqué qui se superpose exactement (zones de texte sales du .docx) ;
    à l'écran les copies coïncident, mais l'extraction renvoie la séquence en double (ex. « est élevé.
    Sur des sites dits élevé. Sur des sites dits «sensibles» »). On ne replie que les répétitions de
    ≥2 mots (les doublons d'un seul mot peuvent être légitimes : « très très »)."""
    words = (text or "").split()
    n = len(words)
    out = []
    i = 0
    while i < n:
        best_k = 0
        for k in range((n - i) // 2, 1, -1):  # plus longue séquence répétée d'abord, k ≥ 2
            if words[i:i + k] == words[i + k:i + 2 * k]:
                best_k = k
                break
        if best_k:
            out.extend(words[i:i + best_k])  # on garde UNE copie
            i += best_k * 2                  # on saute les deux copies
        else:
            out.append(words[i])
            i += 1
    return " ".join(out)


# ─── Détection / esquive des images du template ───

IMG_MARGIN = 3.0      # pt de garde laissés autour d'une image
MIN_USABLE_W = 40.0   # largeur min. d'une zone d'écriture exploitable après rognage
MIN_USABLE_H = 8.0    # hauteur min. (≈ une ligne)


def page_image_rects(page):
    """Rectangles RÉELS des images bitmap d'une page (placement + CTM appliqués), pas la simple
    déclaration. On ignore les images minuscules (icônes, filets) qui ne gênent pas la lecture, ET
    les fonds de page (image englobant la zone ou couvrant > 55 % de la page) : sur ces templates,
    le texte est calé PAR-DESSUS le fond par design, il ne faut donc pas l'esquiver."""
    rects = []
    page_area = abs(page.rect.get_area()) or 1.0
    for img in page.get_images(full=True):
        try:
            for r in page.get_image_rects(img[0]):
                if r.width >= 8 and r.height >= 8 and abs(r.get_area()) <= 0.55 * page_area:
                    rects.append(+r)
        except Exception:  # noqa: BLE001 — une image illisible ne doit jamais bloquer la réécriture
            pass
    return rects


def clip_rect_to_images(rect, img_rects):
    """Réduit `rect` pour qu'il n'empiète plus sur une image, en gardant la PLUS GRANDE zone encore
    exploitable obtenue en coupant d'UN seul côté (au-dessus / sous / à gauche / à droite de l'image).
    Une image qui englobe la zone (fond) est ignorée. Si AUCUNE coupe ne laisse de place exploitable,
    on conserve la zone telle quelle : mieux vaut un léger chevauchement qu'un texte manquant."""
    r = +rect
    for im in img_rects:
        if not r.intersects(im):
            continue
        # Image englobant la zone (fond résiduel) → ne pas rogner.
        if im.x0 <= r.x0 + 2 and im.x1 >= r.x1 - 2 and im.y0 <= r.y0 + 2 and im.y1 >= r.y1 - 2:
            continue
        cands = []
        if im.y0 > r.y0 + 2:  # garder la partie AU-DESSUS de l'image
            cands.append(fitz.Rect(r.x0, r.y0, r.x1, min(r.y1, im.y0 - IMG_MARGIN)))
        if im.y1 < r.y1 - 2:  # repartir SOUS l'image
            cands.append(fitz.Rect(r.x0, max(r.y0, im.y1 + IMG_MARGIN), r.x1, r.y1))
        if im.x0 > r.x0 + 2:  # garder la colonne À GAUCHE de l'image
            cands.append(fitz.Rect(r.x0, r.y0, min(r.x1, im.x0 - IMG_MARGIN), r.y1))
        if im.x1 < r.x1 - 2:  # garder la colonne À DROITE de l'image
            cands.append(fitz.Rect(max(r.x0, im.x1 + IMG_MARGIN), r.y0, r.x1, r.y1))
        usable = [c for c in cands if c.width >= MIN_USABLE_W and c.height >= MIN_USABLE_H]
        if usable:
            r = max(usable, key=lambda c: c.get_area())
    return r


def detect_highlights(doc):
    """Renvoie la liste des zones surlignées. On s'appuie sur la structure blocs/lignes de PyMuPDF
    (ordre de lecture + colonnes). Pour CHAQUE zone on renvoie :
      - `bands`  : les bandes jaunes à RÉDIGER (suppression réelle du texte + recouvrement du jaune),
                   y compris les surlignages PARTIELS de ligne (sinon → résidus de mots surlignés) ;
      - `insert` : le rectangle où ÉCRIRE la réécriture = uniquement les lignes ENTIÈREMENT surlignées
                   contiguës depuis le haut (on n'écrit jamais par-dessus du texte non surligné voisin)."""
    regions = []
    for pno in range(doc.page_count):
        page = doc[pno]
        img_rects = page_image_rects(page)  # images à esquiver (calculé une fois par page)
        yellow, bg_fills = [], []  # bg_fills: (area, rect, color)
        for d in page.get_drawings():
            fill, rect = d.get("fill"), d.get("rect")
            if rect is None:
                continue
            # surlignage = jaune VIF (1,1,0). On exige b<0.35 pour écarter les orangés des infographies.
            if fill and len(fill) >= 3 and fill[0] > 0.8 and fill[1] > 0.8 and fill[2] < 0.35 and rect.width > 12 and 4 < rect.height < 60:
                yellow.append(+rect)
            elif fill is not None:
                bg_fills.append((rect.width * rect.height, +rect, tuple(fill)))
        if not yellow:
            continue

        words = page.get_text("words")
        blocks = [b for b in page.get_text("dict").get("blocks", []) if b.get("type", 0) == 0]
        all_lines = []
        for block in blocks:
            for line in block.get("lines", []):
                if not line_text(line):
                    continue
                lb = fitz.Rect(line["bbox"])
                cov, hl_words = line_hl_words(lb, words, yellow)
                # Une ligne fait partie d'une zone dès qu'elle a AU MOINS un mot sous le jaune (capte
                # les surlignages PARTIELS de ligne, ex. un seul mot) → sinon résidus de mots surlignés.
                all_lines.append({"bbox": lb, "spans": line["spans"],
                                  "cov": cov, "hl_words": hl_words, "hl": len(hl_words) > 0})

        # Zones = lignes surlignées CONSÉCUTIVES (même colonne, faible saut vertical). Une ligne non
        # surlignée intercalée coupe la zone.
        passages, cur = [], None
        for L in all_lines:
            if not L["hl"]:
                cur = None
                continue
            if cur:
                prev = cur[-1]["bbox"]
                same_col = not (L["bbox"].x0 > prev.x1 + 8 or L["bbox"].x1 < prev.x0 - 8)
                if same_col and (L["bbox"].y0 - prev.y1) < L["bbox"].height * 1.4:
                    cur.append(L)
                    continue
            cur = [L]
            passages.append(cur)

        for lines in passages:
            text = re.sub(r"\s+", " ", " ".join(w for L in lines for w in L["hl_words"])).strip()
            text = collapse_repeats(text)  # PDF figé : retire les séquences dupliquées superposées
            if not text:
                continue
            spans = [sp for L in lines for sp in L["spans"] if sp.get("text", "").strip()]
            sizes = sorted(sp["size"] for sp in spans) or [10.5]
            size = sizes[len(sizes) // 2]

            # Bandes à rédiger = toutes les bandes jaunes touchant la zone (couvre aussi le partiel).
            zone = fitz.Rect(lines[0]["bbox"])
            for L in lines[1:]:
                zone |= L["bbox"]
            bands = [[yr.x0, yr.y0, yr.x1, yr.y1] for yr in yellow if yr.intersects(zone + (-2, -3, 2, 3))]
            if not bands:
                bands = [[zone.x0, zone.y0, zone.x1, zone.y1]]

            # Lignes ENTIÈREMENT surlignées, contiguës depuis le haut → zone d'écriture sûre.
            full_run = []
            for L in lines:
                if L["cov"] > 0.75:
                    full_run.append(L)
                else:
                    break
            ins_lines = full_run or [lines[0]]
            origin_x0 = ins_lines[0]["bbox"][0]      # x0 du début réel du texte d'origine
            ins = fitz.Rect(ins_lines[0]["bbox"])
            for L in ins_lines[1:]:
                ins |= L["bbox"]
            # Respecter l'emplacement d'origine : sur les pages de rétroplanning, les 1res lignes sont
            # DÉCALÉES vers la droite pour contourner la pastille numérotée (1, 2, …) posée dans la marge
            # gauche. L'union des bbox ramène x0 à la marge (lignes suivantes pleine largeur) → la
            # réécriture repartait SOUS la pastille. On ne déplace x0 vers la droite QUE si ce décalage
            # est marqué (gouttière de pastille), pas pour un simple alinéa de 1re ligne (géré par
            # FIRST_LINE_INDENT) : sinon on rétrécirait inutilement tous les paragraphes normaux.
            body_x0 = min((L["bbox"][0] for L in ins_lines[1:]), default=origin_x0)
            if origin_x0 - body_x0 > GUTTER_MIN_PT:
                ins.x0 = origin_x0

            # Esquiver les images du template : on rogne la zone d'écriture pour qu'elle s'arrête
            # avant l'image. Le budget GPT (passage_budget → char_budget) lit cet `insert` rogné,
            # donc la réécriture vise directement la place réellement disponible.
            ins = clip_rect_to_images(ins, img_rects)

            colors = {}
            for sp in spans:
                colors[sp.get("color", 0)] = colors.get(sp.get("color", 0), 0) + 1
            text_color = int_to_rgb01(max(colors, key=colors.get)) if colors else (0.1, 0.1, 0.1)

            cx, cy = (zone.x0 + zone.x1) / 2, (zone.y0 + zone.y1) / 2
            covering = [c for c in bg_fills if not is_yellow(c[2]) and c[1].x0 <= cx <= c[1].x1 and c[1].y0 <= cy <= c[1].y1]
            covering.sort(key=lambda c: -c[0])
            bg_color = covering[0][2][:3] if covering else (1.0, 1.0, 1.0)

            # On N'ÉTEND PAS la zone d'écriture vers le bas : elle se limite aux lignes surlignées
            # (sinon deux zones voisines se chevauchent et les réécritures se superposent). Si la
            # réécriture dépasse, `insert_fit` réduit légèrement la police plutôt que de déborder.
            regions.append({
                "page": pno,
                "bands": bands,
                "insert": [ins.x0, ins.y0, ins.x1, ins.y1],
                "size": size,
                "text": text,
                "bg": list(bg_color),
                "color": list(text_color),
            })
    return merge_overlapping_regions(regions)


def _norm_txt(t):
    """Texte normalisé pour comparer (sans casse ni espaces multiples)."""
    return re.sub(r"\s+", " ", t or "").strip().lower()


def merge_overlapping_regions(regions):
    """Fusionne, par page, les zones d'un MÊME paragraphe que PyMuPDF a éclatées. Deux cas :
      1) rectangles d'écriture qui se CHEVAUCHENT (paragraphe enroulé autour d'une image) ;
      2) MÊME texte (ou l'un inclus dans l'autre) éclaté en plusieurs morceaux NON contigus.
         Ce 2e cas vient du PDF figé AO RNE.pdf : il contient du texte DUPLIQUÉ qui se superpose
         exactement (issu des zones de texte sales du .docx d'origine). À l'écran les copies
         coïncident → ça paraît propre, mais la détection capte chaque copie + des fragments
         (« Nos », « Nos agents »…), et chacun était réinséré séparément → garbage (micro-colonnes,
         doublons). On les regroupe : géométrie = UNION (cadre de pleine largeur retrouvé), texte =
         ensemble MAXIMAL (on retire toute chaîne incluse dans une autre → plus de doublon), bandes =
         toutes (on rédige donc TOUTES les copies). Les paragraphes réellement distincts qui ne font
         que s'enrouler restent concaténés dans l'ordre de lecture."""
    by_page = {}
    for r in regions:
        by_page.setdefault(r["page"], []).append(r)
    out = []
    for pno, regs in by_page.items():
        norms = [_norm_txt(r["text"]) for r in regs]
        used = [False] * len(regs)
        for i in range(len(regs)):
            if used[i]:
                continue
            grp = [regs[i]]
            grp_norms = [norms[i]]
            used[i] = True
            box = fitz.Rect(regs[i]["insert"])
            changed = True
            while changed:
                changed = False
                for j in range(len(regs)):
                    if used[j]:
                        continue
                    overlap = fitz.Rect(regs[j]["insert"]).intersects(box)
                    # même texte / fragment : l'un inclus dans l'autre (≥4 car. pour éviter les faux positifs)
                    nj = norms[j]
                    same = nj and any(nj == u or (len(nj) >= 4 and (nj in u or u in nj)) for u in grp_norms)
                    if overlap or same:
                        grp.append(regs[j])
                        grp_norms.append(nj)
                        used[j] = True
                        box |= fitz.Rect(regs[j]["insert"])
                        changed = True
            if len(grp) == 1:
                out.append(grp[0])
                continue
            rep = max(grp, key=lambda r: (r["insert"][2] - r["insert"][0]) * (r["insert"][3] - r["insert"][1]))
            # Texte = chaînes MAXIMALES (toute chaîne incluse dans une autre est retirée → dédoublonnage),
            # ordonnées par position de lecture (y puis x) pour les paragraphes réellement distincts.
            cand = [r for r in grp if r["text"].strip()]
            maximal = []
            for r in sorted(cand, key=lambda r: len(r["text"]), reverse=True):
                nt = _norm_txt(r["text"])
                if not any(nt in _norm_txt(m["text"]) for m in maximal):
                    maximal.append(r)
            maximal.sort(key=lambda r: (round(r["insert"][1]), round(r["insert"][0])))
            out.append({
                "page": pno,
                "bands": [b for r in grp for b in r["bands"]],
                "insert": [box.x0, box.y0, box.x1, box.y1],
                "size": rep["size"],
                "text": collapse_repeats(" ".join(r["text"].strip() for r in maximal)),
                "bg": rep["bg"],
                "color": rep["color"],
            })
    return out


# ─── Placeholders (<entreprise> → nom du donneur d'ordre du DCE) ───

# Jeton placeholder surligné en jaune dans le template (ex. « <entreprise> », « < entrepris > »).
# On accepte la troncature « entrepris » + variantes d'espaces/casse.
PLACEHOLDER_RE = re.compile(r"<\s*entrepris\w*\s*>", re.IGNORECASE)


def fill_placeholders(text, ctx):
    """Remplace les jetons <entreprise> par le nom EXACT du donneur d'ordre extrait du DCE
    (ctx.clientName). Renvoie (texte substitué, True si au moins un jeton a été remplacé)."""
    name = (ctx.get("clientName") or "").strip() or "le client"
    new_text, n = PLACEHOLDER_RE.subn(name, text)
    return new_text, n > 0


# ─── Réécriture GPT ───

def char_budget(r):
    """Nombre de caractères tenant dans le rectangle d'écriture, à la taille d'origine."""
    size = r["size"] if r["size"] > 4 else 10.5
    x0, y0, x1, y1 = r["insert"]
    width = max(1.0, x1 - x0)
    usable = max(0.0, y1 - y0)
    lines = int(usable / (size * 1.2)) + 1
    chars_per_line = max(1, int(width / (size * 0.5)))
    return lines * chars_per_line


MD_RE = re.compile(r"(^[\s>]*[-*#]\s)|[`*#]", re.MULTILINE)


# Marge de première ligne (alinéa) et facteur de remplissage : on vise un peu MOINS que la capacité
# brute du cadre pour que la réécriture tienne à la TAILLE D'ORIGINE (sinon insert_fit réduit la police).
FIRST_LINE_INDENT = "       "  # alinéa prononcé (espaces normaux : largeur fiable quelle que soit la fonte)
FILL_FACTOR = 0.88


def passage_budget(r):
    """Budget de caractères d'un passage : ce qui tient dans la zone (avec marge de sécurité pour rester à
    la taille d'origine), borné à ~1.1× l'original. On NE cherche PAS à étoffer ici : la page est designée
    (texte calé autour des images) → on garde la longueur, la position et la taille d'origine."""
    cap = int(char_budget(r) * FILL_FACTOR)
    return max(1, min(cap, int(len(r["text"]) * 1.1) or cap))


def is_valid_rewrite(text, original, budget):
    """Une réécriture est valable si : non vide, sans markdown, ni trop longue (≤ 1.15× budget),
    ni tronquée (≥ 30 % de la longueur d'origine)."""
    t = (text or "").strip()
    if not t:
        return False
    if MD_RE.search(t):
        return False
    if len(t) > budget * 1.15:
        return False
    if len(t) < max(1, len(original.strip()) * 0.3):
        return False
    return True


def _build_messages(passages, budgets, texts, ctx):
    client_name = ctx.get("clientName") or "le client"
    sites = ", ".join([s for s in (ctx.get("sites") or []) if s])
    passages_str = "\n\n".join(
        f"[{i+1}] (≈ {budgets[i]} caractères) PASSAGE À RÉÉCRIRE : {texts[i]}"
        for i in range(len(passages))
    )
    system = (
        "Tu es un rédacteur expert chez GSS (sécurité privée). On te donne des passages d'un mémoire "
        "technique GSS. Pour CHAQUE passage, tu RÉÉCRIS INTÉGRALEMENT le passage (remplacement complet, "
        "le texte d'origine sera retiré), en gardant la VOIX de GSS (\"nous\", \"nos agents\").\n"
        "RÈGLES STRICTES :\n"
        "- Même sujet, même sens, même logique et même structure que l'original, mais ADAPTÉ au client "
        f"\"{client_name}\"" + (f" et à ses sites ({sites})" if sites else "") + ". Comprends le secteur "
        "d'activité, le fonctionnement et les enjeux du client (issus de l'ANALYSE DU DCE) et relie-y le "
        "contenu du passage (enjeux, risques, contraintes, sites précis), en montrant comment GSS y répond.\n"
        "- STRATÉGIQUE : ne reformule pas platement. Montre que GSS a compris l'enjeu PRÉCIS du client, "
        "propose un VRAI AVANTAGE différenciant (un moyen, une méthode ou un engagement concret) et son "
        "bénéfice. Bannis les généralités interchangeables : chaque phrase doit rattacher GSS au contexte de ce client.\n"
        "- VALEUR AJOUTÉE : termine l'idée sur ce que GSS apporte concrètement à CE client par rapport à un "
        "prestataire lambda (gain de sécurité, de conformité, de réactivité, de tranquillité). Le lecteur doit "
        "comprendre pourquoi choisir GSS.\n"
        "- COHÉRENCE DE PAGE : reste dans le sujet exact du passage et de son titre de section ; ne change pas "
        "de thème, n'introduis pas d'élément absent de la page (chiffres, sites ou prestations non mentionnés).\n"
        "- LONGUEUR : reste TRÈS PROCHE du nombre de caractères de l'original (≈ budget indiqué), sans jamais "
        "le dépasser — la page est mise en forme autour d'images, le texte doit garder exactement sa place et sa taille.\n"
        "- Concret et professionnel ; aucune puce, aucun markdown, aucun titre : du texte continu, phrases complètes.\n"
        "- Renvoie un JSON STRICT : {\"rewrites\": [\"...\", ...]} dans le MÊME ordre et le MÊME nombre que les "
        "passages. Chaque réécriture NON VIDE."
    )
    analysis = json.dumps(ctx.get("analysis", {}), ensure_ascii=False)[:6000]
    user = (
        f"ANALYSE DU DCE (client, secteur, sites, enjeux, risques, contraintes) :\n{analysis}\n\n"
        f"CONTEXTE GSS (extraits doc) :\n{(ctx.get('gssContext') or '')[:5000]}\n\n"
        f"PASSAGES (réécris chacun intégralement, adapté au client) :\n{passages_str}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def rewrite_batch(client, model, passages, budgets, texts, ctx):
    """Réécrit un sous-ensemble de passages (typiquement ceux d'une page) en UN appel GPT. Retry avec
    backoff sur 429 (TPM), calqué sur le backend Node. Renvoie la liste des réécritures (ordre conservé)."""
    if not passages:
        return []
    messages = _build_messages(passages, budgets, texts, ctx)
    backoffs = [8, 16]  # courts : on préfère retomber sur le texte d'origine que faire exploser le timeout
    for attempt in range(len(backoffs) + 1):
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.4,
                response_format={"type": "json_object"},
            )
            raw = resp.choices[0].message.content or "{}"
            try:
                return json.loads(raw).get("rewrites", [])
            except Exception:
                return []
        except Exception as e:  # noqa: BLE001 — on ne distingue que le 429
            is_429 = getattr(e, "status_code", None) == 429 or "429" in str(e)
            if is_429 and attempt < len(backoffs):
                wait = backoffs[attempt]
                print(f"[rewrite_highlights] 429 (TPM) — attente {wait}s…", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"[rewrite_highlights] appel GPT échoué : {e}", file=sys.stderr)
            return []


def rewrite_passages(regions, ctx):
    """Réécrit les passages PAGE PAR PAGE (1 appel GPT par page → cohérence locale + appariement fiable).
    Chaque réécriture est vérifiée (is_valid_rewrite) ; en cas d'échec on ré-essaie CE passage seul (×2),
    puis on retombe sur le texte d'origine. Renvoie une liste alignée 1:1 avec `regions`."""
    if not regions:
        return []
    out = [None] * len(regions)

    # Placeholders <entreprise> : remplacement DIRECT par le nom du donneur d'ordre du DCE (pas de GPT).
    # On le fait AVANT toute logique GPT pour que ces zones soient traitées même sans clé OpenAI.
    placeholder_idx = set()
    for i, r in enumerate(regions):
        new_text, hit = fill_placeholders(r["text"], ctx)
        if hit:
            out[i] = new_text.strip()
            placeholder_idx.add(i)
    if placeholder_idx:
        print(f"[rewrite_highlights] {len(placeholder_idx)} placeholder(s) <entreprise> remplacé(s) par \"{(ctx.get('clientName') or 'le client').strip()}\".", file=sys.stderr)

    # IMPORTANT : un échec GPT (clé absente/invalide, réseau…) ne doit JAMAIS empêcher la suppression du
    # surlignage. On retombe alors sur le texte d'origine, qui sera quand même réinséré → le jaune part.
    api_key = os.environ.get("OPENAI_API_KEY") or ""
    if not api_key.strip():
        print("[rewrite_highlights] OPENAI_API_KEY absente → texte d'origine conservé, surlignage retiré.", file=sys.stderr)
        return [out[i] if out[i] is not None else r["text"].strip() for i, r in enumerate(regions)]
    try:
        from openai import OpenAI
        # max_retries=0 + timeout court : en cas de panne réseau l'échec est IMMÉDIAT (pas de hang qui
        # ferait dépasser le timeout de 300s du backend → fallback avec surlignage).
        client = OpenAI(api_key=api_key, max_retries=0, timeout=30)
    except Exception as e:  # noqa: BLE001
        print(f"[rewrite_highlights] OpenAI indisponible ({e}) → texte d'origine conservé, surlignage retiré.", file=sys.stderr)
        return [out[i] if out[i] is not None else r["text"].strip() for i, r in enumerate(regions)]
    model = os.environ.get("MEMOIRE_MODEL", "gpt-4o-mini")

    # Budget de temps global : le page-par-page fait beaucoup d'appels séquentiels ; avec un compte à TPM
    # faible (429 + backoff) on risquait de dépasser le timeout de 300s du backend → process tué → AUCUNE
    # sortie → fallback avec TOUT le surlignage. On borne donc le temps passé en GPT : au-delà, les passages
    # restants gardent le texte d'origine et on enchaîne sur la rédaction (le jaune part toujours).
    time_budget = float(os.environ.get("REWRITE_TIME_BUDGET", "200"))
    start = time.monotonic()

    budgets = [passage_budget(r) for r in regions]
    failures = 0

    # Groupement par page en conservant l'index global d'origine. Les placeholders déjà résolus
    # (out[i] renseigné) sont exclus : pas de réécriture GPT pour eux.
    by_page = {}
    for i, r in enumerate(regions):
        if i in placeholder_idx:
            continue
        by_page.setdefault(r["page"], []).append(i)

    for pno, idxs in by_page.items():
        if time.monotonic() - start > time_budget:
            for gi in idxs:
                out[gi] = regions[gi]["text"].strip()  # plus de temps : texte d'origine, jaune retiré
            continue
        rewrites = rewrite_batch(
            client, model, idxs, [budgets[i] for i in idxs], [regions[i]["text"] for i in idxs], ctx,
        )
        if len(rewrites) != len(idxs):
            print(f"[rewrite_highlights] page {pno}: {len(rewrites)} réécriture(s) pour {len(idxs)} passage(s) (appariement partiel).", file=sys.stderr)
        for k, gi in enumerate(idxs):
            txt = (rewrites[k] if k < len(rewrites) else "") or ""
            txt = txt.strip()
            # Check + ré-essai ciblé du seul passage fautif (×2), puis fallback texte d'origine.
            for _ in range(2):
                if is_valid_rewrite(txt, regions[gi]["text"], budgets[gi]) or time.monotonic() - start > time_budget:
                    break
                retry = rewrite_batch(client, model, [gi], [budgets[gi]], [regions[gi]["text"]], ctx)
                txt = ((retry[0] if retry else "") or "").strip()
            if not is_valid_rewrite(txt, regions[gi]["text"], budgets[gi]):
                txt = regions[gi]["text"].strip()  # repli
                failures += 1
            out[gi] = txt

    if failures:
        print(f"[rewrite_highlights] {failures} passage(s) non réécrit(s) → texte d'origine conservé.", file=sys.stderr)
    return out


# ─── Remplacement dans le PDF ───

SENT_RE = re.compile(r"[^.!?…]+[.!?…]+")


def shrink_to_sentences(text, max_chars):
    if len(text) <= max_chars:
        return text
    kept = ""
    for s in SENT_RE.findall(text):
        if len(kept) + len(s) <= max_chars:
            kept += s
        else:
            break
    return kept.strip() or text


def insert_fit(page, rect, text, base_size, kw, indent=""):
    """Insère `text` dans `rect` SANS jamais déborder ni laisser vide. insert_textbox n'écrit RIEN et
    renvoie <0 si le texte ne tient pas → on peut réessayer sans risque de double rendu. Stratégie :
    on garde d'abord la taille d'origine, puis on la réduit par petits paliers ; en dernier recours on
    retire des phrases puis des mots. `indent` est un alinéa ajouté en tête (préservé à chaque essai).
    Renvoie True si quelque chose a été écrit."""
    if not text.strip():
        return False
    sizes = [base_size, base_size * 0.94, base_size * 0.88, base_size * 0.82, base_size * 0.76, base_size * 0.7]
    for s in sizes:
        if page.insert_textbox(rect, indent + text, fontsize=s, **kw) >= 0:
            return True
    smallest = sizes[-1]
    sents = SENT_RE.findall(text) or [text]
    while len(sents) > 1:
        sents = sents[:-1]
        if page.insert_textbox(rect, indent + "".join(sents).strip(), fontsize=smallest, **kw) >= 0:
            return True
    words = text.split()
    while words:
        if page.insert_textbox(rect, indent + " ".join(words), fontsize=smallest, **kw) >= 0:
            return True
        words = words[:-1]
    return False


def apply_rewrites(doc, regions, rewrites, fontfile):
    use_trebuc = bool(fontfile and os.path.exists(fontfile))
    # 1) Rédaction page par page : suppression RÉELLE de l'ancien texte (toutes les bandes jaunes, y
    #    compris les surlignages partiels de ligne) ET recouvrement du jaune (fill = couleur de fond).
    by_page = {}
    for idx, r in enumerate(regions):
        by_page.setdefault(r["page"], []).append(idx)
    for pno, idxs in by_page.items():
        page = doc[pno]
        for i in idxs:
            r = regions[i]
            for band in r["bands"]:
                # Marge VERTICALE seulement (couvrir toute la hauteur de glyphe) ; pas d'élargissement
                # horizontal pour ne pas rogner le mot voisin conservé (ex. « Il » après un surlignage partiel).
                page.add_redact_annot(fitz.Rect(band) + (0, -1.5, 0, 1.5), fill=tuple(r["bg"]))
        # On NE supprime PAS les graphiques (le fond de page est vectoriel) ; le `fill` recouvre le jaune.
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

    # 2) Insertion du texte réécrit dans la zone d'écriture (lignes entièrement surlignées), à la taille
    #    d'origine si possible, sans jamais laisser vide ni écraser le texte voisin conservé.
    filled = 0
    img_cache = {}  # rects d'images par page (calcul unique)
    for i, r in enumerate(regions):
        page = doc[r["page"]]
        size = r["size"] if r["size"] > 4 else 10.5
        text = (rewrites[i] or "").strip()
        if not text:
            continue
        rect = fitz.Rect(r["insert"])
        # Le rectangle d'écriture vient du bbox SERRÉ des lignes surlignées (hauteur de glyphes),
        # soit ~0,4 interligne de moins que l'interligne dont insert_textbox a besoin. Résultat : même
        # le texte à longueur d'origine ne tient pas à sa taille → insert_fit RÉDUISAIT la police, et
        # chaque passage finissait à une taille différente (mise en forme incohérente). On rend ce
        # ~0,4 interligne sous la zone (la bande surlignée est suivie d'un blanc d'interligne) pour que
        # la réécriture tienne à la TAILLE D'ORIGINE et reste homogène avec le reste de la page.
        rect.y1 += size * 0.45
        # L'extension verticale ci-dessus peut re-rentrer dans une image juste sous la zone : on
        # re-rogne face aux images pour garantir qu'aucune lettre ne se rende par-dessus une image.
        if r["page"] not in img_cache:
            img_cache[r["page"]] = page_image_rects(page)
        rect = clip_rect_to_images(rect, img_cache[r["page"]])
        # Le corps du mémoire est JUSTIFIÉ (les marges droites des paragraphes sont alignées). On
        # reproduit cette justification sur les passages multi-lignes pour que la réécriture se fonde
        # dans la page ; on conserve l'alignement à gauche pour les libellés d'UNE seule ligne, où la
        # justification étirerait disgracieusement les espaces d'une ligne unique.
        n_lines = max(1, int((rect.y1 - rect.y0) / (size * 1.2)))
        align = fitz.TEXT_ALIGN_JUSTIFY if n_lines > 1 else fitz.TEXT_ALIGN_LEFT
        kw = dict(color=tuple(r["color"]), align=align)
        kw["fontname"] = "trebuc" if use_trebuc else "helv"
        if use_trebuc:
            kw["fontfile"] = fontfile
        if insert_fit(page, rect, text, size, kw, indent=FIRST_LINE_INDENT):
            filled += 1
    return filled


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--context", required=True)
    args = ap.parse_args()

    with open(args.context, "r", encoding="utf-8") as f:
        ctx = json.load(f)

    doc = fitz.open(args.input)
    regions = detect_highlights(doc)
    print(f"[rewrite_highlights] {len(regions)} zone(s) surlignée(s) détectée(s).", file=sys.stderr)
    if not regions:
        doc.save(args.output)
        print(json.dumps({"regions": 0, "filled": 0}))
        return

    try:
        rewrites = rewrite_passages(regions, ctx)
    except Exception as e:  # noqa: BLE001 — la réécriture ne doit jamais bloquer le retrait du surlignage
        print(f"[rewrite_highlights] réécriture échouée ({e}) → texte d'origine conservé, surlignage retiré.", file=sys.stderr)
        rewrites = [r["text"].strip() for r in regions]
    trebuc = os.environ.get("TREBUCHET_FONT") or r"C:\Windows\Fonts\trebuc.ttf"
    filled = apply_rewrites(doc, regions, rewrites, trebuc)
    doc.save(args.output, garbage=3, deflate=True)
    print(json.dumps({"regions": len(regions), "filled": filled}))


if __name__ == "__main__":
    main()
