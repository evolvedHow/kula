
/**********************************************************************
 *  KULA GENEALOGY PLUGIN — KNOWLEDGE GRAPH EDITION
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
 * 1. CUSTOM MENU (ON OPEN)
 * ==================================================================== */
function onOpen() {
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
    .addToUi();
}

/* ====================================================================
 * 2. AUTOMATED TAB INITIALIZER & INSTRUCTION CREATOR
 * ==================================================================== */
function setupDatabaseTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

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

  SpreadsheetApp.getUi().alert(`Workspace initialized! Created/verified ${Object.keys(schemas).length} required tabs.`);
}

/**
 * Populates clean Markdown-styled instructions into the 'Instructions' tab.
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

  sheet.getRange(1, 1, instructionsContent.length, 2).setValues(
    instructionsContent.map(row => [row[0] || "", row[1] || ""])
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
}

/* ====================================================================
 * 3. KNOWLEDGE GRAPH FLATTENER (CANONICAL PREDICATES)
 * ==================================================================== */
function runFlattenAll() { flattenGraphDB("flatten-all"); }
function runFlattenParents() { flattenGraphDB("flatten-parents"); }
function runFlattenOffsprings() { flattenGraphDB("flatten-offsprings"); }

function flattenGraphDB(mode) {
  mode = (mode || "flatten-all").toLowerCase().trim();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const graphSheet = ss.getSheetByName(CFG.KG);

  if (!graphSheet) {
    SpreadsheetApp.getUi().alert(`Error: Sheet '${CFG.KG}' not found. Run 'Plugin Setup' first.`);
    return;
  }

  const graphData = graphSheet.getDataRange().getValues();
  if (graphData.length === 0) {
    SpreadsheetApp.getUi().alert(`Error: '${CFG.KG}' sheet is empty.`);
    return;
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

  SpreadsheetApp.getUi().alert(`Flattening complete! Mode: '${mode}'. Generated ${outputRows.length} canonical graph triples.`);
}

/* ====================================================================
 * 4. GENERATIONAL RENUMBERING (BFS GRAPH-TRAVERSAL)
 * ==================================================================== */
function previewRenumber() { safeRun_(true); }
function applyRenumber() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Apply Renumbering?',
    'This will assign new generational PIDs (A001, B001, C001...) in Persons and update KG references.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (answer === ui.Button.YES) safeRun_(false);
}

function safeRun_(dryRun) {
  try {
    runRenumber_(dryRun);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    Logger.log('Renumber failed: ' + msg);
    SpreadsheetApp.getUi().alert('Renumbering stopped:\n\n' + msg);
  }
}

function runRenumber_(dryRun) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
    const m = String(str).match(/([A-Z]\d+)/i);
    return m ? m.toUpperCase() : String(str).trim().toUpperCase();
  }

  for (let i = 1; i < kgData.length; i++) {
    const sub = extractPid(kgData[i][0]);
    const rel = String(kgData[i][1] || "").toLowerCase().trim();
    const obj = extractPid(kgData[i][2]);

    if (!sub || !rel || !obj) continue;

    if (rel.includes("parent") || rel.includes("father") || rel.includes("mother")) {
      if (!parentGraph[sub]) parentGraph[sub] = new Set();
      parentGraph[sub].add(obj);
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
  const counters = {};

  persons.forEach(p => {
    const lvl = genLevel.has(p.pid) ? genLevel.get(p.pid) : null;
    let prefix = lvl !== null ? genLetter(lvl) : "Z";

    if (!counters[prefix]) counters[prefix] = 1;
    const newId = `${prefix}${String(counters[prefix]++).padStart(3, "0")}`;
    newPidMap.set(p.pid, newId);
  });

  if (dryRun) {
    SpreadsheetApp.getUi().alert(`Preview Complete! Processed ${persons.length} members across ${Object.keys(counters).length} generational tiers.`);
    return;
  }

  for (let i = 0; i < persons.length; i++) {
    const p = persons[i];
    const newId = newPidMap.get(p.pid);
    pSheet.getRange(p.rowIdx, pPidCol + 1).setValue(newId);
  }

  SpreadsheetApp.getUi().alert(`Renumbering Applied Successfully! Assigned generational PIDs to ${persons.length} members.`);
}

function checkSheetSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const required = [CFG.INSTRUCTIONS, CFG.PERSONS, CFG.KG, CFG.VEDIC, CFG.STORIES];
  const missing = required.filter(name => !ss.getSheetByName(name));

  if (missing.length > 0) {
    SpreadsheetApp.getUi().alert(`Missing Sheet Tabs: ${missing.join(", ")}.\n\nRun 'Kula Genealogy > 🚀 Plugin Setup > Setup / Reset Workspace Tabs' to build them.`);
  } else {
    SpreadsheetApp.getUi().alert("Sheet setup is complete! All 5 plugin tabs are active.");
  }
}