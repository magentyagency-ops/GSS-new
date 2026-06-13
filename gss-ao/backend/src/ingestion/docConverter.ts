import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import pdf from 'pdf-parse';
import { getSettings } from '../core/config';
import { ExtractionMethod } from '../schemas/common';

export class DocConverterError extends Error {}
export class LibreOfficeNotFoundError extends DocConverterError {}

// macOS common LibreOffice paths
const MACOS_SOFFICE_CANDIDATES = [
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
];

export function findSoffice(): string | null {
  const settings = getSettings();
  if (settings.sofficeBin && fs.existsSync(settings.sofficeBin)) {
    return settings.sofficeBin;
  }

  // Check PATH
  try {
    const checkCmd = process.platform === 'win32' ? 'where soffice' : 'which soffice';
    const out = execSync(checkCmd, { stdio: [] }).toString().trim();
    if (out) return out.split('\n')[0].trim();
  } catch (e) {}

  try {
    const checkCmd = process.platform === 'win32' ? 'where libreoffice' : 'which libreoffice';
    const out = execSync(checkCmd, { stdio: [] }).toString().trim();
    if (out) return out.split('\n')[0].trim();
  } catch (e) {}

  // Candidates for macOS
  if (process.platform === 'darwin') {
    for (const cand of MACOS_SOFFICE_CANDIDATES) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
  }

  return null;
}

export function sofficeAvailable(): boolean {
  return findSoffice() !== null;
}

export function findTextutil(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execSync('which textutil', { stdio: [] }).toString().trim();
    if (out) return out;
  } catch (e) {}
  if (fs.existsSync('/usr/bin/textutil')) return '/usr/bin/textutil';
  return null;
}

export function convertDocToTextTextutil(src: string): string {
  if (!fs.existsSync(src)) {
    throw new DocConverterError(`Fichier introuvable : ${src}`);
  }
  const textutil = findTextutil();
  if (!textutil) {
    throw new DocConverterError('textutil introuvable (disponible uniquement sur macOS).');
  }
  try {
    const proc = spawnSync(textutil, ['-convert', 'txt', '-stdout', src], { timeout: 120000 });
    if (proc.status !== 0) {
      throw new DocConverterError(`Échec textutil (${path.basename(src)}) : ${proc.stderr?.toString()}`);
    }
    return proc.stdout.toString();
  } catch (e: any) {
    throw new DocConverterError(`Échec conversion textutil : ${e.message}`);
  }
}

export function convertDocToDocx(src: string, outDir?: string): string {
  if (!fs.existsSync(src)) {
    throw new DocConverterError(`Fichier introuvable : ${src}`);
  }
  const soffice = findSoffice();
  if (!soffice) {
    throw new LibreOfficeNotFoundError(
      "LibreOffice (soffice) est requis pour convertir les .doc legacy mais " +
      "n'a pas été trouvé. Installez-le puis réessayez, ou renseignez " +
      "SOFFICE_BIN dans .env."
    );
  }

  const outputDirectory = outDir || fs.mkdtempSync(path.join(path.dirname(src), 'gss_doc_'));
  const tempProfileDir = fs.mkdtempSync(path.join(path.dirname(src), 'gss_lo_profile_'));

  const args = [
    '--headless',
    '--norestore',
    `-env:UserInstallation=file:///${tempProfileDir.replace(/\\/g, '/')}`,
    '--convert-to',
    'docx',
    '--outdir',
    outputDirectory,
    src,
  ];

  try {
    const proc = spawnSync(soffice, args, { timeout: 120000 });
    if (proc.status !== 0) {
      throw new DocConverterError(
        `Échec conversion LibreOffice (${path.basename(src)}). code=${proc.status} stderr=${proc.stderr?.toString()}`
      );
    }
  } finally {
    try {
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    } catch (e) {}
  }

  const stem = path.basename(src, path.extname(src));
  const produced = path.join(outputDirectory, `${stem}.docx`);
  if (!fs.existsSync(produced)) {
    throw new DocConverterError(`Fichier converti non trouvé : ${produced}`);
  }
  return produced;
}

