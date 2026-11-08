/**********************************************************************
 *  KULA GENEALOGY PLUGIN — KNOWLEDGE GRAPH EDITION
 *
 *  Entry points, in the order Google calls them:
 *    onInstall  - first install; delegates to onOpen so menus appear.
 *    onOpen     - simple trigger on every spreadsheet open (menu build).
 *    onHomepage - add-on homepage trigger; MUST return Card objects.
 *
 *  Every action is written twice on purpose: a `*Core_` function that
 *  returns a human-readable summary string and never touches the UI,
 *  plus thin callers for the two surfaces that can display it. Alerts
 *  (SpreadsheetApp.getUi) are unavailable in the add-on card context,
 *  so card callbacks turn the same string into a notification instead.
 *********************************************************************/

const CFG = {
  INSTRUCTIONS: 'Instructions',
  PERSONS: 'Persons',
  KG: 'KG',               // Knowledge Graph tab (Subject | Predicate | Object)
  FLATGRAPH: 'KG_FLAT',   // Output tab for flattened graph triples
  VEDIC: 'Vedic',
  STORIES: 'Stories',
  CONFIG: '$Config',      // Gotra defaults for veda, shakha, sutra, nakshatra
  MAPPING: 'ID_Mapping_Key',
  REPORT: 'Renumber_Report',
  REFACTOR: 'Refactor_Report'
};

/** Canonical relationship predicates offered in the KG dropdown. */
const PREDICATES = ['spouseOf', 'parentOf', 'childOf'];

/**
 * The data-entry contract for every tab the plugin owns. Setup writes these
 * headers into empty tabs, and Check Sheet Setup compares existing tabs
 * against them, so a workbook created by an older version is reported as
 * mismatched instead of silently ignored.
 */
const SCHEMA = {
  [CFG.PERSONS]: {
    headers: ["PID", "KNOWN_NAME", "FULL_NAME", "REF_NAME", "EMAIL", "GENDER", "DOB", "POB", "CUR_LOC", "STATUS", "DOD", "POD", "NOTES", "GEN"],
    sample: [
      ["A001", "Venkiteswara Iyer", "Venkiteswara Iyer", "", "", "M", "1900", "Perumbavoor", "", "Deceased", "1965", "Kolkatta", "Head Patriarch", "A"],
      ["A002", "Rajammal", "Rajammal Iyer", "", "", "F", "1905", "Perumbavoor", "", "Deceased", "1980", "Chennai", "Spouse", "A"],
      ["B001", "Viswanatha Iyer", "Viswanatha Iyer", "", "", "M", "1930", "Perumbavoor", "", "Living", "", "", "Child", "B"]
    ]
  },
  [CFG.KG]: {
    // PIDs only; SUBJECT_NAME/OBJECT_NAME are read-only previews.
    headers: ["SUBJECT", "SUBJECT_NAME", "PREDICATE", "OBJECT", "OBJECT_NAME", "DATE", "NOTES"],
    sample: [
      ["A001", "", "spouseOf", "A002", "", "", ""],
      ["A001", "", "parentOf", "B001", "", "", ""]
    ]
  },
  [CFG.VEDIC]: {
    // Matches the columns the live Kula-Data sheet already uses. PARVATA was
    // dropped: the sheet never carried it, so demanding it made every Vedic
    // tab look incomplete.
    headers: ["PERSON", "PERSON_NAME", "GOTRA", "VEDA", "SHAKHA", "SUTRA", "NAKSHATRA", "KULA_DEVATHA", "SAMPRADAYA", "ACHARYA_THIRUMALIGAI", "PURVIKAM"],
    sample: ["A001", "", "Bharadwaja", "Yajurveda", "Apastamba", "Bodhayana", "Rohini", "", "", "", ""]
  },
  [CFG.STORIES]: {
    headers: ["NOTE_ID", "TYPE", "TITLE", "IS_STORY", "TAGGED_PEOPLE", "TAGGED_NAMES", "TEXT", "UPDATED"],
    sample: ["N001", "Story", "Family Migration", "TRUE", "A001", "", "Moved to Kolkata in 1925.", ""]
  }
};

/**
 * Columns for the generated $Config tab. Deliberately outside SCHEMA: setup
 * does not create it, it is produced on demand from the Vedic tab. These are
 * the same eight lineage columns as Vedic (minus PERSON), matching the
 * existing Kula-Data $Config tab.
 */
const CONFIG_HEADERS = [
  'GOTRA', 'VEDA', 'SHAKHA', 'SUTRA', 'NAKSHATRA',
  'SAMPRADAYA', 'ACHARYA_THIRUMALIGAI', 'KULA_DEVATHA'
];

/**
 * Alternate spellings for canonical headers. Setup writes the key; a
 * workbook that already uses the alias is not reported as missing a column.
 */
const HEADER_ALIASES = {
  'SUBJECT': ['Subject (Node 1)'],
  'OBJECT': ['Object (Node 2)']
};

/**
 * Read-only preview columns. Each maps a stored reference column to a formula
 * column that renders the person's name, so the sheet stays readable while the
 * stored value remains a PID. `list` marks a column that can hold several
 * references in one cell.
 */
const PREVIEWS = [
  { tab: CFG.KG, ref: 'SUBJECT', refAliases: ['Subject (Node 1)'], name: 'SUBJECT_NAME', list: false },
  { tab: CFG.KG, ref: 'OBJECT', refAliases: ['Object (Node 2)'], name: 'OBJECT_NAME', list: false },
  { tab: CFG.VEDIC, ref: 'PERSON', refAliases: [], name: 'PERSON_NAME', list: false },
  { tab: CFG.STORIES, ref: 'TAGGED_PEOPLE', refAliases: [], name: 'TAGGED_NAMES', list: true }
];

/** Headers that setup creates but that an older sheet may lack; not an error. */
const OPTIONAL_HEADERS = new Set(PREVIEWS.map(p => p.name));

/* ====================================================================
 * 0. UI BRIDGE
 * ==================================================================== */

/**
 * Returns the active spreadsheet or throws a message a user can act on.
 * The add-on homepage can be opened with no sheet in context, in which
 * case getActiveSpreadsheet() is null rather than an error.
 *
 * @return {SpreadsheetApp.Spreadsheet} The spreadsheet to operate on.
 * @throws {Error} When no spreadsheet is available in this invocation.
 */
function requireSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Open a spreadsheet in Kula format, then reopen this add-on.');
  }
  return ss;
}

/**
 * Shows a message through the classic spreadsheet UI. Used only from menu
 * items, where a Ui object exists.
 *
 * @param {string} message Text to display.
 */
function alert_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (err) {
    Logger.log(message);
  }
}

/**
 * Wraps a core function for a Card Service callback, converting its
 * returned summary (or thrown error) into an add-on notification.
 *
 * @param {function(): string} coreFn Zero-argument function returning text.
 * @return {CardService.ActionResponse} Response carrying the notification.
 */
