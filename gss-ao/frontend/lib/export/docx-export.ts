/**
 * Générateur DOCX natif (librairie `docx`) — rendu fidèle au template imposé
 * de l'écran 6. Construction native Word (titres, paragraphes, tables, bordures),
 * police Helvetica. 100 % client : renvoie un Blob téléchargeable.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IBorderOptions,
} from "docx";
import {
  DOC_DATA,
  DOC_HEADER,
  EXPORT_FONT,
  SIGNATURE,
  checkMark,
} from "@/lib/export/document-model";

/* ----------------------------- palette ----------------------------------- */
const C = {
  slate900: "0F172A",
  slate700: "334155",
  slate500: "64748B",
  slate200: "E2E8F0",
  slate50: "F8FAFC",
  indigo700: "4338CA",
  amber800: "92400E",
  amber200: "FDE68A",
  amber50: "FFFBEB",
};

type Align = (typeof AlignmentType)[keyof typeof AlignmentType];

const CELL_MARGIN = {
  top: 80,
  bottom: 80,
  left: 140,
  right: 140,
};

function box(color: string): {
  top: IBorderOptions;
  bottom: IBorderOptions;
  left: IBorderOptions;
  right: IBorderOptions;
} {
  const b: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color };
  return { top: b, bottom: b, left: b, right: b };
}

/* ----------------------------- briques ------------------------------------ */
function body(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 140, line: 276 },
    children: [new TextRun({ text, font: EXPORT_FONT, size: 20, color: C.slate700 })],
  });
}

function subQuestion(num: number | string | null, text: string): Paragraph {
  const runs: TextRun[] = [];
  if (num != null)
    runs.push(new TextRun({ text: `${num}. `, font: EXPORT_FONT, size: 20, bold: true, color: C.slate500 }));
  runs.push(new TextRun({ text, font: EXPORT_FONT, size: 20, bold: true, color: C.slate700 }));
  return new Paragraph({ spacing: { before: 80, after: 60 }, children: runs });
}

function sectionTitle(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.slate200, space: 4 } },
    children: [new TextRun({ text, font: EXPORT_FONT, size: 26, bold: true, color: C.slate900 })],
  });
}

function checkboxLine(options: { label: string; checked: boolean }[]): Paragraph {
  const runs: TextRun[] = [];
  options.forEach((o, i) => {
    runs.push(
      new TextRun({
        text: `${checkMark(o.checked)} ${o.label}`,
        font: EXPORT_FONT,
        size: 20,
        color: o.checked ? C.indigo700 : C.slate700,
        bold: o.checked,
      }),
    );
    if (i < options.length - 1)
      runs.push(new TextRun({ text: "      ", font: EXPORT_FONT, size: 20 }));
  });
  return new Paragraph({ spacing: { after: 120 }, children: runs });
}

/** Encadré (table 1 cellule) avec bordure fine et fond optionnel. */
function boxed(children: Paragraph[], opts?: { border?: string; fill?: string }): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: box(opts?.border ?? C.slate200),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            margins: CELL_MARGIN,
            shading: opts?.fill
              ? { type: ShadingType.CLEAR, color: "auto", fill: opts.fill }
              : undefined,
            children,
          }),
        ],
      }),
    ],
  });
}

function kvLine(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: `${label} : `, font: EXPORT_FONT, size: 20, color: C.slate500 }),
      new TextRun({ text: value, font: EXPORT_FONT, size: 20, bold: true, color: C.slate900 }),
    ],
  });
}

function contactBox(c: { nom: string; fonction: string; tel: string; email: string }): Table {
  return boxed(
    [
      kvLine("Nom", c.nom),
      kvLine("Fonction", c.fonction),
      kvLine("Téléphone", c.tel),
      kvLine("Email", c.email),
    ],
    { fill: C.slate50 },
  );
}

function spacer(h = 120): Paragraph {
  return new Paragraph({ spacing: { after: h }, children: [] });
}

function delaisTable(rows: { site: string; delai_minutes: number }[]): Table {
  const headerCell = (text: string, align: Align) =>
    new TableCell({
      margins: CELL_MARGIN,
      shading: { type: ShadingType.CLEAR, color: "auto", fill: C.slate50 },
      children: [
        new Paragraph({
          alignment: align,
          children: [new TextRun({ text, font: EXPORT_FONT, size: 18, bold: true, color: C.slate700 })],
        }),
      ],
    });
  const cell = (text: string, align: Align, bold = false) =>
    new TableCell({
      margins: CELL_MARGIN,
      children: [
        new Paragraph({
          alignment: align,
          children: [new TextRun({ text, font: EXPORT_FONT, size: 20, bold, color: C.slate700 })],
        }),
      ],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: box(C.slate200),
    columnWidths: [7000, 2500],
    rows: [
      new TableRow({
        tableHeader: true,
        children: [headerCell("Site", AlignmentType.LEFT), headerCell("Délai max. d'intervention", AlignmentType.RIGHT)],
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            children: [cell(r.site, AlignmentType.LEFT), cell(`${r.delai_minutes} min`, AlignmentType.RIGHT, true)],
          }),
      ),
    ],
  });
}

