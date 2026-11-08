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
  MAPPING: 'ID_Mapping_Key',
  REPORT: 'Renumber_Report'
};

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
 * @param {Object=} e Open event; absent when called from onInstall.
 */
function onOpen(e) {
  // Fires before authorization during a fresh install; the Ui is not
  // callable in that mode, so leave the menu for the next open.
  if (e && e.authMode === ScriptApp.AuthMode.NONE) {
    return;
  }

  const ui = SpreadsheetApp.getUi();

  const setupMenu = ui.createMenu('🚀 Plugin Setup')
    .addItem('Setup / Reset Workspace Tabs', 'setupDatabaseTabs');

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

  // Define Tab Schemas (Headers and Styles)
  const schemas = {
    [CFG.INSTRUCTIONS]: {
      isInstructions: true
    },
    [CFG.PERSONS]: {
      headers: ["PID", "KNOWN_NAME", "GENDER", "REF_NAME", "DOB", "POB", "DOD", "POD", "STATUS", "NOTES"],
      sample: ["A001", "Venkiteswara Iyer", "M", "A001-Venkiteswara Iyer", "1900", "Perumbavoor", "1965", "Kolkatta", "Deceased", "Head Patriarch"]
    },
    [CFG.KG]: {
      headers: ["Subject (Node 1)", "Predicate", "Object (Node 2)"],
      sample: [
        ["A001-Venkiteswara Iyer", "spouseOf", "A002-Rajammal"],
        ["A001-Venkiteswara Iyer", "parentOf", "B001-Viswanatha Tatha"]
      ]
    },
    [CFG.VEDIC]: {
      headers: ["PID", "REF_NAME", "GOTRA", "BIRTH_NAKSHATRA", "BIRTH_RASHI", "DEATH_MASA", "DEATH_PAKSHA", "DEATH_TITHI"],
      sample: ["A001", "A001-Venkiteswara Iyer", "Bharadwaja", "Rohini", "Vrishabha", "Kanya", "Krishna", "Ekadasi"]
    },
    [CFG.STORIES]: {
      headers: ["PID", "REF_NAME", "TITLE", "TAGS", "NOTES_AND_MEMORIES"],
      sample: ["A001", "A001-Venkiteswara Iyer", "Family Migration", "History, Kolkatta", "Moved to Kolkata in 1925."]
    }
  };

  let createdCount = 0;

  Object.keys(schemas).forEach(sheetName => {
    let sheet = ss.getSheetByName(sheetName);
    const isNew = !sheet;

    if (isNew) {
      sheet = ss.insertSheet(sheetName);
      createdCount++;
    }

    if (schemas[sheetName].isInstructions) {
      populateInstructionsSheet_(sheet);
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

  applyLinkedFormulas_(ss);
  applyValidations_(ss);

  return `Workspace initialized! Created/verified ${Object.keys(schemas).length} required tabs, ` +
         `with REF_NAME formulas and data validation applied.`;
}

/**
 * Populates clean Markdown-styled instructions into the 'Instructions' tab.
 *
 * @param {SpreadsheetApp.Sheet} sheet The Instructions sheet to rewrite.
 */
function populateInstructionsSheet_(sheet) {
  sheet.clear();
  sheet.setGridLines(true);

  const instructionsContent = [
    ["🌳 KULA GENEALOGY SYSTEM — USER GUIDE"],
    ["Welcome to the Kula Genealogy Knowledge Graph plugin! This system turns your family database into an inferred relational graph."],
    [""],
    ["📌 SHEET TAB OVERVIEW"],
    ["1. Persons", "Stores core individual metadata (PID, Name, Gender, DOB, DOD, Places)."],
    ["2. KG (Knowledge Graph)", "The single edge repository storing relationships using direct triples: Node 1 | Predicate | Node 2."],
    ["3. Vedic", "Tracks astrological & ritual details (Gotra, Birth Star, Death Tithi & Masa for Tarpanam)."],
    ["4. Stories", "Records family narratives, bio notes, and historical tags linked by Person PID."],
    ["5. KG_FLAT", "Auto-generated tab created when running graph flattener algorithms."],
    [""],
    ["🕸️ HOW TO WRITE RELATIONSHIPS IN 'KG'"],
    ["Instead of maintaining complex union or offspring sheets, define simple direct edges in the 'KG' tab:"],
    [""],
    ["  Subject (Node 1)", "Predicate", "Object (Node 2)"],
    ["  A001-John", "spouseOf", "A002-Jane"],
    ["  A002-Jane", "parentOf", "B001-Jack"],
    [""],
    ["💡 KEY FEATURES & INFERENCES"],
    ["• Automatic Co-Parenting", "If A001 spouseOf A002, and A002 parentOf B001, the system automatically infers A001 parentOf B001."],
    ["• Bidirectional Links", "Running 'Flatten All' generates reciprocal spouseOf edges and reverse childOf edges automatically."],
    ["• Generational PIDs", "Running 'Person Numbering > Apply Generational PIDs' recalculates distance from Patriarch A001 to assign Axxx, Bxxx, Cxxx numbers."],
    [""],
    ["⚙️ QUICK START MENU COMMANDS"],
    ["• Kula Genealogy > Plugin Setup", "Re-initializes or checks required tab schemas."],
    ["• Kula Genealogy > Flatten Knowledge Graph", "Compiles full graph edges into the 'KG_FLAT' tab."],
    ["• Kula Genealogy > Person Numbering", "Previews or applies generational renumbering (A001, B001, C001...)."]
  ];

  // Pad every row to three columns so the triple example keeps its
  // Object column instead of being truncated to Subject + Predicate.
  sheet.getRange(1, 1, instructionsContent.length, 3).setValues(
    instructionsContent.map(row => [row[0] || "", row[1] || "", row[2] || ""])
  );

  // Styling Instructions Tab
  sheet.getRange("A1:B1").merge().setFontWeight("bold").setFontSize(14).setBackground("#1c4587").setFontColor("#ffffff");
  sheet.getRange("A4:B4").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A11:B11").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A14:C14").setFontWeight("bold").setBackground("#d9ead3");
  sheet.getRange("A18:B18").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");
  sheet.getRange("A23:B23").setFontWeight("bold").setFontSize(11).setBackground("#e8f0fe");

  sheet.autoResizeColumn(1);
  sheet.autoResizeColumn(2);
  sheet.autoResizeColumn(3);
}

/* ====================================================================
 * 2b. DERIVED COLUMNS AND DATA VALIDATION
 * ==================================================================== */

/** Number of rows the setup formulas and validations cover. */
const SETUP_ROWS = 1000;

/** Canonical relationship predicates offered in the KG dropdown. */
const PREDICATES = ['spouseOf', 'parentOf', 'childOf'];

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
 * Makes REF_NAME a formula rather than a typed field, so it can never drift
 * out of sync with PID or KNOWN_NAME. This is what makes generational
 * renumbering safe: the reference text follows the PID automatically.
 *
 * @param {SpreadsheetApp.Spreadsheet} ss Spreadsheet being set up.
 */
function applyLinkedFormulas_(ss) {
  const persons = ss.getSheetByName(CFG.PERSONS);
  if (!persons) return;

  const header = persons.getRange(1, 1, 1, persons.getLastColumn() || 10).getValues()[0];
  const pidCol = columnOf_(header, 'PID');
  const nameCol = columnOf_(header, 'KNOWN_NAME');
  const refCol = columnOf_(header, 'REF_NAME');
  if (pidCol === -1 || nameCol === -1 || refCol === -1) return;

  const pidRef = columnLetter_(pidCol);
  const nameRef = columnLetter_(nameCol);

  const formulas = [];
  for (let r = 2; r <= SETUP_ROWS; r++) {
    formulas.push([`=IF(OR($${pidRef}${r}="",$${nameRef}${r}=""),"",$${pidRef}${r}&"-"&$${nameRef}${r})`]);
  }
  persons.getRange(2, refCol, SETUP_ROWS - 1, 1).setFormulas(formulas);
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
  const refCol = columnOf_(header, 'REF_NAME');

  const pidRange = pidCol === -1 ? null : persons.getRange(2, pidCol, SETUP_ROWS - 1, 1);
  const refRange = refCol === -1 ? null : persons.getRange(2, refCol, SETUP_ROWS - 1, 1);

  if (kg) {
    if (refRange) {
      const refRule = SpreadsheetApp.newDataValidation()
        .requireValueInRange(refRange, true)
        .setAllowInvalid(true)
        .setHelpText('Pick a person from the Persons tab (PID-KNOWN_NAME).')
        .build();
      kg.getRange(2, 1, SETUP_ROWS - 1, 1).setDataValidation(refRule);
      kg.getRange(2, 3, SETUP_ROWS - 1, 1).setDataValidation(refRule);
    }

    const predicateRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(PREDICATES, true)
      .setAllowInvalid(false)
      .setHelpText('Use one of: ' + PREDICATES.join(', '))
      .build();
    kg.getRange(2, 2, SETUP_ROWS - 1, 1).setDataValidation(predicateRule);
  }

  [CFG.VEDIC, CFG.STORIES].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet || !pidRange) return;
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(pidRange, true)
      .setAllowInvalid(true)
      .setHelpText('Pick a PID from the Persons tab.')
      .build();
    sheet.getRange(2, 1, SETUP_ROWS - 1, 1).setDataValidation(rule);
  });
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

  const pHeaders = pData[0].map(h => String(h).toLowerCase().trim());
  let pPidCol = pHeaders.findIndex(h => h.includes("pid") || h === "id");
  if (pPidCol === -1) pPidCol = 0;
  let pNameCol = pHeaders.findIndex(h => h.includes("known_name") || h.includes("name"));
  if (pNameCol === -1) pNameCol = 1;
  let pNotesCol = pHeaders.findIndex(h => h.includes("note"));

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
    const sub = extractPid(kgData[i][0]);
    const rel = String(kgData[i][1] || "").toLowerCase().trim();
    const obj = extractPid(kgData[i][2]);

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
  const counters = {};

  persons.forEach(p => {
    const lvl = genLevel.has(p.pid) ? genLevel.get(p.pid) : null;
    const prefix = lvl !== null ? genLetter(lvl) : "Z";

    if (!counters[prefix]) counters[prefix] = 1;
    const newId = `${prefix}${String(counters[prefix]++).padStart(3, "0")}`;
    newPidMap.set(p.pid, newId);
    pidLookup[String(p.pid).toUpperCase()] = newId;
  });

  const vedicSheet = ss.getSheetByName(CFG.VEDIC);
  const storiesSheet = ss.getSheetByName(CFG.STORIES);

  // Column positions follow the schema setupDatabaseTabsCore_ writes:
  // KG = [Subject, Predicate, Object]; Vedic/Stories = [PID, REF_NAME, ...].
  const KG_REF_COLS = [0, 2];
  const PID_REF_COLS = [0, 1];

  if (dryRun) {
    const pending = rewritePidRefs_(kgSheet, KG_REF_COLS, pidLookup, false) +
                    rewritePidRefs_(vedicSheet, PID_REF_COLS, pidLookup, false) +
                    rewritePidRefs_(storiesSheet, PID_REF_COLS, pidLookup, false);
    return `Preview Complete! ${persons.length} members across ` +
           `${Object.keys(counters).length} generational tiers. ` +
           `${pending} references in KG/Vedic/Stories would be rewritten. Nothing was changed.`;
  }

  for (let i = 0; i < persons.length; i++) {
    const p = persons[i];
    const newId = newPidMap.get(p.pid);
    pSheet.getRange(p.rowIdx, pPidCol + 1).setValue(newId);
  }

  const rewritten = rewritePidRefs_(kgSheet, KG_REF_COLS, pidLookup, true) +
                    rewritePidRefs_(vedicSheet, PID_REF_COLS, pidLookup, true) +
                    rewritePidRefs_(storiesSheet, PID_REF_COLS, pidLookup, true);

  writeRenumberReport_(ss, persons, newPidMap, rewritten);

  return `Renumbering Applied Successfully! ${persons.length} members renumbered ` +
         `and ${rewritten} references rewritten across KG, Vedic and Stories. ` +
         `Full old-to-new list is in the '${CFG.REPORT}' tab.`;
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
 * @return {number} Number of cells whose value would change.
 */