function cardResponse_(coreFn) {
  let text;
  try {
    text = coreFn();
  } catch (err) {
    text = 'Error: ' + (err && err.message ? err.message : String(err));
    Logger.log(text);
  }
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

/* ====================================================================
 * 1. CUSTOM MENU (ON OPEN)
 * ==================================================================== */

/**
 * Builds the spreadsheet menu. Also serves as the onInstall handler so an
 * add-on that was just installed shows its menu without a reload.
 *
 * The menu is created even before authorization; clicking any item will
 * trigger the OAuth prompt, after which the item runs.
 *
 * @param {Object=} e Open event; absent when called from onInstall.
 */
function onOpen(e) {
  const ui = SpreadsheetApp.getUi();

  const setupMenu = ui.createMenu('🚀 Plugin Setup')
    .addItem('Setup / Reset Workspace Tabs', 'setupDatabaseTabs')
    .addItem('Generate $Config (gotra defaults)', 'generateConfig')
    .addItem('Normalize References (PID only)', 'normalizeReferences');

  const flattenSubMenu = ui.createMenu('🕸 Flatten Knowledge Graph')
    .addItem('All (Spouses, Parents & Offsprings)', 'runFlattenAll')
    .addItem('Parents Only (parentOf)', 'runFlattenParents')
    .addItem('Offsprings Only (childOf)', 'runFlattenOffsprings');

  const renumSubMenu = ui.createMenu('🏷️ Person Numbering')
    .addItem('Preview Numbering Tiers', 'previewRenumber')
    .addItem('Apply Generational PIDs', 'applyRenumber');

  ui.createMenu('Kula Genealogy')
    .addSubMenu(setupMenu)
    .addSeparator()
    .addSubMenu(flattenSubMenu)
    .addSubMenu(renumSubMenu)
    .addSeparator()
    .addItem('Check Sheet Setup', 'checkSheetSetup')
    .addItem('Validate Reference Integrity', 'validateData')
    .addToUi();
}

/**
 * Install handler. Delegates to onOpen so menu items exist immediately
 * after the add-on is granted access.
 *
 * @param {Object} e Install event.
 */
function onInstall(e) {
  onOpen(e);
}

/* ====================================================================
 * 1b. ADD-ON HOMEPAGE (CARD SERVICE)
 * ==================================================================== */

/**
 * Builds the add-on homepage card. This is the function named by
 * addOns.sheets.homepageTrigger and it must return Card objects - an
 * alert or a spreadsheet menu cannot be rendered here.
 *
 * @param {Object=} e Homepage event object.
 * @return {Card[]} A single-element array holding the homepage card.
 */
function onHomepage(e) {
  const card = CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader()
        .setTitle('Kula Genealogy System')
        .setSubtitle('Knowledge-graph workspace')
    );

  const status = CardService.newCardSection().setHeader('Workspace');
  status.addWidget(CardService.newTextParagraph().setText(describeWorkspace_()));
  card.addSection(status);

  const setup = CardService.newCardSection().setHeader('Setup');
  setup.addWidget(
    CardService.newTextButton()
      .setText('Setup / reset workspace tabs')
      .setOnClickAction(CardService.newAction().setFunctionName('cardSetup'))
  );
  setup.addWidget(
    CardService.newTextButton()
      .setText('Generate $Config')
      .setOnClickAction(CardService.newAction().setFunctionName('cardGenerateConfig'))
  );
  setup.addWidget(
    CardService.newTextButton()
      .setText('Normalize references to PIDs')
      .setOnClickAction(CardService.newAction().setFunctionName('cardNormalizeReferences'))
  );
  setup.addWidget(
    CardService.newTextButton()
      .setText('Check sheet setup')
      .setOnClickAction(CardService.newAction().setFunctionName('cardCheckSetup'))
  );
  setup.addWidget(
    CardService.newTextButton()
      .setText('Validate references')
      .setOnClickAction(CardService.newAction().setFunctionName('cardValidateData'))
  );
  card.addSection(setup);

  const flatten = CardService.newCardSection().setHeader('Flatten knowledge graph');
  flatten.addWidget(
    CardService.newTextButton()
      .setText('All relationships')
      .setOnClickAction(CardService.newAction().setFunctionName('cardFlattenAll'))
  );
  flatten.addWidget(
    CardService.newTextButton()
      .setText('Parents only')
      .setOnClickAction(CardService.newAction().setFunctionName('cardFlattenParents'))
  );
  flatten.addWidget(
    CardService.newTextButton()
      .setText('Offsprings only')
      .setOnClickAction(CardService.newAction().setFunctionName('cardFlattenOffsprings'))
  );
  card.addSection(flatten);

  const numbering = CardService.newCardSection().setHeader('Person numbering');
  numbering.addWidget(
    CardService.newTextButton()
      .setText('Preview numbering tiers')
      .setOnClickAction(CardService.newAction().setFunctionName('cardPreviewRenumber'))
  );
  numbering.addWidget(
    CardService.newTextButton()
      .setText('Apply generational PIDs')
      .setOnClickAction(CardService.newAction().setFunctionName('cardApplyRenumber'))
  );
  card.addSection(numbering);

  return [card.build()];
}

/**
 * Summarises the active spreadsheet: its name and which tabs exist.
 *
 * @return {string} Plain-text status block for the homepage card.
 */
function describeWorkspace_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    return 'No spreadsheet is open. Open your Kula workbook, then reopen this add-on.';
  }

  const required = [CFG.INSTRUCTIONS, CFG.PERSONS, CFG.KG, CFG.VEDIC, CFG.STORIES];
  const missing = required.filter(name => !ss.getSheetByName(name));

  if (missing.length === 0) {
    return `Working on "${ss.getName()}".\nAll required tabs are present.`;
  }
  return `Working on "${ss.getName()}".\nMissing tabs: ${missing.join(', ')}.`;
}

/* --- Card callbacks ------------------------------------------------- */

/** @return {CardService.ActionResponse} Notification with setup result. */
function cardSetup() { return cardResponse_(setupDatabaseTabsCore_); }

/** @return {CardService.ActionResponse} Notification with $Config generation. */
function cardGenerateConfig() { return cardResponse_(generateConfigCore_); }

/** @return {CardService.ActionResponse} Notification with normalization result. */
function cardNormalizeReferences() { return cardResponse_(normalizeReferencesCore_); }

/** @return {CardService.ActionResponse} Notification with setup status. */
function cardCheckSetup() { return cardResponse_(checkSheetSetupCore_); }

/** @return {CardService.ActionResponse} Notification with validation result. */
function cardValidateData() { return cardResponse_(validateDataCore_); }

/** @return {CardService.ActionResponse} Notification with flatten result. */
function cardFlattenAll() { return cardResponse_(function () { return flattenGraphCore_('flatten-all'); }); }

/** @return {CardService.ActionResponse} Notification with flatten result. */
function cardFlattenParents() { return cardResponse_(function () { return flattenGraphCore_('flatten-parents'); }); }

/** @return {CardService.ActionResponse} Notification with flatten result. */
function cardFlattenOffsprings() { return cardResponse_(function () { return flattenGraphCore_('flatten-offsprings'); }); }

/** @return {CardService.ActionResponse} Notification with preview result. */
function cardPreviewRenumber() { return cardResponse_(function () { return renumberCore_(true); }); }

/** @return {CardService.ActionResponse} Notification with apply result. */
function cardApplyRenumber() { return cardResponse_(function () { return renumberCore_(false); }); }

/* ====================================================================
 * 2. AUTOMATED TAB INITIALIZER & INSTRUCTION CREATOR
 * ==================================================================== */

/**
 * Menu entry point for workspace setup.
 */
function setupDatabaseTabs() {
  alert_(setupDatabaseTabsCore_());
}

/**
 * Creates or verifies every tab the plugin needs, and writes the user
 * guide. Output is returned rather than alerted so both the menu and the
 * add-on card can display it.
 *
 * @return {string} Summary of what was created or verified.
 */
function setupDatabaseTabsCore_() {
  const ss = requireSpreadsheet_();

  // Instructions is generated, the rest come from the shared SCHEMA contract.
  const schemas = Object.assign({ [CFG.INSTRUCTIONS]: { isInstructions: true } }, SCHEMA);

  let createdCount = 0;

  Object.keys(schemas).forEach(sheetName => {
    let sheet = ss.getSheetByName(sheetName);
    const isNew = !sheet;

    if (isNew) {
      sheet = ss.insertSheet(sheetName);
      createdCount++;
    }

    if (schemas[sheetName].isInstructions) {
      // Only seed a new or empty Instructions tab. The live workbook already
      // carries a 1000-row guide, and setup must not wipe the user's copy.
      if (isNew || sheet.getLastRow() === 0) {
        populateInstructionsSheet_(sheet);
      }
    } else {
      // Setup Table Headers if empty or newly created
      if (sheet.getLastRow() === 0) {
        const headers = schemas[sheetName].headers;
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

        // Header Styling
        const headerRange = sheet.getRange(1, 1, 1, headers.length);
        headerRange.setFontWeight("bold")
                   .setBackground("#1c4587")
                   .setFontColor("#ffffff")
                   .setVerticalAlignment("middle");
        sheet.setFrozenRows(1);

        // Populate sample row for new tables
        if (schemas[sheetName].sample) {
          const sample = schemas[sheetName].sample;
          if (Array.isArray(sample[0])) {
            sheet.getRange(2, 1, sample.length, headers.length).setValues(sample);
          } else {
            sheet.getRange(2, 1, 1, headers.length).setValues([sample]);
          }
        }

        for (let col = 1; col <= headers.length; col++) {
          sheet.autoResizeColumn(col);
        }
      }
    }
  });

  const refs = applyLinkedFormulas_(ss);
  applyValidations_(ss);
  refreshPreviewColumns_(ss);

  let note = '';
  if (refs.repaired > 0) {
    note = ` ${refs.repaired} reference(s) in KG/Vedic/Stories were re-spelled ` +
           `to match the rebuilt REF_NAME, so no relationship was orphaned.`;
  } else if (refs.drifted > 0) {
    note = ` ${refs.drifted} stored REF_NAME value(s) differed from PID-KNOWN_NAME ` +
           `and were rebuilt; run 'Validate Reference Integrity' to check the edges.`;
  }

  return `Workspace initialized! Created/verified ${Object.keys(schemas).length} required tabs, ` +
         `with PID references, name previews and data validation applied.` + note;
}

/**
 * Menu entry point for generating the $Config tab.
 */
function generateConfig() {
  alert_(generateConfigCore_());
}

/**
 * Generates the $Config tab on demand and seeds it with one row per gotra
 * already recorded in the Vedic tab, so the reference list reflects the
 * family's actual data instead of a placeholder. An existing $Config is left
 * untouched rather than overwritten.
 *
 * @return {string} Summary of what was created, or why nothing changed.
 */