export interface DocxParagraph {
  text: string;
  styleName: string | null;
}

export interface DocxTable {
  rows: string[][];
}

export interface DocxStructure {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  allElements: Array<{ type: 'paragraph'; text: string; styleName: string | null } | { type: 'table'; rows: string[][] }>;
}

export function loadDocxStructure(filePath: string): DocxStructure {
  if (!fs.existsSync(filePath)) {
    throw new DocConverterError(`Fichier non trouvé : ${filePath}`);
  }

  const zip = new AdmZip(filePath);
  const docXmlEntry = zip.getEntry('word/document.xml');
  if (!docXmlEntry) {
    throw new DocConverterError(`word/document.xml non trouvé dans le docx : ${filePath}`);
  }

  const xmlText = docXmlEntry.getData().toString('utf8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
  });

  const jsonObj = parser.parse(xmlText);
  const body = jsonObj['w:document']?.['w:body'];
  if (!body) {
    throw new DocConverterError(`Structure XML du document non reconnue dans ${filePath}`);
  }

  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];
  const allElements: DocxStructure['allElements'] = [];

  // Helper to extract text from a paragraph node w:p
  const extractTextFromParagraphNode = (pNode: any): string => {
    if (!pNode) return '';
    let text = '';
    // w:r can be an object or an array of objects
    const runs = Array.isArray(pNode['w:r']) ? pNode['w:r'] : [pNode['w:r']];
    for (const r of runs) {
      if (!r) continue;
      // w:t can be string, object (with attributes) or array of strings/objects
      const ts = Array.isArray(r['w:t']) ? r['w:t'] : [r['w:t']];
      for (const t of ts) {
        if (!t) continue;
        if (typeof t === 'string') {
          text += t;
        } else if (typeof t === 'object') {
          if (t['#text']) {
            text += t['#text'];
          }
        }
      }
    }
    return text;
  };

  // Helper to extract style name from w:pPr -> w:pStyle
  const extractStyleFromParagraphNode = (pNode: any): string | null => {
    const pPr = pNode?.['w:pPr'];
    if (!pPr) return null;
    const pStyle = pPr['w:pStyle'];
    if (!pStyle) return null;
    return pStyle['@_w:val'] || null;
  };

  // Process elements inside body
  // The body contains w:p and w:tbl directly. fast-xml-parser might keep them as properties or in order if configured,
  // but to preserve their document order, we can parse the XML using regex to extract elements in order.
  // Wait, let's look at the child nodes of body. Since fast-xml-parser parses keys, the order of keys like w:p and w:tbl
  // might not be preserved if we just iterate them.
  // To preserve strict order of paragraphs and tables, we can scan the raw XML for <w:p> and <w:tbl> tags.
  // Let's do that! It is extremely simple to tokenize the body.
  const bodyXmlMatch = xmlText.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyXmlMatch) {
    throw new DocConverterError(`w:body non trouvé dans document.xml`);
  }
  const bodyXml = bodyXmlMatch[1];

  // Regex to match top-level tags <w:p> and <w:tbl>
  // We can write a simple parser that steps through the XML:
  let idx = 0;
  while (idx < bodyXml.length) {
    const nextP = bodyXml.indexOf('<w:p', idx);
    const nextTbl = bodyXml.indexOf('<w:tbl', idx);

    if (nextP === -1 && nextTbl === -1) {
      break;
    }

    if (nextP !== -1 && (nextTbl === -1 || nextP < nextTbl)) {
      // It's a paragraph. Find matching closing tag </w:p>
      // We must handle nested tags correctly, but w:p cannot be nested under another w:p.
      const closeP = bodyXml.indexOf('</w:p>', nextP);
      if (closeP === -1) break;
      const pXml = bodyXml.substring(nextP, closeP + 6);
      idx = closeP + 6;

      const pObj = parser.parse(pXml)['w:p'];
      if (pObj) {
        const text = extractTextFromParagraphNode(pObj);
        const styleName = extractStyleFromParagraphNode(pObj);
        const p: DocxParagraph = { text, styleName };
        paragraphs.push(p);
        allElements.push({ type: 'paragraph', text, styleName });
      }
    } else {
      // It's a table. Find matching closing tag </w:tbl>
      // w:tbl cannot be nested under another w:tbl (nested tables exist but are rare in DCE, and even if they do, simple matching works).
      const closeTbl = bodyXml.indexOf('</w:tbl>', nextTbl);
      if (closeTbl === -1) break;
      const tblXml = bodyXml.substring(nextTbl, closeTbl + 8);
      idx = closeTbl + 8;

      const tblObj = parser.parse(tblXml)['w:tbl'];
      if (tblObj) {
        const rows: string[][] = [];
        const wTrs = Array.isArray(tblObj['w:tr']) ? tblObj['w:tr'] : [tblObj['w:tr']];
        for (const tr of wTrs) {
          if (!tr) continue;
          const rowCells: string[] = [];
          const wTcs = Array.isArray(tr['w:tc']) ? tr['w:tc'] : [tr['w:tc']];
          for (const tc of wTcs) {
            if (!tc) continue;
            // A table cell tc contains paragraphs w:p
            const tcPs = Array.isArray(tc['w:p']) ? tc['w:p'] : [tc['w:p']];
            const cellTextParts: string[] = [];
            for (const p of tcPs) {
              if (p) {
                cellTextParts.push(extractTextFromParagraphNode(p));
              }
            }
            rowCells.push(cellTextParts.join(' ').trim());
          }
          rows.push(rowCells);
        }
        tables.push({ rows });
        allElements.push({ type: 'table', rows });
      }
    }
  }

  return { paragraphs, tables, allElements };
}

