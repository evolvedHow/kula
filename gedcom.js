/**********************************************************************
 *  KULA GENEALOGY PLUGIN - GEDCOM 5.5.1 EXPORTER
 *
 *  Reads the live workbook (Persons, KG, Vedic, Stories) and writes a
 *  LINEAGE-LINKED GEDCOM file to the user's Google Drive, then shows a
 *  download link.
 *
 *  The KG tab is the only relationship source: `spouseOf` edges become
 *  FAM records, `parentOf` / `childOf` edges become the children of
 *  those families, and a child linked to only one parent is attached to
 *  that parent's existing family when the match is unambiguous.
 *
 *  IDs are sanitised for GEDCOM xrefs (letters, digits and underscore
 *  only). The original sheet PID is preserved in a `_PID` attribute.
 *********************************************************************/

/**
 * Core export routine. Creates the GEDCOM file in Drive and returns the
 * file name, download URL and skip count. The UI layer (menu or sidebar)
 * decides how to present the result.
 *
 * @return {{fileName: string, downloadUrl: string, skippedCount: number}}
 */
function exportGedcomFileCore_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  /**
   * Finds a tab by exact name first, then by case-insensitive substring.
   *
   * @param {string} nameKey Tab name or fragment.
   * @return {SpreadsheetApp.Sheet|null} Matching sheet.
   */
  function getSheet(nameKey) {
    const exact = ss.getSheets().find(s => s.getName().toLowerCase() === nameKey.toLowerCase());
    if (exact) return exact;
    return ss.getSheets().find(s => s.getName().toLowerCase().indexOf(nameKey.toLowerCase()) !== -1) || null;
  }

  const personsSheet = getSheet('Persons');
  const kgSheet = getSheet('KG');
  const vedicSheet = getSheet('Vedic');
  const storiesSheet = getSheet('Stories');

  if (!personsSheet || !kgSheet) {
    ui.alert("Error: Required sheets ('Persons' and 'KG') were not found.");
    return;
  }

  /**
   * Reads a sheet into header-mapped row objects. The first row is the
   * header; blank header cells are ignored.
   *
   * @param {SpreadsheetApp.Sheet|null} sheet Sheet to read.
   * @return {Object[]} One object per data row.
   */
  function parseSheet(sheet) {
    if (!sheet) return [];
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    const headers = data[0].map(h => String(h).trim().toUpperCase());
    return data.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = row[i];
      });
      return obj;
    });
  }

  /**
   * Extracts the PID from a readable reference.
   *
   * `A001-Venkiteswara Iyer`, `P-101-Himavan` and a bare `P001` all reduce
   * to their PID prefix. The name half is only a label and may be stale.
   *
   * @param {*} value Cell value.
   * @return {string} Upper-case PID, or an empty string when absent.
   */
  function cleanId(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return '';
    const match = text.match(/^([A-Z]-?\d+)\b/i);
    return match ? match[1].toUpperCase() : '';
  }

  /**
   * Escapes text for a single GEDCOM line: no newlines, and `@` is doubled
   * because a lone `@` introduces an xref pointer.
   *
   * @param {*} value Raw value.
   * @return {string} Escaped single-line text.
   */
  function gedcomText_(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n?/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/@/g, '@@')
      .trim();
  }

  /** Three-letter month names in GEDCOM upper case. */
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  /**
   * Maps a month name or abbreviation to its 1-based number.
   *
   * @param {string} name Month text, for example "Jan" or "September".
   * @return {number} Month number, or 0 when unknown.
   */
  function monthNumber_(name) {
    const key = String(name || '').trim().toLowerCase().substring(0, 3);
    return MONTHS.findIndex(m => m.toLowerCase() === key) + 1;
  }

  /**
   * Formats a day/month/year triple as a GEDCOM date.
   *
   * @param {number} day Day of month.
   * @param {number} month Month number (1-12).
   * @param {number} year Four-digit year.
   * @return {string} For example "1 JAN 1895", or an empty string.
   */
  function gedcomDateParts_(day, month, year) {
    if (!(day >= 1 && day <= 31) || !(month >= 1 && month <= 12) || !(year > 0)) {
      return '';
    }
    return `${day} ${MONTHS[month - 1]} ${year}`;
  }

  /**
   * Converts a sheet value into a GEDCOM date.
   *
   * Handles Date objects, Sheets/Excel serial numbers, the sheet's
   * "Jan-1/1895 0:0" form, "1 Jan 1895", month-year, year-only, ISO dates
   * and a native Date fallback. Anything else becomes a GEDCOM date phrase
   * in parentheses so the information is not lost.
   *
   * @param {*} value Raw cell value.
   * @return {string} GEDCOM date or date phrase, or an empty string.
   */
  function formatGedcomDate(value) {
    if (value === null || value === undefined || value === '') return '';

    if (Object.prototype.toString.call(value) === '[object Date]') {
      if (isNaN(value.getTime())) return '';
      return gedcomDateParts_(value.getDate(), value.getMonth() + 1, value.getFullYear());
    }

    let text = String(value).trim();
    if (!text || text === '#VALUE!' || /^not known$/i.test(text)) return '';
    text = text.replace(/\s+/g, ' ');

    // Sheets/Excel serial date (days since 1899-12-30). A bare four-digit
    // value in the year range is a year, not a serial.
    if (/^\d{5}(\.\d+)?$/.test(text) || /^\d{4}\.\d+$/.test(text)) {
      const serial = parseFloat(text);
      const ms = Math.round((serial - 25569) * 86400000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
        return gedcomDateParts_(d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear());
      }
    }

    // "Jan-1/1895 0:0" - the month/day/year form used by the sheet.
    let m = text.match(/^([A-Za-z]{3,})[-\s]+(\d{1,2})\/(\d{4})/);
    if (m) {
      return gedcomDateParts_(parseInt(m[2], 10), monthNumber_(m[1]), parseInt(m[3], 10));
    }

    // "1 Jan 1895" or "1 Jan 1895, 22:37"
    m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s,-]+(\d{4})/);
    if (m) {
      return gedcomDateParts_(parseInt(m[1], 10), monthNumber_(m[2]), parseInt(m[3], 10));
    }

    // "Jan 1895"
    m = text.match(/^([A-Za-z]{3,})[\s-]+(\d{4})$/);
    if (m) {
      const month = monthNumber_(m[1]);
      return month ? `${MONTHS[month - 1]} ${m[2]}` : `(${text})`;
    }

    // "1895"
    m = text.match(/^(\d{4})$/);
    if (m) return m[1];

    // "1895-01-01" or "1895/01/01"
    m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) {
      return gedcomDateParts_(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10));
    }

    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return gedcomDateParts_(parsed.getDate(), parsed.getMonth() + 1, parsed.getFullYear());
    }

    return `(${text})`;
  }

  /**
   * Formats a multi-line note as a GEDCOM NOTE with CONT/CONC continuation
   * lines. GEDCOM lines are limited to 255 characters, so long lines are
   * split at 200 characters for headroom.
   *
   * @param {*} text Note text.
   * @param {number} level GEDCOM level for the NOTE tag.
   * @return {string} One or more newline-terminated GEDCOM lines.
   */
  function formatGedcomNote(text, level) {
    if (text === null || text === undefined || text === '') return '';
    const raw = String(text).replace(/<br\s*\/?>/gi, '\n').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return '';

    const out = [];
    lines.forEach((line, index) => {
      let rest = gedcomText_(line);
      const tag = index === 0 ? 'NOTE' : 'CONT';
      const tagLevel = index === 0 ? level : level + 1;
      out.push(`${tagLevel} ${tag} ${rest.slice(0, 200)}`);
      rest = rest.slice(200);
      while (rest.length > 0) {
        out.push(`${level + 1} CONC ${rest.slice(0, 200)}`);
        rest = rest.slice(200);
      }
    });

    return out.join('\n') + '\n';
  }

  /**
   * Maps a sheet PID to a GEDCOM xref ID. GEDCOM allows only letters,
   * digits and underscore, so `P-101` becomes `P_101`.
   *
   * @param {string} pid Sheet PID.
   * @return {string} Unique GEDCOM xref ID.
   */
  const xrefs = {};
  const usedXrefs = new Set();
  function xrefFor_(pid) {
    if (xrefs[pid]) return xrefs[pid];
    const base = String(pid).replace(/[^A-Za-z0-9_]/g, '_') || 'X';
    let id = base;
    let suffix = 2;
    while (usedXrefs.has(id)) {
      id = `${base}_${suffix}`;
      suffix++;
    }
    usedXrefs.add(id);
    xrefs[pid] = id;
    return id;
  }

  /**
   * Splits a sheet name into given, surname and nickname.
   *
   * A trailing parenthetical is treated as a nickname, e.g.
   * "Rajalakshmi Krishnamurthy ( Rajam )" -> given "Rajalakshmi",
   * surname "Krishnamurthy", nickname "Rajam".
   *
   * @param {*} value Name cell.
   * @return {{given: string, surname: string, nickname: string}} Parsed parts.
   */
  function splitNameForGedcom_(value) {
    let text = String(value == null ? '' : value).trim();
    let nickname = '';
    const match = text.match(/\s*\(([^)]*)\)\s*$/);
    if (match) {
      nickname = match[1].trim();
      text = text.slice(0, match.index).trim();
    }
    const parts = text.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return { given: text, surname: '', nickname };
    }
    return { given: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1], nickname };
  }

  /**
   * Normalises a KG predicate to one of spouse/parent/child.
   *
   * @param {*} value Predicate cell.
   * @return {string} "spouse", "parent", "child" or an empty string.
   */
  function predicateKind_(value) {
    const text = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
    if (['spouseof', 'spouse', 'husband', 'wife', 'married'].indexOf(text) !== -1) return 'spouse';
    if (['parentof', 'parent', 'father', 'mother'].indexOf(text) !== -1) return 'parent';
    if (['childof', 'child', 'offspring', 'son', 'daughter'].indexOf(text) !== -1) return 'child';
    return '';
  }

  const personsData = parseSheet(personsSheet);
  const kgData = parseSheet(kgSheet);
  const vedicData = parseSheet(vedicSheet);
  const storiesData = parseSheet(storiesSheet);

  const personsMap = {};
  const genderMap = {};
  const vedicMap = {};
  const storiesMap = {};

  personsData.forEach(p => {
    const pid = cleanId(p.PID);
    if (!pid) return;
    personsMap[pid] = p;
    const gender = String(p.GENDER == null ? '' : p.GENDER).trim().toLowerCase();
    genderMap[pid] = gender.charAt(0) === 'f' ? 'F' : (gender.charAt(0) === 'm' ? 'M' : '');
  });

  vedicData.forEach(v => {
    const pid = cleanId(v.PERSON) || cleanId(v.PERSON_NAME);
    if (pid) vedicMap[pid] = v;
  });

  storiesData.forEach(s => {
    if (!s.TAGGED_PEOPLE) return;
    const text = `${s.TITLE ? String(s.TITLE).trim() + ': ' : ''}${s.TEXT || ''}`;
    if (!text.trim()) return;
    String(s.TAGGED_PEOPLE).split(/[;,]/).forEach(part => {
      const pid = cleanId(part);
      if (!pid || !personsMap[pid]) return;
      if (!storiesMap[pid]) storiesMap[pid] = [];
      storiesMap[pid].push(text);
    });
  });

  const spouses = [];
  const parentsMap = {};
  const skippedEdges = [];

  /**
   * Records one parent link for a child.
   *
   * @param {string} childId Child PID.
   * @param {string} parentId Parent PID.
   * @return {void}
   */
  function addParent_(childId, parentId) {
    if (!parentsMap[childId]) parentsMap[childId] = { father: null, mother: null };
    if (genderMap[parentId] === 'F') parentsMap[childId].mother = parentId;
    else parentsMap[childId].father = parentId;
  }

  kgData.forEach(edge => {
    const subj = cleanId(edge.SUBJECT);
    const obj = cleanId(edge.OBJECT);
    const kind = predicateKind_(edge.PREDICATE);
    if (!subj || !obj || subj === obj) return;
    if (!personsMap[subj] || !personsMap[obj]) {
      skippedEdges.push(`${subj || '?'} ${edge.PREDICATE || '?'} ${obj || '?'}`);
      return;
    }

    if (kind === 'spouse') {
      let husband;
      let wife;
      if (genderMap[subj] === 'F') {
        wife = subj;
        husband = obj;
      } else if (genderMap[subj] === 'M') {
        husband = subj;
        wife = obj;
      } else if (genderMap[obj] === 'F') {
        wife = obj;
        husband = subj;
      } else if (genderMap[obj] === 'M') {
        husband = obj;
        wife = subj;
      } else {
        // No gender on either side: keep the sheet's reading order.
        husband = subj;
        wife = obj;
      }
      spouses.push({ husband, wife, date: formatGedcomDate(edge.DATE) });
    } else if (kind === 'parent') {
      addParent_(obj, subj);
    } else if (kind === 'child') {
      addParent_(subj, obj);
    }
  });

  const families = [];
  const familyById = {};
  const familyLookup = {};
  const personFamSpouse = {};
  const personFamChild = {};

  /**
   * Finds or creates the family for a couple.
   *
   * @param {string|null} husband Husband PID.
   * @param {string|null} wife Wife PID.
   * @param {string} marriageDate GEDCOM marriage date, or "".
   * @return {Object} Family record.
   */
  function getOrCreateFamily(husband, wife, marriageDate) {
    const key = `${husband || 'UNKNOWN'}_${wife || 'UNKNOWN'}`;
    if (familyLookup[key]) {
      if (!familyLookup[key].date && marriageDate) familyLookup[key].date = marriageDate;
      return familyLookup[key];
    }

    const family = {
      id: `F${families.length + 1}`,
      husband: husband || null,
      wife: wife || null,
      date: marriageDate || '',
      children: [],
    };
    families.push(family);
    familyById[family.id] = family;
    familyLookup[key] = family;

    if (husband) {
      if (!personFamSpouse[husband]) personFamSpouse[husband] = [];
      personFamSpouse[husband].push(family.id);
    }
    if (wife) {
      if (!personFamSpouse[wife]) personFamSpouse[wife] = [];
      personFamSpouse[wife].push(family.id);
    }
    return family;
  }

  spouses.forEach(s => getOrCreateFamily(s.husband, s.wife, s.date));

  Object.keys(parentsMap).forEach(childId => {
    const father = parentsMap[childId].father;
    const mother = parentsMap[childId].mother;
    let family = null;

    if (father && mother) {
      family = getOrCreateFamily(father, mother, '');
    } else {
      const known = father || mother;
      const candidates = (personFamSpouse[known] || []).map(id => familyById[id]).filter(Boolean);
      if (candidates.length === 1) {
        // The known parent has exactly one family, so co-parenting is
        // unambiguous even though this edge named only one parent.
        family = candidates[0];
      } else {
        const open = candidates.filter(f => (father ? !f.mother : !f.father));
        family = open.length === 1 ? open[0] : getOrCreateFamily(father, mother, '');
      }
    }

    if (!family) return;
    if (family.children.indexOf(childId) === -1) family.children.push(childId);
    if (!personFamChild[childId]) personFamChild[childId] = [];
    if (personFamChild[childId].indexOf(family.id) === -1) personFamChild[childId].push(family.id);
  });

  const gedcom = [];
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'd MMM yyyy').toUpperCase();
  gedcom.push('0 HEAD');
  gedcom.push('1 SOUR KULA_APP');
  gedcom.push('2 NAME Kula Family Tree');
  gedcom.push('2 VERS 1.0');
  gedcom.push('1 GEDC');
  gedcom.push('2 VERS 5.5.1');
  gedcom.push('2 FORM LINEAGE-LINKED');
  gedcom.push('1 CHAR UTF-8');
  gedcom.push(`1 DATE ${today}`);

  Object.keys(personsMap).forEach(pid => {
    const person = personsMap[pid];
    const xref = xrefFor_(pid);
    gedcom.push(`0 @${xref}@ INDI`);

    const fullName = String(person.FULL_NAME || person.KNOWN_NAME || pid).trim();
    const nameParts = splitNameForGedcom_(fullName);
    gedcom.push(`1 NAME ${gedcomText_(nameParts.given)} /${gedcomText_(nameParts.surname)}/`);
    if (nameParts.nickname) {
      gedcom.push(`2 NICK ${gedcomText_(nameParts.nickname)}`);
    }
    gedcom.push(`1 _PID ${gedcomText_(pid)}`);

    if (genderMap[pid]) gedcom.push(`1 SEX ${genderMap[pid]}`);

    const dob = formatGedcomDate(person.DOB);
    const pob = gedcomText_(person.POB);
    if (dob || pob) {
      gedcom.push('1 BIRT');
      if (dob) gedcom.push(`2 DATE ${dob}`);
      if (pob) gedcom.push(`2 PLAC ${pob}`);
    }

    const status = String(person.STATUS == null ? '' : person.STATUS).trim().toLowerCase();
    const dod = formatGedcomDate(person.DOD);
    const pod = gedcomText_(person.POD);
    if (status === 'deceased' || dod || pod) {
      gedcom.push('1 DEAT');
      if (dod) gedcom.push(`2 DATE ${dod}`);
      if (pod) gedcom.push(`2 PLAC ${pod}`);
    }

    const email = gedcomText_(person.EMAIL);
    if (email) gedcom.push(`1 _EMAIL ${email}`);

    if (person.NOTES) {
      const note = formatGedcomNote(person.NOTES, 1);
      if (note) gedcom.push(note.trim());
    }

    (storiesMap[pid] || []).forEach(story => {
      const note = formatGedcomNote(story, 1);
      if (note) gedcom.push(note.trim());
    });

    const vedic = vedicMap[pid];
    if (vedic) {
      const custom = {
        _GOTRA: vedic.GOTRA,
        _VEDA: vedic.VEDA,
        _SHAKHA: vedic.SHAKHA,
        _SUTRA: vedic.SUTRA,
        _NAKSHATRA: vedic.NAKSHATRA,
        _KULA_DEVATHA: vedic.KULA_DEVATHA,
        _SAMPRADAYA: vedic.SAMPRADAYA,
        _PURVIKAM: vedic.PURVIKAM,
      };
      Object.keys(custom).forEach(tag => {
        const value = gedcomText_(custom[tag]);
        if (value) gedcom.push(`1 ${tag} ${value}`);
      });
    }

    (personFamChild[pid] || []).forEach(familyId => {
      gedcom.push(`1 FAMC @${familyId}@`);
    });
    (personFamSpouse[pid] || []).forEach(familyId => {
      gedcom.push(`1 FAMS @${familyId}@`);
    });
  });

  families.forEach(family => {
    gedcom.push(`0 @${family.id}@ FAM`);
    if (family.husband) gedcom.push(`1 HUSB @${xrefFor_(family.husband)}@`);
    if (family.wife) gedcom.push(`1 WIFE @${xrefFor_(family.wife)}@`);
    if (family.date) {
      gedcom.push('1 MARR');
      gedcom.push(`2 DATE ${family.date}`);
    }
    family.children.forEach(childId => {
      gedcom.push(`1 CHIL @${xrefFor_(childId)}@`);
    });
  });

  gedcom.push('0 TRLR');

  const fileContent = gedcom.filter(line => line.length > 0).join('\n');
  const safeName = String(ss.getName() || 'Kula').replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  const fileName = `${safeName}_FamilyTree_${stamp}.ged`;
  const file = DriveApp.createFile(fileName, fileContent, MimeType.PLAIN_TEXT);

  return {
    fileName: fileName,
    downloadUrl: file.getDownloadUrl(),
    skippedCount: skippedEdges.length,
  };
}

/**
 * Menu entry point: exports the whole workbook as a GEDCOM 5.5.1 file and
 * shows a modal download link.
 *
 * @return {void}
 */
function exportGedcomFile() {
  const result = exportGedcomFileCore_();
  const skipNote = result.skippedCount
    ? `<p style="color: #b3261e;">${result.skippedCount} relationship row(s) referenced unknown people and were skipped.</p>`
    : '';
  const htmlOutput = HtmlService.createHtmlOutput(
    `<div style="font-family: sans-serif; padding: 15px;">
       <h3>GEDCOM File Exported Successfully!</h3>
       <p>File saved to Google Drive: <b>${result.fileName}</b></p>
       ${skipNote}
       <a href="${result.downloadUrl}" target="_blank"
          style="display: inline-block; background-color: #1a73e8; color: white; padding: 10px 18px; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Download GEDCOM File
        </a>
      </div>`
  ).setWidth(420).setHeight(240);

  SpreadsheetApp.getUi().showModalDialog(htmlOutput, 'Export Complete');
}
