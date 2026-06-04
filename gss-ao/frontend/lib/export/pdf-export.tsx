/**
 * Générateur PDF VECTORIEL (@react-pdf/renderer) — rendu fidèle au template
 * imposé de l'écran 6, cohérent avec le DOCX. Texte sélectionnable/recherchable
 * (pas une image). Police Helvetica (intégrée à react-pdf), A4 portrait.
 * 100 % client : renvoie un Blob téléchargeable.
 *
 * Cases à cocher : dessin natif (carré vectoriel + « X ») pour ne pas dépendre
 * de glyphes Unicode absents de la police Helvetica standard du PDF.
 */
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  pdf,
} from "@react-pdf/renderer";
import { DOC_DATA, DOC_HEADER, SIGNATURE } from "@/lib/export/document-model";

const C = {
  slate900: "#0F172A",
  slate700: "#334155",
  slate500: "#64748B",
  slate200: "#E2E8F0",
  slate50: "#F8FAFC",
  indigo700: "#4338CA",
  amber800: "#92400E",
  amber200: "#FDE68A",
  amber50: "#FFFBEB",
  white: "#FFFFFF",
};

const s = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    color: C.slate700,
    paddingVertical: 48,
    paddingHorizontal: 44,
    lineHeight: 1.45,
  },
  // En-tête
  header: { textAlign: "center", borderBottomWidth: 1, borderBottomColor: C.slate200, paddingBottom: 14, marginBottom: 16 },
  surtitre: { fontSize: 7, color: C.slate500, letterSpacing: 1, marginBottom: 4 },
  titre: { fontSize: 15, fontFamily: "Helvetica-Bold", color: C.slate900, marginBottom: 5 },
  meta: { fontSize: 8, color: C.slate500, marginBottom: 6 },
  candidat: { fontSize: 9, fontFamily: "Helvetica-Bold", color: C.slate700 },
  // Encadrés
  box: { borderWidth: 1, borderColor: C.slate200, borderRadius: 3, padding: 8, marginBottom: 8 },
  boxFill: { backgroundColor: C.slate50 },
  // Lignes clé/valeur
  kvRow: { flexDirection: "row", marginBottom: 2 },
  kvLabel: { color: C.slate500 },
  kvValue: { fontFamily: "Helvetica-Bold", color: C.slate900 },
  // Sections
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    color: C.slate900,
    borderBottomWidth: 1,
    borderBottomColor: C.slate200,
    paddingBottom: 3,
    marginTop: 14,
    marginBottom: 8,
  },
  subQuestion: { fontSize: 9, fontFamily: "Helvetica-Bold", color: C.slate700, marginTop: 6, marginBottom: 3 },
  body: { fontSize: 9, color: C.slate700, textAlign: "justify", marginBottom: 7 },
  // Cases à cocher
  checkRow: { flexDirection: "row", flexWrap: "wrap", marginBottom: 8 },
  checkItem: { flexDirection: "row", alignItems: "center", marginRight: 18, marginBottom: 3 },
  checkbox: {
    width: 9,
    height: 9,
    borderWidth: 1,
    borderColor: C.slate500,
    borderRadius: 1.5,
    marginRight: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: C.indigo700, borderColor: C.indigo700 },
  checkX: { fontSize: 7, color: C.white, fontFamily: "Helvetica-Bold", lineHeight: 1 },
  checkLabel: { fontSize: 9, color: C.slate700 },
  checkLabelOn: { color: C.indigo700, fontFamily: "Helvetica-Bold" },
  // Section III
  iiiTitle: { fontFamily: "Helvetica-Bold", color: C.slate900, marginBottom: 4 },
  iiiPts: { fontFamily: "Helvetica", color: C.slate500 },
  // Section IV note
  note: { backgroundColor: C.amber50, borderWidth: 1, borderColor: C.amber200, borderRadius: 3, padding: 7, marginBottom: 10, color: C.amber800 },
  bullet: { flexDirection: "row", marginBottom: 2, marginLeft: 4 },
  bulletDot: { width: 10, color: C.slate700 },
  // Tableau délais
  table: { borderWidth: 1, borderColor: C.slate200, borderRadius: 3, marginBottom: 8 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: C.slate200 },
  trLast: { borderBottomWidth: 0 },
  trHead: { backgroundColor: C.slate50 },
  thSite: { flex: 1, padding: 5, fontSize: 8, fontFamily: "Helvetica-Bold", color: C.slate700 },
  thDelai: { width: 130, padding: 5, fontSize: 8, fontFamily: "Helvetica-Bold", color: C.slate700, textAlign: "right" },
  tdSite: { flex: 1, padding: 5, fontSize: 9, color: C.slate700 },
  tdDelai: { width: 130, padding: 5, fontSize: 9, fontFamily: "Helvetica-Bold", color: C.slate700, textAlign: "right" },
  // Intervenants
  intervBox: { flexDirection: "row", alignItems: "baseline", alignSelf: "flex-start", backgroundColor: C.slate50, borderWidth: 1, borderColor: C.slate200, borderRadius: 3, paddingVertical: 6, paddingHorizontal: 12 },
  intervNum: { fontSize: 20, fontFamily: "Helvetica-Bold", color: C.indigo700, marginRight: 5 },
  intervLabel: { fontSize: 9, color: C.slate500 },
  // Signature
  signature: { borderTopWidth: 1, borderTopColor: C.slate200, marginTop: 18, paddingTop: 12, textAlign: "right" },
  sigLine: { fontSize: 9, marginBottom: 2, color: C.slate700 },
  sigBold: { fontFamily: "Helvetica-Bold", color: C.slate900 },
  sigItalic: { fontFamily: "Helvetica-Oblique", color: C.slate500 },
});