export function loadDocxText(filePath: string): string {
  const struct = loadDocxStructure(filePath);
  const lines: string[] = [];
  for (const el of struct.allElements) {
    if (el.type === 'paragraph') {
      lines.push(el.text);
    } else if (el.type === 'table') {
      for (const row of el.rows) {
        lines.push(row.join(' | '));
      }
    }
  }
  return lines.join('\n');
}

export async function extractPdfText(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new DocConverterError(`Fichier non trouvé : ${filePath}`);
  }
  const dataBuffer = fs.readFileSync(filePath);
  try {
    const data = await pdf(dataBuffer);
    return data.text;
  } catch (e: any) {
    throw new DocConverterError(`Échec extraction PDF : ${e.message}`);
  }
}

export function extractDocText(src: string): { text: string; method: ExtractionMethod } {
  if (sofficeAvailable()) {
    const tempDir = fs.mkdtempSync(path.join(path.dirname(src), 'gss_lo_temp_'));
    try {
      const converted = convertDocToDocx(src, tempDir);
      const text = loadDocxText(converted);
      return { text, method: ExtractionMethod.DOC_LIBREOFFICE };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
  if (findTextutil() !== null) {
    return { text: convertDocToTextTextutil(src), method: ExtractionMethod.DOC_TEXTUTIL };
  }
  throw new LibreOfficeNotFoundError(
    "Aucune voie de conversion .doc disponible : ni LibreOffice (soffice) ni " +
    "textutil (macOS). Installez LibreOffice ou renseignez SOFFICE_BIN."
  );
}

export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') {
    return loadDocxText(filePath);
  }
  if (ext === '.doc') {
    return extractDocText(filePath).text;
  }
  if (ext === '.pdf') {
    return extractPdfText(filePath);
  }
  throw new DocConverterError(`Format non supporté : ${ext} (${path.basename(filePath)})`);
}
