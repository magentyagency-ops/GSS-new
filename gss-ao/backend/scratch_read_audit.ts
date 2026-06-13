import fs from 'fs';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

const filePath = 'C:/Users/linal/stanmerci/transcription_audit_GIS_appels_offres_propre.docx';
const content = fs.readFileSync(filePath, 'binary');
const zip = new PizZip(content);
const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

console.log(doc.getFullText().substring(0, 5000)); // Print first 5000 chars to avoid overwhelming output