function generateConfigCore_() {
  const ss = requireSpreadsheet_();

  if (ss.getSheetByName(CFG.CONFIG)) {
    return `'${CFG.CONFIG}' already exists; left unchanged. Delete the tab first to regenerate.`;
  }

  const sheet = ss.insertSheet(CFG.CONFIG);

  const headerRange = sheet.getRange(1, 1, 1, CONFIG_HEADERS.length);
  headerRange.setValues([CONFIG_HEADERS]);
  headerRange.setFontWeight("bold")
             .setBackground("#1c4587")
             .setFontColor("#ffffff")
             .setVerticalAlignment("middle");
  sheet.setFrozenRows(1);

  const gotras = collectGotras_();

  if (gotras.length > 0) {
    sheet.getRange(2, 1, gotras.length, CONFIG_HEADERS.length)
         .setValues(gotras.map(gotra => {
           const row = new Array(CONFIG_HEADERS.length).fill("");
           row[0] = gotra;
           return row;
         }));
  }

  for (let col = 1; col <= CONFIG_HEADERS.length; col++) {
    sheet.autoResizeColumn(col);
  }

  return gotras.length > 0
    ? `Generated '${CFG.CONFIG}' with ${gotras.length} gotra(s) collected from the Vedic tab.`
    : `Generated '${CFG.CONFIG}' with headers only; add gotras as you enter Vedic data.`;
}

/**
 * Collects the distinct, case-insensitive GOTRA values recorded in Vedic,
 * preserving the spelling of the first occurrence.
 *
 * @return {string[]} Unique gotra names, in sheet order.
 */
function collectGotras_() {
  const ss = requireSpreadsheet_();
  const vedic = ss.getSheetByName(CFG.VEDIC);
  if (!vedic) return [];

  const lastCol = vedic.getLastColumn();
  if (!lastCol) return [];

  const rows = vedic.getDataRange().getValues();
  if (rows.length <= 1) return [];

  const gotraCol = columnOf_(rows[0], 'GOTRA') - 1;
  if (gotraCol < 0) return [];

  const seen = {};
  const gotras = [];
  for (let r = 1; r < rows.length; r++) {
    const value = String(rows[r][gotraCol] || '').trim();
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    gotras.push(value);
  }
  return gotras;
}

/* ====================================================================
 * 2b. REFERENCE NORMALIZATION (PID-ONLY STORAGE)
 * ==================================================================== */

/**
 * Menu entry point for normalization. Shows what would change and asks before
 * rewriting anything, because this touches every relationship cell.
 */
function normalizeReferences() {
  const ui = SpreadsheetApp.getUi();
  const preview = normalizeReferencesCore_(true);
  const answer = ui.alert('Normalize References', preview + '\n\nApply now?', ui.ButtonSet.YES_NO);
  if (answer === ui.Button.YES) {
    alert_(normalizeReferencesCore_(false));
  }
}

/**
 * Reduces every stored relationship reference to its bare PID and installs
 * the read-only name preview columns.
 *
 * The sheet keeps PIDs as the relational identity; names are rendered by
 * formula from the Persons roster, so a rename can never leave a stale name
 * half behind. Composite refs ("A001-John") and bare PIDs are both accepted on
 * input; only composites are rewritten. Ids that are not in Persons, such as
 * legacy "I0113" tags, are reported and left untouched.
 *
 * @param {boolean} dryRun When true, only counts what would change.
 * @return {string} Preview or result summary.
 */
function normalizeReferencesCore_(dryRun) {
  const ss = requireSpreadsheet_();
  const persons = ss.getSheetByName(CFG.PERSONS);
  if (!persons) throw new Error("Missing 'Persons' sheet. Run 'Plugin Setup' first.");

  const pData = persons.getDataRange().getValues();
  if (pData.length === 0) throw new Error("'Persons' has no header row.");

  const pidCol = columnOf_(pData[0], 'PID') - 1;
  if (pidCol < 0) throw new Error("Persons must have a PID column. Run 'Plugin Setup' first.");

  const knownPids = new Set();
  for (let r = 1; r < pData.length; r++) {
    const pid = String(pData[r][pidCol] || '').trim().toUpperCase();
    if (pid) knownPids.add(pid);
  }

  const changes = [];
  const unresolved = [];

  referenceTargets_(ss).forEach(target => {
    if (!target.sheet || target.cols.length === 0) return;

    const rows = target.sheet.getDataRange().getValues();
    if (rows.length === 0) return;

    const header = rows[0].map(v => String(v).trim());

    for (let r = 1; r < rows.length; r++) {
      target.cols.forEach(c => {
        if (c >= rows[r].length) return;

        const before = rows[r][c];
        const text = String(before === null || before === undefined ? '' : before).trim();
        if (!text) return;

        const result = normalizeRefText_(text, knownPids, target.split);
        if (result.text !== text) {
          changes.push({
            sheet: target.sheet,
            row: r + 1,
            col: c + 1,
            column: header[c] || columnLetter_(c + 1),
            before: text,
            after: result.text
          });
        }
        result.unresolved.forEach(id => {
          unresolved.push({ sheet: target.sheet, row: r + 1, id: id });
        });
      });
    }
  });

  if (dryRun) {
    return `Normalize preview\n\n` +
           `• ${changes.length} cell(s) would be reduced to bare PIDs\n` +
           `• ${unresolved.length} unknown id(s) would be left untouched\n` +
           `• name preview columns would be added or refreshed\n\n` +
           `Nothing was changed.`;
  }

  // Rewrite first: the captured column indexes are only valid before the
  // preview columns are inserted.
  changes.forEach(change => {
    change.sheet.getRange(change.row, change.col).setValue(change.after);
  });

  const added = ensurePreviewColumns_(ss);
  refreshPreviewColumns_(ss);
  writeRefactorReport_(ss, changes, unresolved);

  return `Normalized ${changes.length} reference cell(s) to bare PIDs. ` +
         `Added ${added} preview column(s) and refreshed the rest. ` +
         `${unresolved.length} unknown id(s) left untouched; see '${CFG.REFACTOR}'.`;
}

/**
 * Reduces one reference (or a separated list of them) to bare PIDs.
 *
 * @param {string} text Cell contents.
 * @param {Set<string>} knownPids Uppercased PIDs that exist in Persons.
 * @param {boolean} split When true, commas and semicolons separate entries.
 * @return {{text: string, unresolved: string[]}} Rewritten text, and entries
 *     that could not be resolved against Persons.
 */
function normalizeRefText_(text, knownPids, split) {
  const unresolved = [];
  let changed = false;

  const convert = token => {
    const trimmed = token.trim();
    if (!trimmed) return token;

    const m = trimmed.match(/^([A-Z]\d+)(?:-[\s\S]*)?$/i);
    if (!m) {
      unresolved.push(trimmed);
      return token;
    }

    const pid = m[1].toUpperCase();
    if (!knownPids.has(pid)) {
      unresolved.push(trimmed);
      return token;
    }

    if (trimmed === pid) return token;

    changed = true;
    return token.replace(trimmed, pid);
  };

  const next = split
    ? text.replace(/[^;,]+/g, convert)
    : convert(text);

  return { text: changed ? next : text, unresolved: unresolved };
}

/**
 * Writes the audit trail for a normalization run: every rewritten cell, plus
 * the ids that were left alone because Persons does not contain them.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet to write into.
 * @param {Array<Object>} changes Rewrites performed.
 * @param {Array<Object>} unresolved Ids that could not be resolved.
 */
function writeRefactorReport_(ss, changes, unresolved) {
  let sheet = ss.getSheetByName(CFG.REFACTOR);
  if (!sheet) {
    sheet = ss.insertSheet(CFG.REFACTOR);
  } else {
    sheet.clear();
  }

  const width = 5;
  const rows = [['TAB', 'ROW', 'COLUMN', 'BEFORE', 'AFTER']];

  changes.forEach(change => {
    rows.push([change.sheet.getName(), change.row, change.column, change.before, change.after]);
  });

  if (unresolved.length > 0) {
    rows.push([]);
    rows.push(['UNRESOLVED (left untouched)', '', '', '', '']);
    unresolved.forEach(item => {
      rows.push([item.sheet.getName(), item.row, '', item.id, 'not in Persons']);
    });
  }

  const padded = rows.map(row => {
    const out = row.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });

  sheet.getRange(1, 1, padded.length, width).setValues(padded);

  const header = sheet.getRange(1, 1, 1, width);
  header.setFontWeight('bold')
        .setBackground('#1c4587')
        .setFontColor('#ffffff')
        .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);

  for (let col = 1; col <= width; col++) {
    sheet.autoResizeColumn(col);
  }
}

/**
 * Adds the read-only name preview column beside each reference column, unless
 * it is already there.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet to modify.
 * @return {number} Number of preview columns added.
 */
function ensurePreviewColumns_(ss) {
  let added = 0;

  PREVIEWS.forEach(spec => {
    const sheet = ss.getSheetByName(spec.tab);
    if (!sheet) return;

    const lastCol = sheet.getLastColumn();
    if (!lastCol) return;

    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    if (columnOf_(header, spec.name) !== -1) return;

    const refCol = firstColumnOf_(header, [spec.ref].concat(spec.refAliases));
    if (refCol === -1) return;

    sheet.insertColumnAfter(refCol);
    sheet.getRange(1, refCol + 1)
      .setValue(spec.name)
      .setFontWeight('bold')
      .setBackground('#e8f0fe')
      .setFontColor('#1c4587')
      .setVerticalAlignment('middle');
    added++;
  });

  return added;
}

/**
 * Rewrites the preview formulas on every tab that has them. Safe to run on
 * every setup: the formulas are idempotent and blank rows render blank.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet to update.
 * @return {number} Number of preview columns refreshed.
 */