function rewritePidRefs_(sheet, colIdxs, lookup, apply) {
  if (!sheet) return 0;

  const range = sheet.getDataRange();
  const data = range.getValues();
  if (data.length <= 1) return 0;

  let changed = 0;
  for (let r = 1; r < data.length; r++) {
    colIdxs.forEach(c => {
      if (c >= data[r].length) return;
      const before = data[r][c];
      const after = remapRef_(before, lookup);
      if (after !== before) {
        data[r][c] = after;
        changed++;
      }
    });
  }

  if (apply && changed > 0) {
    range.setValues(data);
  }
  return changed;
}

/**
 * Maps one reference through the PID lookup.
 *
 * @param {*} value Cell value; anything non-string is returned untouched.
 * @param {Object<string,string>} lookup Uppercased old PID -> new PID.
 * @return {*} The rewritten reference, or the original value unchanged.
 */
function remapRef_(value, lookup) {
  if (value === null || value === undefined) return value;

  const text = String(value).trim();
  if (!text) return value;

  const m = text.match(/^([A-Z]\d+)(-[\s\S]*)?$/i);
  if (!m) return value;

  const next = lookup[m[1].toUpperCase()];
  if (!next) return value;

  return next + (m[2] || '');
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
  const missing = required.filter(name => !ss.getSheetByName(name));

  if (missing.length > 0) {
    return `Missing Sheet Tabs: ${missing.join(", ")}.\n\n` +
           `Run 'Kula Genealogy > 🚀 Plugin Setup > Setup / Reset Workspace Tabs' to build them.`;
  }
  return "Sheet setup is complete! All 5 plugin tabs are active.";
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
  const refCol = columnOf_(pHeader, 'REF_NAME') - 1;
  if (pidCol < 0 || refCol < 0) {
    throw new Error("Persons must have PID and REF_NAME columns. Run 'Plugin Setup' first.");
  }

  const pids = new Set();
  const refs = new Set();
  const problems = [];
  const seen = new Set();

  for (let r = 1; r < pRows.length; r++) {
    const row = pRows[r];
    const pid = String(row[pidCol] || '').trim().toUpperCase();
    const known = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    const ref = String(row[refCol] || '').trim();
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
    if (ref) refs.add(ref.toUpperCase());
  }

  /**
   * True when a relationship cell names a known person, by PID or full ref.
   * @param {string} value Cell contents.
   * @return {boolean} Whether it resolves.
   */
  const resolves = value => {
    const text = String(value || '').trim();
    if (!text) return true;
    const upper = text.toUpperCase();
    return refs.has(upper) || pids.has(upper);
  };

  const kgSheet = ss.getSheetByName(CFG.KG);
  if (kgSheet) {
    const rows = kgSheet.getDataRange().getValues();
    const allowed = PREDICATES.map(p => p.toLowerCase());
    for (let r = 1; r < rows.length; r++) {
      const sub = rows[r][0];
      const rel = String(rows[r][1] || '').trim();
      const obj = rows[r][2];
      if (!sub && !rel && !obj) continue;

      if (!resolves(sub)) {
        problems.push(`KG row ${r + 1}: subject "${sub}" is not in Persons.`);
      }
      if (!resolves(obj)) {
        problems.push(`KG row ${r + 1}: object "${obj}" is not in Persons.`);
      }
      if (rel && allowed.indexOf(rel.toLowerCase()) === -1) {
        problems.push(`KG row ${r + 1}: predicate "${rel}" is not one of ${PREDICATES.join(', ')}.`);
      }
    }
  }

  [CFG.VEDIC, CFG.STORIES].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return;
    const rows = sheet.getDataRange().getValues();
    for (let r = 1; r < rows.length; r++) {
      const pid = String(rows[r][0] || '').trim();
      if (!pid) continue;
      if (!pids.has(pid.replace(/^([A-Z]\d+).*$/i, '$1').toUpperCase())) {
        problems.push(`${name} row ${r + 1}: PID "${pid}" is not in Persons.`);
      }
    }
  });

  if (problems.length === 0) {
    return `No problems found. ${pids.size} people, all references resolve.`;
  }

  const shown = problems.slice(0, 15);
  const more = problems.length - shown.length;
  return `Found ${problems.length} problem(s):\n\n` +
         shown.join('\n') +
         (more > 0 ? `\n…and ${more} more.` : '');
}