/* ----------------------------- document ----------------------------------- */
export async function generateDocxBlob(): Promise<Blob> {
  const { identite, sectionI, sectionII, sectionIII, sectionIV, delais, nbIntervenants } = DOC_DATA;

  const children: (Paragraph | Table)[] = [];

  // --- En-tête ---
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [new TextRun({ text: DOC_HEADER.surtitre, font: EXPORT_FONT, size: 16, color: C.slate500, allCaps: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({ text: DOC_HEADER.titre, font: EXPORT_FONT, size: 30, bold: true, color: C.slate900 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: `${DOC_HEADER.acheteur} · ${DOC_HEADER.reference} · Remise le ${DOC_HEADER.remiseLe}`,
          font: EXPORT_FONT,
          size: 18,
          color: C.slate500,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.slate200, space: 8 } },
      children: [new TextRun({ text: `Candidat : ${DOC_HEADER.candidat}`, font: EXPORT_FONT, size: 20, bold: true, color: C.slate700 })],
    }),
    spacer(80),
  );

  // --- Identité candidat ---
  children.push(
    boxed([
      kvLine("Dénomination du candidat", identite.denomination),
      kvLine("N° CNAPS d'autorisation d'exercer", identite.num_cnaps),
      kvLine("Date d'obtention de l'autorisation", identite.date_autorisation),
    ]),
    spacer(160),
  );

  // --- Section I ---
  children.push(sectionTitle(`${sectionI.num}. ${sectionI.titre} (${sectionI.points} pts)`));
  sectionI.sousQuestions.forEach((q) => {
    children.push(subQuestion(q.n, q.label), body(q.reponse));
  });
  children.push(subQuestion(3, sectionI.soustraitance.label), checkboxLine(sectionI.soustraitance.options));
  children.push(subQuestion(4, sectionI.dispositifAbsence.label), body(sectionI.dispositifAbsence.reponse));
  children.push(subQuestion(5, sectionI.interlocuteurPrincipal.label), contactBox(sectionI.interlocuteurPrincipal.contact), spacer(80));
  children.push(subQuestion(6, sectionI.interlocuteurDevis.label), contactBox(sectionI.interlocuteurDevis.contact), spacer(120));

  // --- Section II ---
  children.push(sectionTitle(`${sectionII.num}. ${sectionII.titre} (${sectionII.points} pts)`), body(sectionII.reponse), spacer(120));

  // --- Section III ---
  children.push(sectionTitle(`${sectionIII.num}. ${sectionIII.titre}`));
  sectionIII.blocs.forEach((b) => {
    children.push(
      boxed([
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({ text: `${b.titre} `, font: EXPORT_FONT, size: 20, bold: true, color: C.slate900 }),
            new TextRun({ text: `(${b.points} pts)`, font: EXPORT_FONT, size: 18, color: C.slate500 }),
          ],
        }),
        body(b.reponse),
      ]),
      spacer(100),
    );
  });

  // --- Section IV ---
  children.push(sectionTitle(`${sectionIV.num}. ${sectionIV.titre} (${sectionIV.points} pts — lot 3 uniquement)`));
  children.push(
    boxed(
      [
        new Paragraph({
          children: [new TextRun({ text: sectionIV.lotNote, font: EXPORT_FONT, size: 20, color: C.amber800 })],
        }),
      ],
      { border: C.amber200, fill: C.amber50 },
    ),
    spacer(120),
  );
  children.push(subQuestion(1, sectionIV.apsad.label), checkboxLine(sectionIV.apsad.options));
  children.push(subQuestion(2, sectionIV.localisation.label), body(sectionIV.localisation.reponse));
  children.push(subQuestion(3, sectionIV.soustraitanceLeverDoute.label));
  sectionIV.soustraitanceLeverDoute.departements.forEach((d) => {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        bullet: { level: 0 },
        children: [
          new TextRun({ text: `Département ${d.dep} : `, font: EXPORT_FONT, size: 20, bold: true, color: C.slate700 }),
          new TextRun({ text: d.valeur, font: EXPORT_FONT, size: 20, color: C.slate700 }),
        ],
      }),
    );
  });
  children.push(spacer(60));
  children.push(subQuestion(4, sectionIV.reportAlarmes.label), body(sectionIV.reportAlarmes.reponse));
  children.push(subQuestion(5, sectionIV.moyensOuverture.label), body(sectionIV.moyensOuverture.reponse));
  children.push(subQuestion(6, sectionIV.delaisLabel), delaisTable(delais), spacer(120));
  children.push(
    subQuestion(7, sectionIV.intervenantsLabel),
    boxed(
      [
        new Paragraph({
          children: [
            new TextRun({ text: `${nbIntervenants} `, font: EXPORT_FONT, size: 40, bold: true, color: C.indigo700 }),
            new TextRun({ text: "intervenants véhiculés", font: EXPORT_FONT, size: 20, color: C.slate500 }),
          ],
        }),
      ],
      { fill: C.slate50 },
    ),
    spacer(240),
  );

  // --- Signature ---
  const sigLine = (text: string, opts?: { bold?: boolean; italic?: boolean; color?: string }) =>
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 20 },
      children: [
        new TextRun({
          text,
          font: EXPORT_FONT,
          size: 20,
          bold: opts?.bold,
          italics: opts?.italic,
          color: opts?.color ?? C.slate700,
        }),
      ],
    });
  children.push(
    new Paragraph({
      spacing: { before: 240, after: 80 },
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.slate200, space: 8 } },
      children: [],
    }),
    sigLine(`Fait à ${SIGNATURE.lieu}, le ${SIGNATURE.date}`),
    sigLine(SIGNATURE.entreprise, { bold: true, color: C.slate900 }),
    sigLine(SIGNATURE.signataire),
    sigLine(SIGNATURE.mention, { italic: true, color: C.slate500 }),
  );

  const doc = new Document({
    creator: "GSS-AO",
    title: "Mémoire technique — Univ Rouen MP2026-08",
    styles: {
      default: {
        document: { run: { font: EXPORT_FONT, size: 20, color: C.slate700 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4 portrait (twips)
            margin: { top: 1417, right: 1417, bottom: 1417, left: 1417 }, // ~2.5 cm
          },
        },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}