function KV({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.kvRow}>
      <Text style={s.kvLabel}>{label} : </Text>
      <Text style={s.kvValue}>{value}</Text>
    </View>
  );
}

function ContactBox({ c }: { c: { nom: string; fonction: string; tel: string; email: string } }) {
  return (
    <View style={[s.box, s.boxFill]}>
      <KV label="Nom" value={c.nom} />
      <KV label="Fonction" value={c.fonction} />
      <KV label="Téléphone" value={c.tel} />
      <KV label="Email" value={c.email} />
    </View>
  );
}

function Checks({ options }: { options: { label: string; checked: boolean }[] }) {
  return (
    <View style={s.checkRow}>
      {options.map((o) => (
        <View key={o.label} style={s.checkItem}>
          <View style={[s.checkbox, ...(o.checked ? [s.checkboxOn] : [])]}>
            {o.checked ? <Text style={s.checkX}>X</Text> : null}
          </View>
          <Text style={o.checked ? [s.checkLabel, s.checkLabelOn] : s.checkLabel}>{o.label}</Text>
        </View>
      ))}
    </View>
  );
}

function MemoireDocument() {
  const { identite, sectionI, sectionII, sectionIII, sectionIV, delais, nbIntervenants } = DOC_DATA;
  return (
    <Document title="Mémoire technique — Univ Rouen MP2026-08" author="GSS-AO">
      <Page size="A4" style={s.page}>
        {/* En-tête */}
        <View style={s.header}>
          <Text style={s.surtitre}>{DOC_HEADER.surtitre}</Text>
          <Text style={s.titre}>{DOC_HEADER.titre}</Text>
          <Text style={s.meta}>
            {DOC_HEADER.acheteur} · {DOC_HEADER.reference} · Remise le {DOC_HEADER.remiseLe}
          </Text>
          <Text style={s.candidat}>Candidat : {DOC_HEADER.candidat}</Text>
        </View>

        {/* Identité candidat */}
        <View style={s.box}>
          <KV label="Dénomination du candidat" value={identite.denomination} />
          <KV label="N° CNAPS d'autorisation d'exercer" value={identite.num_cnaps} />
          <KV label="Date d'obtention de l'autorisation" value={identite.date_autorisation} />
        </View>

        {/* Section I */}
        <Text style={s.sectionTitle}>
          {sectionI.num}. {sectionI.titre} ({sectionI.points} pts)
        </Text>
        {sectionI.sousQuestions.map((q) => (
          <View key={q.n} wrap={false}>
            <Text style={s.subQuestion}>
              {q.n}. {q.label}
            </Text>
            <Text style={s.body}>{q.reponse}</Text>
          </View>
        ))}
        <Text style={s.subQuestion}>3. {sectionI.soustraitance.label}</Text>
        <Checks options={sectionI.soustraitance.options} />
        <Text style={s.subQuestion}>4. {sectionI.dispositifAbsence.label}</Text>
        <Text style={s.body}>{sectionI.dispositifAbsence.reponse}</Text>
        <Text style={s.subQuestion}>5. {sectionI.interlocuteurPrincipal.label}</Text>
        <ContactBox c={sectionI.interlocuteurPrincipal.contact} />
        <Text style={s.subQuestion}>6. {sectionI.interlocuteurDevis.label}</Text>
        <ContactBox c={sectionI.interlocuteurDevis.contact} />

        {/* Section II */}
        <Text style={s.sectionTitle}>
          {sectionII.num}. {sectionII.titre} ({sectionII.points} pts)
        </Text>
        <Text style={s.body}>{sectionII.reponse}</Text>

        {/* Section III */}
        <Text style={s.sectionTitle}>
          {sectionIII.num}. {sectionIII.titre}
        </Text>
        {sectionIII.blocs.map((b) => (
          <View key={b.titre} style={s.box} wrap={false}>
            <Text style={s.iiiTitle}>
              {b.titre} <Text style={s.iiiPts}>({b.points} pts)</Text>
            </Text>
            <Text style={s.body}>{b.reponse}</Text>
          </View>
        ))}

        {/* Section IV */}
        <Text style={s.sectionTitle}>
          {sectionIV.num}. {sectionIV.titre} ({sectionIV.points} pts — lot 3 uniquement)
        </Text>
        <Text style={s.note}>{sectionIV.lotNote}</Text>
        <Text style={s.subQuestion}>1. {sectionIV.apsad.label}</Text>
        <Checks options={sectionIV.apsad.options} />
        <Text style={s.subQuestion}>2. {sectionIV.localisation.label}</Text>
        <Text style={s.body}>{sectionIV.localisation.reponse}</Text>
        <Text style={s.subQuestion}>3. {sectionIV.soustraitanceLeverDoute.label}</Text>
        {sectionIV.soustraitanceLeverDoute.departements.map((d) => (
          <View key={d.dep} style={s.bullet}>
            <Text style={s.bulletDot}>•</Text>
            <Text style={{ flex: 1 }}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Département {d.dep} : </Text>
              {d.valeur}
            </Text>
          </View>
        ))}
        <Text style={s.subQuestion}>4. {sectionIV.reportAlarmes.label}</Text>
        <Text style={s.body}>{sectionIV.reportAlarmes.reponse}</Text>
        <Text style={s.subQuestion}>5. {sectionIV.moyensOuverture.label}</Text>
        <Text style={s.body}>{sectionIV.moyensOuverture.reponse}</Text>
        <Text style={s.subQuestion}>6. {sectionIV.delaisLabel}</Text>
        <View style={s.table}>
          <View style={[s.tr, s.trHead]}>
            <Text style={s.thSite}>Site</Text>
            <Text style={s.thDelai}>Délai max. d&apos;intervention</Text>
          </View>
          {delais.map((d, i) => (
            <View key={d.site} style={i === delais.length - 1 ? [s.tr, s.trLast] : s.tr}>
              <Text style={s.tdSite}>{d.site}</Text>
              <Text style={s.tdDelai}>{d.delai_minutes} min</Text>
            </View>
          ))}
        </View>
        <Text style={s.subQuestion}>7. {sectionIV.intervenantsLabel}</Text>
        <View style={s.intervBox}>
          <Text style={s.intervNum}>{nbIntervenants}</Text>
          <Text style={s.intervLabel}>intervenants véhiculés</Text>
        </View>

        {/* Signature */}
        <View style={s.signature}>
          <Text style={s.sigLine}>
            Fait à {SIGNATURE.lieu}, le {SIGNATURE.date}
          </Text>
          <Text style={[s.sigLine, s.sigBold]}>{SIGNATURE.entreprise}</Text>
          <Text style={s.sigLine}>{SIGNATURE.signataire}</Text>
          <Text style={[s.sigLine, s.sigItalic]}>{SIGNATURE.mention}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function generatePdfBlob(): Promise<Blob> {
  return pdf(<MemoireDocument />).toBlob();
}