function refreshPreviewColumns_(ss) {
  const persons = ss.getSheetByName(CFG.PERSONS);
  if (!persons) return 0;

  const pLastCol = persons.getLastColumn();
  if (!pLastCol) return 0;

  const pHeader = persons.getRange(1, 1, 1, pLastCol).getValues()[0];
  const pidCol = columnOf_(pHeader, 'PID');
  const nameCol = columnOf_(pHeader, 'KNOWN_NAME');
  if (pidCol === -1 || nameCol === -1) return 0;

  const source = `'${CFG.PERSONS}'!$${columnLetter_(pidCol)}:$${columnLetter_(nameCol)}`;
  let refreshed = 0;

  PREVIEWS.forEach(spec => {
    const sheet = ss.getSheetByName(spec.tab);
    if (!sheet) return;

    const lastCol = sheet.getLastColumn();
    if (!lastCol) return;

    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const refCol = firstColumnOf_(header, [spec.ref].concat(spec.refAliases));
    const previewCol = columnOf_(header, spec.name);
    if (refCol === -1 || previewCol === -1) return;

    const refLetter = columnLetter_(refCol);
    const coverage = setupCoverage_(sheet);
    const formulas = [];
    for (let r = 2; r <= coverage; r++) {
      formulas.push([previewFormula_(refLetter, r, source, spec.list)]);
    }
    sheet.getRange(2, previewCol, coverage - 1, 1).setFormulas(formulas);
    refreshed++;
  });

  return refreshed;
}

/**
 * Builds the preview formula for one row.
 *
 * @param {string} refLetter Column letter of the stored reference.
 * @param {number} row Sheet row the formula sits on.
 * @param {string} source Absolute PID/KNOWN_NAME range, e.g. 'Persons'!$A:$B.
 * @param {boolean} list Whether the reference column can hold several entries.
 * @return {string} An A1 formula.
 */
function previewFormula_(refLetter, row, source, list) {
  const ref = `$${refLetter}${row}`;
  if (!list) {
    return `=IF(${ref}="","",IFERROR(VLOOKUP(${ref},${source},2,FALSE),"?"))`;
  }

  return `=IF(${ref}="","",TEXTJOIN(", ",TRUE,MAP(` +
         `SPLIT(REGEXREPLACE(${ref},";",","),",",TRUE,TRUE),` +
         `LAMBDA(id,IFERROR(VLOOKUP(id,${source},2,FALSE),"?")))))`;
}

/**
 * Populates clean Markdown-styled instructions into the 'Instructions' tab.
 *
 * @param {SpreadsheetApp.Sheet} sheet The Instructions sheet to rewrite.
 */
function populateInstructionsSheet_(sheet) {
  sheet.clear();
  sheet.setHiddenGridlines(false);

  const instructionsContent = [
    ["🌳 KULA GENEALOGY SYSTEM — USER GUIDE"],
    ["Welcome to the Kula Genealogy Knowledge Graph plugin! This system turns your family database into an inferred relational graph."],
    [""],
    ["📌 CORE TABS (CREATED BY SETUP)"],
    ["1. Persons", "Core individual metadata: PID, names, contact, gender, birth, death, places, generation."],
    ["2. KG (Knowledge Graph)", "The single edge repository: SUBJECT | SUBJECT_NAME | PREDICATE | OBJECT | OBJECT_NAME | DATE | NOTES."],
    ["3. Vedic", "Per-person lineage: PERSON, PERSON_NAME, gotra, veda, shakha, sutra, nakshatra, kula devatha, sampradaya, acharya thirumaligai, purvikam."],
    ["4. Stories", "Narratives and notes. TAGGED_PEOPLE links a note to one or more people; TAGGED_NAMES shows the names."],
    [""],
    ["📦 GENERATED TABS (MENU OPTIONS)"],
    ["• $Config", "Gotra defaults, generated from the GOTRA values already in the Vedic tab."],
    ["• KG_FLAT", "Flattened graph triples, written by the flattener. Do not edit."],
    ["• Renumber_Report", "Audit of the last numbering run. Do not edit."],
    [""],
    ["🕸️ HOW TO WRITE RELATIONSHIPS IN 'KG'"],
    ["Define simple direct edges in the 'KG' tab instead of a separate relationship table:"],
    [""],
    ["  SUBJECT", "PREDICATE", "OBJECT"],
    ["  A001", "spouseOf", "A002"],
    ["  A002", "parentOf", "B001"],
    [""],
    ["💡 KEY FEATURES & INFERENCES"],
    ["• Automatic Co-Parenting", "If A001 spouseOf A002, and A002 parentOf B001, the system infers A001 parentOf B001."],
    ["• Bidirectional Links", "Running 'Flatten All' generates reciprocal spouseOf edges and reverse childOf edges."],
    ["• Generational PIDs", "Running 'Person Numbering > Apply Generational PIDs' assigns Axxx, Bxxx, Cxxx by distance from the patriarch."],
    ["• Derived REF_NAME", "REF_NAME is a formula, PID and KNOWN_NAME joined by a hyphen. Never type into it."],
    ["• PID-only relationships", "KG, Vedic and Stories store bare PIDs. SUBJECT_NAME, OBJECT_NAME, PERSON_NAME and TAGGED_NAMES are read-only formulas that render the names."],
    ["• Older composite refs", "Cells like 'A001-John' still resolve, but they can go stale. Use 'Normalize References (PID only)' to strip them to PIDs and refresh the previews."],
    [""],
    ["⚙️ QUICK START MENU COMMANDS"],
    ["• Setup / Reset Workspace Tabs", "Creates the five core tabs, REF_NAME formulas and dropdowns."],
    ["• Generate $Config", "Builds the gotra reference tab from the Vedic data."],
    ["• Normalize References (PID only)", "Strips 'PID-KNOWN_NAME' relationship cells down to bare PIDs and adds name-preview columns."],
    ["• Flatten Knowledge Graph", "Compiles graph edges into the 'KG_FLAT' tab."],
    ["• Person Numbering", "Previews or applies generational renumbering and rewrites every reference."],
    ["• Validate Reference Integrity", "Reports orphan references, duplicate PIDs, unknown predicates and stale composite references."]
  ];

  // Pad every row to three columns so the triple example keeps its
  // Object column instead of being truncated to Subject + Predicate.
  sheet.getRange(1, 1, instructionsContent.length, 3).setValues(
    instructionsContent.map(row => [row[0] || "", row[1] || "", row[2] || ""])
  );

  // Styling Instructions Tab
  sheet.getRange("A1:B1").merge().setFontWeight("bold").setFontSize(14).setBackground("#1c4587").setFontColor("#ffffff");
  sheet.getRange("A4:B4").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A10:B10").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A15:B15").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A18:C18").setFontWeight("bold").setBackground("#d9ead3");
  sheet.getRange("A21:B21").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A29:B29").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");

  sheet.autoResizeColumn(1);
  sheet.autoResizeColumn(2);
  sheet.autoResizeColumn(3);
}

/* ====================================================================
 * 2b. DERIVED COLUMNS AND DATA VALIDATION
 * ==================================================================== */

/** Number of rows the setup formulas and validations cover. */
const SETUP_ROWS = 1000;

/**
 * Converts a 1-based column index into a spreadsheet column letter.
 *
 * @param {number} index 1-based column number.
 * @return {string} Column letter, for example 1 -> "A", 27 -> "AA".
 */
function columnLetter_(index) {
  let n = index;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/**
 * Finds a column by header name, case-insensitively.
 *
 * @param {string[]} header Header row values.
 * @param {string} name Header to look for.
 * @return {number} 1-based column index, or -1 when absent.
 */
function columnOf_(header, name) {
  const wanted = name.toLowerCase();
  for (let i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toLowerCase() === wanted) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Finds the first column matching any of several acceptable header names,
 * so a tab written by an older version of the plugin still resolves.
 *
 * @param {string[]} header Header row values.
 * @param {string[]} names Acceptable headers, preferred spelling first.
 * @return {number} 1-based column index, or -1 when none are present.
 */
function firstColumnOf_(header, names) {
  for (let i = 0; i < names.length; i++) {
    const col = columnOf_(header, names[i]);
    if (col !== -1) return col;
  }
  return -1;
}

/**
 * Number of rows setup should cover on a sheet: at least the default, and
 * never fewer than the rows the sheet already uses. Without this, a roster
 * longer than SETUP_ROWS would leave its last people without an REF_NAME
 * formula or any dropdown.
 *
 * @param {SpreadsheetApp.Sheet} sheet Sheet being covered.
 * @return {number} Row count to write through.
 */
function setupCoverage_(sheet) {
  return Math.max(SETUP_ROWS, sheet.getLastRow());
}

/**
 * Makes REF_NAME a formula rather than a typed field, so it can never drift
 * out of sync with PID or KNOWN_NAME. This is what makes generational
 * renumbering safe: the reference text follows the PID automatically.
 *
 * Rows whose stored REF_NAME differed from `PID-KNOWN_NAME` are counted. Where
 * the difference is only spacing around the hyphen, the matching references
 * in KG, Vedic and Stories are re-spelled too, so the rewrite cannot orphan a
 * relationship that was previously valid.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet being set up.
 * @return {{drifted: number, repaired: number}} How many stored refs differed
 *     and how many reference cells in other tabs were re-spelled.
 */
function applyLinkedFormulas_(ss) {
  const persons = ss.getSheetByName(CFG.PERSONS);
  if (!persons) return { drifted: 0, repaired: 0 };

  const lastCol = persons.getLastColumn();
  if (!lastCol) return { drifted: 0, repaired: 0 };

  const header = persons.getRange(1, 1, 1, lastCol).getValues()[0];
  const pidCol = columnOf_(header, 'PID');
  const nameCol = columnOf_(header, 'KNOWN_NAME');
  const refCol = columnOf_(header, 'REF_NAME');
  if (pidCol === -1 || nameCol === -1 || refCol === -1) return { drifted: 0, repaired: 0 };

  const pidRef = columnLetter_(pidCol);
  const nameRef = columnLetter_(nameCol);

  // Inspect the stored refs before overwriting them, so spacing-only drift can
  // be propagated to the tabs that reference people by that exact string.
  const stored = persons.getRange(2, 1, setupCoverage_(persons) - 1, lastCol).getValues();
  const respellings = {};
  let drifted = 0;

  stored.forEach(row => {
    const pid = String(row[pidCol - 1] || '').trim();
    const known = String(row[nameCol - 1] || '').trim();
    const old = String(row[refCol - 1] || '').trim();
    if (!pid || !known || !old) return;

    const canonical = `${pid}-${known}`;
    if (old === canonical) return;

    drifted++;
    if (old.replace(/\s*-\s*/, '-') === canonical) {
      respellings[old.toUpperCase()] = canonical;
    }
  });

  const coverage = setupCoverage_(persons);
  const formulas = [];
  for (let r = 2; r <= coverage; r++) {
    formulas.push([`=IF(OR($${pidRef}${r}="",$${nameRef}${r}=""),"",$${pidRef}${r}&"-"&$${nameRef}${r})`]);
  }
  persons.getRange(2, refCol, coverage - 1, 1).setFormulas(formulas);

  const repaired = repairReferenceSpelling_(ss, respellings);
  return { drifted, repaired };
}

/**
 * Rewrites exact reference strings across every tab that names a person,
 * leaving comma-separated tag lists intact.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet being repaired.
 * @param {Object<string,string>} replacements Uppercased old ref -> new ref.
 * @return {number} Number of cells changed.
 */
function repairReferenceSpelling_(ss, replacements) {
  if (!replacements || Object.keys(replacements).length === 0) return 0;

  let repaired = 0;
  referenceTargets_(ss).forEach(target => {
    if (!target.sheet || target.cols.length === 0) return;

    const data = target.sheet.getDataRange().getValues();
    const edits = [];

    for (let r = 1; r < data.length; r++) {
      target.cols.forEach(c => {
        if (c >= data[r].length) return;
        const before = data[r][c];
        const after = target.split
          ? remapExactList_(before, replacements)
          : remapExact_(before, replacements);
        if (after !== before) {
          edits.push({ row: r + 1, col: c + 1, value: after });
          repaired++;
        }
      });
    }

    edits.forEach(edit => {
      target.sheet.getRange(edit.row, edit.col).setValue(edit.value);
    });
  });

  return repaired;
}

/**
 * Replaces a whole-cell reference when it matches, preserving the original
 * value when it does not.
 *
 * @param {*} value Cell value.
 * @param {Object<string,string>} lookup Uppercased old ref -> new ref.
 * @return {*} The replacement, or the original value.
 */
function remapExact_(value, lookup) {
  if (value === null || value === undefined) return value;
  const key = String(value).trim().toUpperCase();
  const next = lookup[key];
  return next === undefined ? value : next;
}

/**
 * Replaces references inside a comma- or semicolon-separated list, preserving
 * the cell's separators and spacing. Returns the original value when no entry
 * matches, so untouched cells are never reformatted.
 *
 * @param {*} value Cell value, possibly a list.
 * @param {Object<string,string>} lookup Uppercased old ref -> new ref.
 * @return {*} The rewritten list, or the original value.
 */
function remapExactList_(value, lookup) {
  if (value === null || value === undefined) return value;
  const text = String(value).trim();
  if (!text) return value;
  if (!/[;,]/.test(text)) return remapExact_(value, lookup);

  const next = text.replace(/[^;,]+/g, token => {
    const trimmed = token.trim();
    const hit = lookup[trimmed.toUpperCase()];
    return hit === undefined ? token : token.replace(trimmed, hit);
  });

  return next === text ? value : next;
}

/**
 * Applies dropdowns to the columns where a typo would silently break a
 * relationship: the KG predicate, and every cell that must name a person.
 * Person pickers allow free text so half-entered rows are not blocked; the
 * predicate list is strict because an unknown predicate is simply ignored.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet being set up.
 */
function applyValidations_(ss) {
  const persons = ss.getSheetByName(CFG.PERSONS);
  const kg = ss.getSheetByName(CFG.KG);
  if (!persons) return;

  const header = persons.getRange(1, 1, 1, persons.getLastColumn() || 10).getValues()[0];
  const pidCol = columnOf_(header, 'PID');

  const pidRange = pidCol === -1 ? null : persons.getRange(2, pidCol, setupCoverage_(persons) - 1, 1);

  if (kg) {
    const kgHeader = kg.getRange(1, 1, 1, kg.getLastColumn() || 3).getValues()[0];
    const kgRows = setupCoverage_(kg) - 1;
    const subCol = firstColumnOf_(kgHeader, ['SUBJECT', 'Subject (Node 1)']);
    const relCol = firstColumnOf_(kgHeader, ['PREDICATE', 'Predicate']);
    const objCol = firstColumnOf_(kgHeader, ['OBJECT', 'Object (Node 2)']);

    if (pidRange) {
      const refRule = SpreadsheetApp.newDataValidation()
        .requireValueInRange(pidRange, true)
        .setAllowInvalid(true)
        .setHelpText('Pick a PID from the Persons tab.')
        .build();
      if (subCol !== -1) kg.getRange(2, subCol, kgRows, 1).setDataValidation(refRule);
      if (objCol !== -1) kg.getRange(2, objCol, kgRows, 1).setDataValidation(refRule);
    }

    if (relCol !== -1) {
      const predicateRule = SpreadsheetApp.newDataValidation()
        .requireValueInList(PREDICATES, true)
        .setAllowInvalid(false)
        .setHelpText('Use one of: ' + PREDICATES.join(', '))
        .build();
      kg.getRange(2, relCol, kgRows, 1).setDataValidation(predicateRule);
    }
  }

  // Person-referencing columns in the other tabs hold bare PIDs.
  if (pidRange) {
    const personColumns = [
      { tab: CFG.VEDIC, header: 'PERSON' },
      { tab: CFG.STORIES, header: 'TAGGED_PEOPLE' }
    ];

    personColumns.forEach(target => {
      const sheet = ss.getSheetByName(target.tab);
      if (!sheet) return;

      const header = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0];
      const col = columnOf_(header, target.header);
      if (col === -1) return;

      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInRange(pidRange, true)
        .setAllowInvalid(true)
        .setHelpText(`Pick a PID from the Persons tab.`)
        .build();
      sheet.getRange(2, col, setupCoverage_(sheet) - 1, 1).setDataValidation(rule);
    });
  }
}

/* ====================================================================
 * 3. KNOWLEDGE GRAPH FLATTENER (CANONICAL PREDICATES)
 * ==================================================================== */

/** Menu entry point: flatten every relationship type. */
function runFlattenAll() {
  alert_(flattenGraphCore_("flatten-all"));
}

/** Menu entry point: emit parentOf edges only. */
function runFlattenParents() {
  alert_(flattenGraphCore_("flatten-parents"));
}

/** Menu entry point: emit childOf edges only. */
function runFlattenOffsprings() {
  alert_(flattenGraphCore_("flatten-offsprings"));
}

/**
 * Reads the KG tab, infers co-parenting through spouses, and writes
 * canonical triples into KG_FLAT.
 *
 * @param {string} mode One of "flatten-all", "flatten-parents",
 *     "flatten-offsprings".
 * @return {string} Summary including how many triples were generated.
 * @throws {Error} If the KG tab is missing or empty.
 */
function flattenGraphCore_(mode) {
  mode = (mode || "flatten-all").toLowerCase().trim();
  const ss = requireSpreadsheet_();
  const graphSheet = ss.getSheetByName(CFG.KG);

  if (!graphSheet) {
    throw new Error(`Sheet '${CFG.KG}' not found. Run 'Plugin Setup' first.`);
  }

  const graphData = graphSheet.getDataRange().getValues();
  if (graphData.length === 0) {
    throw new Error(`'${CFG.KG}' sheet is empty.`);
  }

  const gHeaders = graphData[0].map(h => String(h).toLowerCase().trim());
  let relCol = gHeaders.findIndex(x => x === "predicate" || x === "relationship" || x === "rel" || x === "edge");
  let subCol = gHeaders.findIndex(x => x === "subject" || x === "node 1" || x === "node1" || x === "ref_name" || x === "p1" || x === "from");
  let objCol = gHeaders.findIndex(x => x === "object" || x === "node 2" || x === "node2" || x === "ref_name_2" || x === "p2" || x === "to");

  if (subCol === -1) subCol = 0;
  if (relCol === -1) relCol = 1;
  if (objCol === -1) objCol = 2;

  let startRow = 0;
  if (gHeaders.includes("subject") || gHeaders.includes("predicate") || gHeaders.includes("relationship") || gHeaders.includes("ref_name") || gHeaders.includes("node 1")) {
    startRow = 1;
  }

  const spouseMap = {};
  const childrenMap = {};
  const parentMap = {};

  for (let i = startRow; i < graphData.length; i++) {
    const row = graphData[i];
    const sub = String(row[subCol] || "").trim();
    const rel = String(row[relCol] || "").trim();
    const obj = String(row[objCol] || "").trim();

    if (!sub || !rel || !obj) continue;
    const rLower = rel.toLowerCase();

    if (rLower.includes("spouse") || rLower.includes("husband") || rLower.includes("wife") || rLower.includes("married")) {
      if (!spouseMap[sub]) spouseMap[sub] = new Set();
      if (!spouseMap[obj]) spouseMap[obj] = new Set();
      spouseMap[sub].add(obj);
      spouseMap[obj].add(sub);
    }

    if (rLower.includes("parent") || rLower.includes("mother") || rLower.includes("father")) {
      if (!childrenMap[sub]) childrenMap[sub] = new Set();
      childrenMap[sub].add(obj);

      if (!parentMap[obj]) parentMap[obj] = new Set();
      parentMap[obj].add(sub);
    }

    // childOf is the mirror of parentOf: the subject is the child, so the
    // edge has to be recorded against the object as the parent.
    if (rLower.includes("child") || rLower.includes("son") || rLower.includes("daughter")) {
      if (!childrenMap[obj]) childrenMap[obj] = new Set();
      childrenMap[obj].add(sub);

      if (!parentMap[sub]) parentMap[sub] = new Set();
      parentMap[sub].add(obj);
    }
  }

  // Infer Co-Parenting via Spouse
  Object.keys(spouseMap).forEach(p1 => {
    spouseMap[p1].forEach(sp => {
      if (childrenMap[sp]) {
        childrenMap[sp].forEach(child => {
          if (!childrenMap[p1]) childrenMap[p1] = new Set();
          childrenMap[p1].add(child);

          if (!parentMap[child]) parentMap[child] = new Set();
          parentMap[child].add(p1);
        });
      }
    });
  });

  const outputRows = [];
  const seenKeys = new Set();

  function addTriple(subRef, predicate, objRef) {
    if (!subRef || !predicate || !objRef) return;
    const key = `${subRef.trim().toUpperCase()}||${predicate.trim().toLowerCase()}||${objRef.trim().toUpperCase()}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      outputRows.push([subRef, predicate, objRef]);
    }
  }

  if (mode === "flatten-all") {
    Object.keys(spouseMap).forEach(p1 => {
      spouseMap[p1].forEach(sp => addTriple(p1, "spouseOf", sp));
    });
    Object.keys(childrenMap).forEach(parent => {
      childrenMap[parent].forEach(child => addTriple(parent, "parentOf", child));
    });
    Object.keys(parentMap).forEach(child => {
      parentMap[child].forEach(parent => addTriple(child, "childOf", parent));
    });
  } else if (mode === "flatten-parents") {
    Object.keys(childrenMap).forEach(parent => {
      childrenMap[parent].forEach(child => addTriple(parent, "parentOf", child));
    });
  } else if (mode === "flatten-offsprings") {
    Object.keys(parentMap).forEach(child => {
      parentMap[child].forEach(parent => addTriple(child, "childOf", parent));
    });
  }

  let outSheet = ss.getSheetByName(CFG.FLATGRAPH);
  if (!outSheet) {
    outSheet = ss.insertSheet(CFG.FLATGRAPH);
  } else {
    outSheet.clear();
  }

  const headerRow = ["Subject (Node 1)", `Predicate (${mode})`, "Object (Node 2)"];
  const finalGrid = [headerRow, ...outputRows];

  outSheet.getRange(1, 1, finalGrid.length, 3).setValues(finalGrid);

  const headerRange = outSheet.getRange(1, 1, 1, 3);
  headerRange.setFontWeight("bold").setBackground("#1c4587").setFontColor("#ffffff");
  outSheet.setFrozenRows(1);
  outSheet.autoResizeColumn(1);
  outSheet.autoResizeColumn(2);
  outSheet.autoResizeColumn(3);

  return `Flattening complete! Mode: '${mode}'. Generated ${outputRows.length} canonical graph triples.`;
}

/* ====================================================================
 * 4. GENERATIONAL RENUMBERING (BFS GRAPH-TRAVERSAL)
 * ==================================================================== */

/** Menu entry point: preview tiers without writing. */
function previewRenumber() {
  alert_(renumberCore_(true));
}

/** Menu entry point: confirm, then write new PIDs. */
function applyRenumber() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Apply Renumbering?',
    'This assigns new generational PIDs (A001, B001, C001...) in the Persons tab.\n\n' +
    'IMPORTANT: references inside KG, Vedic and Stories are NOT rewritten, ' +
    'so those tabs will keep pointing at the old PIDs after this runs.\n\n' +
    'Continue?',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) {
    return;
  }

  try {
    alert_(renumberCore_(false));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    Logger.log('Renumber failed: ' + msg);
    alert_('Renumbering stopped:\n\n' + msg);
  }
}

/**
 * Computes generational tiers from the KG and optionally writes the new
 * PIDs into the Persons tab.
 *
 * @param {boolean} dryRun When true, nothing is written.
 * @return {string} Summary of tiers and members processed.
 * @throws {Error} If Persons or KG is missing, or Persons has no data.
 */
function renumberCore_(dryRun) {
  const ss = requireSpreadsheet_();
  const pSheet = ss.getSheetByName(CFG.PERSONS);
  const kgSheet = ss.getSheetByName(CFG.KG);

  if (!pSheet || !kgSheet) throw new Error("Missing 'Persons' or 'KG' sheet. Run 'Plugin Setup' first.");

  const pData = pSheet.getDataRange().getValues();
  const kgData = kgSheet.getDataRange().getValues();

  if (pData.length <= 1) throw new Error("'Persons' sheet has no data rows.");

  const pHeaders = pData[0];
  const pPidCol = columnOf_(pHeaders, 'PID') - 1;
  const pNameCol = columnOf_(pHeaders, 'KNOWN_NAME') - 1;
  const pNotesCol = columnOf_(pHeaders, 'NOTES') - 1;
  if (pPidCol < 0) {
    throw new Error("Persons must have a PID column. Run 'Plugin Setup' first.");
  }

  // KG columns are resolved by header, never by position: the read-only
  // SUBJECT_NAME/OBJECT_NAME preview columns sit between the data columns, so
  // indexes 0/1/2 are only correct until the first normalization.
  const kgHeader = kgData.length ? kgData[0] : [];
  const kSubCol = firstColumnOf_(kgHeader, ['SUBJECT', 'Subject (Node 1)']) - 1;
  const kRelCol = firstColumnOf_(kgHeader, ['PREDICATE', 'Predicate']) - 1;
  const kObjCol = firstColumnOf_(kgHeader, ['OBJECT', 'Object (Node 2)']) - 1;
  if (kSubCol < 0 || kRelCol < 0 || kObjCol < 0) {
    throw new Error("KG must have SUBJECT, PREDICATE and OBJECT columns. Run 'Plugin Setup' first.");
  }

  const persons = [];
  let headPid = null;

  for (let i = 1; i < pData.length; i++) {
    const row = pData[i];
    const pid = String(row[pPidCol] || "").trim();
    if (!pid) continue;
    const known = String(row[pNameCol] || pid).trim();
    const notes = pNotesCol !== -1 ? String(row[pNotesCol] || "").trim() : "";

    const obj = { pid, known, notes, rowIdx: i + 1 };
    persons.push(obj);

    if (!headPid && (/patriarch/i.test(notes) || /head/i.test(notes))) {
      headPid = pid;
    }
  }

  if (!headPid && persons.length > 0) headPid = persons[0].pid;

  const parentGraph = {};
  const spouseGraph = {};

  function extractPid(str) {
    // match() returns an array or null; read the captured group, not the array.
    const m = String(str).match(/([A-Z]\d+)/i);
    return m ? m[1].toUpperCase() : String(str).trim().toUpperCase();
  }

  for (let i = 1; i < kgData.length; i++) {
    const sub = extractPid(kgData[i][kSubCol]);
    const rel = String(kgData[i][kRelCol] || "").toLowerCase().trim();
    const obj = extractPid(kgData[i][kObjCol]);

    if (!sub || !rel || !obj) continue;

    if (rel.includes("parent") || rel.includes("father") || rel.includes("mother")) {
      if (!parentGraph[sub]) parentGraph[sub] = new Set();
      parentGraph[sub].add(obj);
    } else if (rel.includes("childof") || rel.includes("child_of") ||
               rel.includes("offspring") || rel.includes("son of") || rel.includes("daughter of")) {
      // Reversed edge: the child is the subject, so obj is the parent.
      if (!parentGraph[obj]) parentGraph[obj] = new Set();
      parentGraph[obj].add(sub);
    } else if (rel.includes("spouse") || rel.includes("husband") || rel.includes("wife")) {
      if (!spouseGraph[sub]) spouseGraph[sub] = new Set();
      if (!spouseGraph[obj]) spouseGraph[obj] = new Set();
      spouseGraph[sub].add(obj);
      spouseGraph[obj].add(sub);
    }
  }

  const genLevel = new Map();
  const queue = [{ pid: headPid, level: 0 }];
  genLevel.set(headPid, 0);

  if (spouseGraph[headPid]) {
    spouseGraph[headPid].forEach(sp => {
      genLevel.set(sp, 0);
      queue.push({ pid: sp, level: 0 });
    });
  }

  while (queue.length > 0) {
    const curr = queue.shift();
    const currLvl = curr.level;

    if (parentGraph[curr.pid]) {
      parentGraph[curr.pid].forEach(childPid => {
        if (!genLevel.has(childPid)) {
          genLevel.set(childPid, currLvl + 1);
          queue.push({ pid: childPid, level: currLvl + 1 });

          if (spouseGraph[childPid]) {
            spouseGraph[childPid].forEach(sp => {
              if (!genLevel.has(sp)) {
                genLevel.set(sp, currLvl + 1);
                queue.push({ pid: sp, level: currLvl + 1 });
              }
            });
          }
        }
      });
    }
  }

  function genLetter(level) {
    return String.fromCharCode(65 + level);
  }

  const newPidMap = new Map();
  const pidLookup = {};
  const nameLookup = {};
  const counters = {};

  persons.forEach(p => {
    const lvl = genLevel.has(p.pid) ? genLevel.get(p.pid) : null;
    const prefix = lvl !== null ? genLetter(lvl) : "Z";

    if (!counters[prefix]) counters[prefix] = 1;
    const newId = `${prefix}${String(counters[prefix]++).padStart(3, "0")}`;
    newPidMap.set(p.pid, newId);
    pidLookup[String(p.pid).toUpperCase()] = newId;
    nameLookup[String(p.pid).toUpperCase()] = p.known;
  });

  // Stories can tag several people in one cell, so that column is treated as
  // a list; the others hold a single reference.
  const refTargets = referenceTargets_(ss);

  if (dryRun) {
    let pending = 0;
    refTargets.forEach(target => {
      pending += rewritePidRefs_(target.sheet, target.cols, pidLookup, false, target.split, nameLookup);
    });
    return `Preview Complete! ${persons.length} members across ` +
           `${Object.keys(counters).length} generational tiers. ` +
           `${pending} references in KG/Vedic/Stories would be rewritten. Nothing was changed.`;
  }

  for (let i = 0; i < persons.length; i++) {
    const p = persons[i];
    const newId = newPidMap.get(p.pid);
    pSheet.getRange(p.rowIdx, pPidCol + 1).setValue(newId);
  }

  let rewritten = 0;
  refTargets.forEach(target => {
    rewritten += rewritePidRefs_(target.sheet, target.cols, pidLookup, true, target.split, nameLookup);
  });

  writeRenumberReport_(ss, persons, newPidMap, rewritten);

  return `Renumbering Applied Successfully! ${persons.length} members renumbered ` +
         `and ${rewritten} references rewritten across KG, Vedic and Stories. ` +
         `Full old-to-new list is in the '${CFG.REPORT}' tab.`;
}

/**
 * Locates the person-reference columns on every tab that stores one.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet to inspect.
 * @return {Array<{sheet: SpreadsheetApp.Sheet|null, cols: number[], split: boolean}>}
 *     Targets in KG, Vedic, Stories order; `split` marks a comma-list column.
 */
function referenceTargets_(ss) {
  const kgSheet = ss.getSheetByName(CFG.KG);
  const vedicSheet = ss.getSheetByName(CFG.VEDIC);
  const storiesSheet = ss.getSheetByName(CFG.STORIES);

  return [
    {
      sheet: kgSheet,
      cols: refColumnIndexes_(kgSheet, [['SUBJECT', 'Subject (Node 1)'], ['OBJECT', 'Object (Node 2)']]),
      split: false
    },
    {
      sheet: vedicSheet,
      cols: refColumnIndexes_(vedicSheet, [['PERSON']]),
      split: false
    },
    {
      sheet: storiesSheet,
      cols: refColumnIndexes_(storiesSheet, [['TAGGED_PEOPLE']]),
      split: true
    }
  ];
}

/**
 * Resolves reference columns by header, accepting alternative spellings for
 * each one.
 *
 * @param {SpreadsheetApp.Sheet|null} sheet Sheet to inspect.
 * @param {string[][]} headerNames Acceptable header spellings, one array per
 *     column to locate (preferred spelling first).
 * @return {number[]} Zero-based indexes of the columns that exist.
 */
function refColumnIndexes_(sheet, headerNames) {
  if (!sheet) return [];
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return [];

  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return headerNames
    .map(names => firstColumnOf_(header, names) - 1)
    .filter(index => index >= 0);
}

/**
 * Rewrites PID-prefixed references in place. Handles both bare PIDs
 * ("A001") and composite refs ("A001-Venkiteswara Iyer"), preserving the
 * suffix so display names survive the change.
 *
 * @param {SpreadsheetApp.Sheet|null} sheet Sheet to scan; null is skipped.
 * @param {number[]} colIdxs Zero-based columns that may hold references.
 * @param {Object<string,string>} lookup Uppercased old PID -> new PID.
 * @param {boolean} apply When false, only counts the changes.
 * @param {boolean} splitList When true, the cell may hold a comma- or
 *     semicolon-separated list of references and each entry is remapped.
 * @param {Object<string,string>=} names Uppercased old PID -> current
 *     KNOWN_NAME, used to refresh the readable half of a full reference.
 * @return {number} Number of cells whose value would change.
 */
function rewritePidRefs_(sheet, colIdxs, lookup, apply, splitList, names) {
  if (!sheet || !colIdxs || colIdxs.length === 0) return 0;

  const range = sheet.getDataRange();
  const data = range.getValues();
  if (data.length <= 1) return 0;

  // Only the cells that actually change are written. Writing the whole data
  // range back would flatten every formula in those rows - including the
  // read-only name preview columns - into its last computed value.
  const edits = [];

  for (let r = 1; r < data.length; r++) {
    colIdxs.forEach(c => {
      if (c >= data[r].length) return;
      const before = data[r][c];
      const after = splitList
        ? remapRefList_(before, lookup, names)
        : remapRef_(before, lookup, names);
      if (after !== before) {
        edits.push({ row: r + 1, col: c + 1, value: after });
      }
    });
  }

  if (apply) {
    edits.forEach(edit => {
      sheet.getRange(edit.row, edit.col).setValue(edit.value);
    });
  }

  return edits.length;
}

/**
 * Maps one reference through the PID lookup. A bare PID stays bare; a full
 * "PID-KNOWN_NAME" reference keeps its readable half, refreshed from the
 * current roster so a renamed person does not leave a stale suffix behind.
 *
 * @param {*} value Cell value; anything non-string is returned untouched.
 * @param {Object<string,string>} lookup Uppercased old PID -> new PID.
 * @param {Object<string,string>=} names Uppercased old PID -> KNOWN_NAME.
 * @return {*} The rewritten reference, or the original value unchanged.
 */
function remapRef_(value, lookup, names) {
  if (value === null || value === undefined) return value;

  const text = String(value).trim();
  if (!text) return value;

  const m = text.match(/^([A-Z]\d+)(-[\s\S]*)?$/i);
  if (!m) return value;

  const key = m[1].toUpperCase();
  const next = lookup[key];
  if (!next) return value;

  if (m[2] && names && names[key]) {
    return `${next}-${names[key]}`;
  }

  return next + (m[2] || '');
}

/**
 * Remaps a reference list, such as a Stories row that tags several people.
 * Both commas and semicolons separate entries; the cell's own separators and
 * spacing are preserved, and entries that are not references are left alone.
 *
 * @param {*} value Cell value, possibly a list.
 * @param {Object<string,string>} lookup Uppercased old PID -> new PID.
 * @param {Object<string,string>=} names Uppercased old PID -> KNOWN_NAME.
 * @return {*} The rewritten list, or the original value unchanged.
 */
function remapRefList_(value, lookup, names) {
  if (value === null || value === undefined) return value;

  const text = String(value).trim();
  if (!text) return value;
  if (!/[;,]/.test(text)) return remapRef_(value, lookup, names);

  return text.replace(/[^;,]+/g, token => {
    const trimmed = token.trim();
    const next = remapRef_(trimmed, lookup, names);
    return next === trimmed ? token : token.replace(trimmed, String(next));
  });
}

/**
 * Writes the old-to-new PID mapping so a renumbering can be audited or
 * replayed by hand.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet to write into.
 * @param {Array<Object>} persons Collected person records.
 * @param {Map<string,string>} newPidMap Old PID -> new PID.
 * @param {number} rewritten Count of references rewritten, for context.
 */
function writeRenumberReport_(ss, persons, newPidMap, rewritten) {
  let sheet = ss.getSheetByName(CFG.REPORT);
  if (!sheet) {
    sheet = ss.insertSheet(CFG.REPORT);
  } else {
    sheet.clear();
  }

  const rows = [['OLD_PID', 'NEW_PID', 'KNOWN_NAME', 'NOTES']];
  persons.forEach(p => {
    rows.push([p.pid, newPidMap.get(p.pid) || '', p.known, p.notes]);
  });
  rows.push([]);
  rows.push(['References rewritten', rewritten]);

  sheet.getRange(1, 1, rows.length, 4).setValues(
    rows.map(r => [r[0] === undefined ? '' : r[0],
                   r[1] === undefined ? '' : r[1],
                   r[2] === undefined ? '' : r[2],
                   r[3] === undefined ? '' : r[3]])
  );

  const headerRange = sheet.getRange(1, 1, 1, 4);
  headerRange.setFontWeight("bold").setBackground("#1c4587").setFontColor("#ffffff");
  sheet.setFrozenRows(1);
  for (let col = 1; col <= 4; col++) {
    sheet.autoResizeColumn(col);
  }
}

/* ====================================================================
 * 5. SETUP CHECK
 * ==================================================================== */

/** Menu entry point: report which required tabs are missing. */
function checkSheetSetup() {
  alert_(checkSheetSetupCore_());
}

/**
 * @return {string} Either the missing tabs or a confirmation.
 */
function checkSheetSetupCore_() {
  const ss = requireSpreadsheet_();
  const required = [CFG.INSTRUCTIONS, CFG.PERSONS, CFG.KG, CFG.VEDIC, CFG.STORIES];
  const findings = [];

  required
    .filter(name => !ss.getSheetByName(name))
    .forEach(name => findings.push(`Missing tab: ${name}.`));

  Object.keys(SCHEMA).forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;

    const lastCol = sheet.getLastColumn();
    const actual = lastCol
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v).trim().toUpperCase())
      : [];

    const absent = SCHEMA[name].headers.filter(h => {
      if (OPTIONAL_HEADERS.has(h)) return false;
      const accepted = [h].concat(HEADER_ALIASES[h] || []).map(v => v.toUpperCase());
      return !accepted.some(candidate => actual.indexOf(candidate) !== -1);
    });
    if (absent.length > 0) {
      findings.push(`${name}: missing column(s) ${absent.join(', ')}.`);
    }
  });

  if (findings.length === 0) {
    const config = ss.getSheetByName(CFG.CONFIG)
      ? ''
      : `\n\n'${CFG.CONFIG}' has not been generated yet. Use 'Generate $Config' ` +
        `when you start entering Vedic lineage data.`;
    return `Sheet setup is complete! All ${required.length} plugin tabs have the expected columns.` + config;
  }

  return findings.join('\n') +
         `\n\nSetup only writes headers into empty tabs, so an existing tab keeps ` +
         `its old headers. Rename the columns listed above by hand.`;
}

/* ====================================================================
 * 6. REFERENCE INTEGRITY CHECK
 * ==================================================================== */

/** Menu entry point: report broken or inconsistent references. */
function validateData() {
  alert_(validateDataCore_());
}

/**
 * Cross-checks every tab against the Persons roster. Catches the failures
 * that are silent at data-entry time but fatal on import: a KG edge naming
 * a person who is not in Persons, a PID typed into Vedic or Stories that no
 * longer exists, a duplicate PID, or an unrecognised predicate.
 *
 * @return {string} Human-readable findings, or a clean bill of health.
 * @throws {Error} If the Persons tab is missing.
 */
function validateDataCore_() {
  const ss = requireSpreadsheet_();
  const personsSheet = ss.getSheetByName(CFG.PERSONS);
  if (!personsSheet) throw new Error("Missing 'Persons' sheet. Run 'Plugin Setup' first.");

  const pRows = personsSheet.getDataRange().getValues();
  const pHeader = pRows[0].map(h => String(h).trim());
  const pidCol = columnOf_(pHeader, 'PID') - 1;
  const nameCol = columnOf_(pHeader, 'KNOWN_NAME') - 1;
  if (pidCol < 0) {
    throw new Error("Persons must have a PID column. Run 'Plugin Setup' first.");
  }

  const pids = new Set();
  const problems = [];
  const seen = new Set();

  for (let r = 1; r < pRows.length; r++) {
    const row = pRows[r];
    const pid = String(row[pidCol] || '').trim().toUpperCase();
    const known = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    const sheetRow = r + 1;

    if (!pid && known) {
      problems.push(`Persons row ${sheetRow}: "${known}" has a name but no PID.`);
      continue;
    }
    if (!pid) continue;

    if (seen.has(pid)) {
      problems.push(`Persons row ${sheetRow}: duplicate PID ${pid}.`);
    }
    seen.add(pid);
    pids.add(pid);
  }

  // A legacy "PID-KNOWN_NAME" reference still resolves, but it duplicates the
  // label into a cell that only needs the identity. Counted once here so the
  // report can suggest Normalize instead of listing every row.
  let composites = 0;

  /**
   * True when a relationship cell names a known person. Only the PID half is
   * treated as identity; a trailing name is a label and may be out of date.
   *
   * @param {string} value Cell contents.
   * @return {boolean} Whether it resolves.
   */
  const resolves = value => {
    const text = String(value || '').trim();
    if (!text) return true;

    const m = text.match(/^([A-Z]\d+)(?:-[\s\S]*)?$/i);
    if (!m) return false;

    const pid = m[1].toUpperCase();
    if (!pids.has(pid)) return false;

    if (text.length > m[1].length) composites++;
    return true;
  };

  const kgSheet = ss.getSheetByName(CFG.KG);
  if (kgSheet) {
    const rows = kgSheet.getDataRange().getValues();
    const header = rows.length ? rows[0] : [];
    const subCol = firstColumnOf_(header, ['SUBJECT', 'Subject (Node 1)']) - 1;
    const relCol = firstColumnOf_(header, ['PREDICATE', 'Predicate']) - 1;
    const objCol = firstColumnOf_(header, ['OBJECT', 'Object (Node 2)']) - 1;
    const allowed = PREDICATES.map(p => p.toLowerCase());

    if (subCol < 0 || relCol < 0 || objCol < 0) {
      problems.push(`KG: header must name SUBJECT, PREDICATE and OBJECT columns.`);
    } else {
      for (let r = 1; r < rows.length; r++) {
        const sub = rows[r][subCol];
        const rel = String(rows[r][relCol] || '').trim();
        const obj = rows[r][objCol];
        if (!sub && !rel && !obj) continue;

        if (sub && !resolves(sub)) {
          problems.push(`KG row ${r + 1}: subject "${sub}" is not in Persons.`);
        }
        if (obj && !resolves(obj)) {
          problems.push(`KG row ${r + 1}: object "${obj}" is not in Persons.`);
        }
        if (rel && allowed.indexOf(rel.toLowerCase()) === -1) {
          problems.push(`KG row ${r + 1}: predicate "${rel}" is not one of ${PREDICATES.join(', ')}.`);
        }
      }
    }
  }

  // Vedic names one person; Stories may tag several in a single cell.
  [
    { tab: CFG.VEDIC, header: 'PERSON', split: false },
    { tab: CFG.STORIES, header: 'TAGGED_PEOPLE', split: true }
  ].forEach(target => {
    const sheet = ss.getSheetByName(target.tab);
    if (!sheet) return;

    const lastCol = sheet.getLastColumn();
    if (!lastCol) return;

    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const col = columnOf_(header, target.header) - 1;
    if (col < 0) return;

    const rows = sheet.getDataRange().getValues();
    for (let r = 1; r < rows.length; r++) {
      const raw = String(rows[r][col] || '').trim();
      if (!raw) continue;

      // Tag lists use either comma or semicolon in the wild; both split.
      const entries = target.split ? raw.split(/[;,]/) : [raw];
      entries.forEach(entry => {
        const text = entry.trim();
        if (!text || resolves(text)) return;
        problems.push(`${target.tab} row ${r + 1}: "${text}" is not in Persons.`);
      });
    }
  });

  if (problems.length === 0) {
    return `No problems found. ${pids.size} people, all references resolve.` +
           compositeNote(composites);
  }

  const shown = problems.slice(0, 15);
  const more = problems.length - shown.length;
  return `Found ${problems.length} problem(s):\n\n` +
         shown.join('\n') +
         (more > 0 ? `\n…and ${more} more.` : '') +
         compositeNote(composites);
}

/**
 * Builds the advisory appended to a validation report when relationship cells
 * still carry the legacy "PID-KNOWN_NAME" form.
 *
 * These references resolve, because only the PID half is checked, but the name
 * half is a copy that can drift from Persons. The suggestion is a summary
 * rather than one line per row so the real problems stay visible.
 *
 * @param {number} count Number of composite references seen.
 * @return {string} A report suffix, or an empty string when there are none.
 */
function compositeNote(count) {
  if (!count) return '';
  return `\n\n${count} reference(s) still store "PID-KNOWN_NAME" instead of a bare PID. ` +
         `They resolve, but the name half is a copy that can go stale. ` +
         `Run 'Normalize References (PID only)' to reduce them to PIDs.`;
}
