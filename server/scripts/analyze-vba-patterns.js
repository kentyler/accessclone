/**
 * Analyze VBA patterns across all northwind_18 modules.
 * Reports which patterns are untranslatable and their frequency.
 *
 * Usage: node scripts/analyze-vba-patterns.js
 * (Temporary analysis script - can be deleted after use)
 */
const { extractProcedures, stripBoilerplate, translateBlock, collectEnumValues } = require('../lib/vba-to-js');
const { Pool } = require('pg');

const pool = new Pool({ host: 'localhost', user: 'postgres', password: '7297', database: 'polyaccess' });

function categorizeComment(line) {
  const l = line.replace(/^\/\/\s*/, '').trim();
  if (!l) return null;

  // Skipped block markers from translateBlock
  if (/^\[VBA For Each loop skipped\]/.test(l)) return 'For Each loop (skipped)';
  if (/^\[VBA Do loop skipped\]/.test(l)) return 'Do/Loop (skipped)';
  if (/^\[VBA While loop skipped\]/.test(l)) return 'While/Wend (skipped)';
  if (/^\[VBA With block skipped\]/.test(l)) return 'With block (skipped)';
  if (/^\[VBA For loop skipped\]/.test(l)) return 'For loop (non-numeric bounds)';
  if (/^\[VBA If block - condition not translatable\]/.test(l)) return 'If block (untranslatable condition)';
  if (/^\[VBA Select Case - expression not translatable\]/.test(l)) return 'Select Case (untranslatable expression)';
  // Commented-out If/ElseIf/Else bodies from untranslatable conditions
  if (/^If .+ Then$/.test(l) || /^ElseIf .+ Then$/.test(l) || /^Else$/.test(l) || /^End If$/.test(l)) return null; // part of commented if block, skip

  // DAO / Recordset operations
  if (/\.OpenRecordset\b/i.test(l)) return 'DAO OpenRecordset';
  if (/\.(MoveFirst|MoveLast|MoveNext|Move\b|EOF|BOF|RecordCount)\b/i.test(l)) return 'DAO Recordset navigation';
  if (/\.FindFirst\b/i.test(l)) return 'DAO FindFirst';
  if (/\.(Edit|AddNew|Update)\b/i.test(l) && !/Me\./i.test(l)) return 'DAO Recordset Edit/AddNew/Update';
  if (/\.Fields\b/i.test(l) || /!(\w+)\b/.test(l) && /rs|Recordset/i.test(l)) return 'DAO Field access (rs!field)';
  if (/\bCurrentDb\b/i.test(l) || /g_dbApp\(\)/i.test(l)) return 'DAO Database reference';
  if (/\.Execute\b/i.test(l)) return 'DAO Execute SQL';
  if (/\.Bookmark\b/i.test(l)) return 'DAO Bookmark';
  if (/\.NoMatch\b/i.test(l)) return 'DAO NoMatch';
  if (/RecordsetClone\b/i.test(l)) return 'RecordsetClone access';

  // Form-level property assignments
  if (/Me\.(Caption)\s*=/i.test(l)) return 'Me.Caption = (form caption)';
  if (/Me\.(RecordSource)\s*=/i.test(l)) return 'Me.RecordSource = (change data source)';
  if (/Me\.(Filter|FilterOn)\s*=/i.test(l)) return 'Me.Filter/FilterOn =';
  if (/Me\.(AllowEdits|AllowAdditions|AllowDeletions)\s*=/i.test(l)) return 'Me.AllowEdits/Additions/Deletions =';
  if (/Me\.(DataEntry)\s*=/i.test(l)) return 'Me.DataEntry =';
  if (/Me\.Dirty\s*=\s*False/i.test(l)) return 'Me.Dirty = False (save record)';
  if (/Me\.Undo\b/i.test(l)) return 'Me.Undo';

  // Control property access patterns
  if (/Me\.\w+\.SetFocus\b/i.test(l)) return 'Me.ctrl.SetFocus';
  if (/Me\.\w+\.Requery\b/i.test(l)) return 'Me.ctrl.Requery';
  if (/Me\.\w+\.Form\./i.test(l)) return 'Subform .Form. property access';
  if (/Me\.\w+\.(ForeColor|BackColor|BackShade|FontBold|BackStyle|ForeShade)\b/i.test(l)) return 'Control formatting (ForeColor/BackColor/etc)';
  if (/Me\.\w+\.Locked\b/i.test(l)) return 'Control .Locked property';
  if (/Me\.\w+\.(Format|ControlSource)\b/i.test(l)) return 'Control .Format/.ControlSource';
  if (/Me\.tabProducts|Me\.pgOrders|Me\.PgPurchaseOrders/i.test(l)) return 'Tab control page access';

  // DoCmd patterns
  if (/DoCmd\.SearchForRecord/i.test(l)) return 'DoCmd.SearchForRecord';
  if (/DoCmd\.OpenForm\b/i.test(l)) return 'DoCmd.OpenForm (complex args)';
  if (/DoCmd\.OpenReport\b/i.test(l)) return 'DoCmd.OpenReport (complex args)';
  if (/DoCmd\.Hourglass/i.test(l)) return 'DoCmd.Hourglass';
  if (/DoCmd\.Close\b/i.test(l)) return 'DoCmd.Close (complex args)';
  if (/DoCmd\.RunCommand\b/i.test(l)) return 'DoCmd.RunCommand (unsupported acCmd)';
  if (/DoCmd\.GoToRecord\b/i.test(l)) return 'DoCmd.GoToRecord (complex)';
  if (/DoCmd\.\w+/i.test(l)) return 'DoCmd (other)';

  // MsgBox patterns
  if (/^MsgBox\s/i.test(l) || /\bMsgBox\s*\(/i.test(l)) return 'MsgBox (complex - not simple string)';

  // Function calls to other modules
  if (/^(GetString|StringFormat(SQL)?|GetSystemSetting|GetUserSetting|SaveSystemSetting|SaveUserSetting)\b/i.test(l)) return 'Utility function call (strings/settings)';
  if (/^(Get_UserID|Get_EmployeeFNLN|GetWindowsUserName|GetNorthwindAddress)\b/i.test(l)) return 'Utility function call (user/employee)';
  if (/^(ValidateForm|ValidateForm_RemoveHighlights|HighlightControl)\b/i.test(l)) return 'Validation function call';
  if (/^(AddToMRU|RemoveFromMRU|Ribbon_\w+|ActivateTab|RibbonFinish)\b/i.test(l)) return 'Ribbon/MRU function call';
  if (/^(RequeryListForms|RequeryProductList|IsFormOpen)\b/i.test(l)) return 'Cross-form requery/IsFormOpen';
  if (/^(AllocateInventory|Product\w+|CalculateLevels|ControlStates|SetFormStatus|LockControls)\b/i.test(l)) return 'Business logic function call';
  if (/^(OpenOrderDetailsForm|CloseOrderDetailsForm|OpenPurchaseOrderDetailsForm|ClosePurchaseOrderDetailsForm)\b/i.test(l)) return 'Multi-instance form management';
  if (/^(SetLineItemsStatus|SetProductCode|OneTimeProcessing|SetDatesToCurrent|SetCtrlCurrencyFormat|AddDataMacros|SetAppTitle|InitializeUser|Finish|Startup)\b/i.test(l)) return 'Startup/lifecycle function call';

  // VBA built-in functions
  if (/\b(DLookup|DCount|DSum|DMin|DMax)\b/i.test(l)) return 'Domain aggregate (complex criteria)';
  if (/\bNz\b/i.test(l) && !/^Nz\(/i.test(l)) return 'Nz() in complex expression';
  if (/\b(Split|Array|UBound|LBound|Erase)\b/i.test(l)) return 'Array functions (Split/Array/UBound/Erase)';
  if (/\b(CStr|CInt|CSng|CBool|CDate|CLng|CDbl)\b/i.test(l)) return 'Type conversion (CStr/CInt/etc)';
  if (/\b(Replace|Left\$?|Mid\$?|Right\$?|InStr|Len|Trim|Format)\b/i.test(l)) return 'String functions (Replace/Left/Mid/etc)';
  if (/\b(DateDiff|DateAdd|DateValue|Now|Date)\b/i.test(l)) return 'Date functions';
  if (/\b(Environ\$?|Rnd|Int)\b/i.test(l)) return 'System/Math functions (Environ/Rnd/Int)';
  if (/\bInputBox\b/i.test(l)) return 'InputBox';
  if (/\bIsMissing\b/i.test(l)) return 'IsMissing()';
  if (/\bIsNull\b/i.test(l)) return 'IsNull (in complex expression)';
  if (/\bIsArray\b/i.test(l)) return 'IsArray()';

  // Object patterns
  if (/\bNew\s+(Collection|Form_|Scripting|DAO)\b/i.test(l)) return 'Object instantiation (New)';
  if (/\bNothing\b/i.test(l)) return 'Set x = Nothing (cleanup)';
  if (/\bForms[!(]/i.test(l) || /\bForm_\w+\./i.test(l)) return 'Forms collection / cross-form reference';
  if (/\bReports[!(]/i.test(l)) return 'Reports collection access';
  if (/\bApplication\./i.test(l)) return 'Application object access';
  if (/\bScreen\./i.test(l)) return 'Screen object access';
  if (/\bCurrentProject\./i.test(l)) return 'CurrentProject access';
  if (/\bSysCmd\b/i.test(l)) return 'SysCmd()';

  // Error handling remnants
  if (/\bErr\./i.test(l)) return 'Err object access';
  if (/\bResume\b/i.test(l)) return 'Resume statement';

  // Debug
  if (/^Debug\./i.test(l)) return 'Debug.Print/Assert';

  // With block member access (from skipped With blocks)
  if (/^\.\w+/i.test(l)) return 'With-block member access';

  // GoTo
  if (/\bGoTo\s+\w+/i.test(l)) return 'GoTo statement';

  // Type checking
  if (/\bTypeOf\b/i.test(l) || /\bVarType\b/i.test(l)) return 'TypeOf/VarType checking';

  // Cancel parameter
  if (/\bCancel\s*=\s*(True|ValidateForm)/i.test(l)) return 'Cancel = True/ValidateForm (event parameter)';

  // Property chains
  if (/\.\w+\.\w+\.\w+/i.test(l)) return 'Deep property chain';

  // Assignment patterns
  if (/^\w+\s*=\s*.+/i.test(l)) return 'Variable assignment (complex RHS)';

  // Catch-all for remaining Me. patterns
  if (/Me\.\w+/i.test(l)) return 'Me.property (other)';

  return 'Other';
}

async function analyze() {
  const res = await pool.query(
    `SELECT name, definition->>'vba_source' as vba FROM shared.objects
     WHERE database_id='northwind_18' AND type='module' AND is_current=true
     AND definition->>'vba_source' IS NOT NULL`
  );

  const patternCounts = {};
  const moduleStats = {};
  const utilModules = {};

  for (const row of res.rows) {
    const { name, vba } = row;
    if (!vba) continue;

    const isUtility = !name.startsWith('Form_') && !name.startsWith('Report_');
    const procs = extractProcedures(vba);
    const enumMap = collectEnumValues(vba);

    let modTotal = 0, modTranslated = 0, modCommented = 0;
    const procList = [];

    for (const proc of procs) {
      const isEvent = /^(.+?)_(\w+)$/.test(proc.name);
      const cleaned = stripBoilerplate(proc.body);
      const { jsLines } = translateBlock(cleaned, 0, null, null, null, enumMap);

      let pTranslated = 0, pCommented = 0;
      for (const line of jsLines) {
        if (line.trim().startsWith('//')) {
          pCommented++;
          const pattern = categorizeComment(line);
          if (pattern) {
            if (!patternCounts[pattern]) patternCounts[pattern] = { count: 0, modules: new Set() };
            patternCounts[pattern].count++;
            patternCounts[pattern].modules.add(name);
          }
        } else if (line.trim()) {
          pTranslated++;
        }
      }
      modTotal += pTranslated + pCommented;
      modTranslated += pTranslated;
      modCommented += pCommented;

      procList.push({
        name: proc.name,
        isEvent,
        totalLines: cleaned.length,
        translatedLines: pTranslated,
        commentedLines: pCommented
      });
    }

    moduleStats[name] = {
      total: modTotal,
      translated: modTranslated,
      commented: modCommented,
      procedures: procList
    };

    if (isUtility) {
      const publicProcs = [];
      const lines = vba.split(/\r?\n/);
      for (const line of lines) {
        const pubMatch = line.trim().match(/^Public\s+(Sub|Function)\s+(\w+)\s*\(/i);
        if (pubMatch) {
          publicProcs.push({ type: pubMatch[1], name: pubMatch[2] });
        }
      }
      utilModules[name] = publicProcs;
    }
  }

  // Sort patterns by count
  const sorted = Object.entries(patternCounts)
    .sort((a, b) => b[1].count - a[1].count);

  console.log('============================================================');
  console.log('  TOP UNTRANSLATABLE PATTERNS (across ALL modules)');
  console.log('============================================================');
  console.log('');
  let rank = 0;
  for (const [pattern, data] of sorted.slice(0, 25)) {
    rank++;
    const mods = [...data.modules].slice(0, 6).join(', ');
    const more = data.modules.size > 6 ? ` (+${data.modules.size - 6} more)` : '';
    console.log(`${rank}. ${pattern}`);
    console.log(`   Occurrences: ${data.count} in ${data.modules.size} modules`);
    console.log(`   Modules: ${mods}${more}`);
    console.log('');
  }

  console.log('============================================================');
  console.log('  MODULE TRANSLATION SUMMARY');
  console.log('============================================================');
  console.log('');
  const sortedMods = Object.entries(moduleStats).sort((a, b) => b[1].commented - a[1].commented);
  console.log('Module Name                           | Trans | Comm | Total | %Trans');
  console.log('--------------------------------------+-------+------+-------+-------');
  for (const [name, stats] of sortedMods) {
    const pct = stats.total > 0 ? Math.round(100 * stats.translated / stats.total) : 0;
    const pad = (s, n) => s.toString().padStart(n);
    console.log(`${name.padEnd(38)}| ${pad(stats.translated, 5)} | ${pad(stats.commented, 4)} | ${pad(stats.total, 5)} | ${pad(pct, 4)}%`);
  }

  console.log('');
  console.log('============================================================');
  console.log('  UTILITY/CLASS MODULES - EXPORTED FUNCTIONS');
  console.log('============================================================');
  console.log('');
  for (const [name, procs] of Object.entries(utilModules).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${name}:`);
    for (const p of procs) {
      console.log(`  ${p.type} ${p.name}()`);
    }
    console.log('');
  }

  console.log('============================================================');
  console.log('  NON-EVENT PROCEDURES (currently skipped by parser)');
  console.log('============================================================');
  console.log('');
  let totalSkipped = 0;
  let totalSkippedLines = 0;
  for (const [name, stats] of Object.entries(moduleStats)) {
    const nonEvent = stats.procedures.filter(p => !p.isEvent);
    if (nonEvent.length > 0) {
      for (const p of nonEvent) {
        console.log(`  ${name}::${p.name} (${p.totalLines} lines)`);
        totalSkipped++;
        totalSkippedLines += p.totalLines;
      }
    }
  }
  console.log('');
  console.log(`Total non-event procedures: ${totalSkipped} (${totalSkippedLines} VBA lines)`);

  // Overall stats
  let totalAll = 0, transAll = 0, commAll = 0;
  for (const s of Object.values(moduleStats)) {
    totalAll += s.total;
    transAll += s.translated;
    commAll += s.commented;
  }

  // Stats for event procedures only (what the parser currently processes)
  let eventTotal = 0, eventTrans = 0, eventComm = 0;
  for (const s of Object.values(moduleStats)) {
    for (const p of s.procedures) {
      if (p.isEvent) {
        eventTotal += p.translatedLines + p.commentedLines;
        eventTrans += p.translatedLines;
        eventComm += p.commentedLines;
      }
    }
  }

  console.log('');
  console.log('============================================================');
  console.log('  OVERALL STATISTICS');
  console.log('============================================================');
  console.log('');
  console.log(`Total output lines (all procs): ${totalAll}`);
  console.log(`  Translated: ${transAll} (${Math.round(100 * transAll / totalAll)}%)`);
  console.log(`  Commented:  ${commAll} (${Math.round(100 * commAll / totalAll)}%)`);
  console.log('');
  console.log(`Event procedures only (current parser scope):`);
  console.log(`  Total: ${eventTotal}, Translated: ${eventTrans} (${eventTotal > 0 ? Math.round(100 * eventTrans / eventTotal) : 0}%), Commented: ${eventComm}`);
  console.log('');

  // Impact analysis: if we translated all procedures, not just event ones
  let nonEventComm = 0;
  for (const s of Object.values(moduleStats)) {
    for (const p of s.procedures) {
      if (!p.isEvent) {
        nonEventComm += p.commentedLines;
      }
    }
  }
  console.log(`Non-event procedures contain ${nonEventComm} commented lines`);
  console.log(`Expanding to all procedures would add ${totalSkippedLines} VBA lines to parse scope`);

  await pool.end();
}

analyze().catch(e => { console.error(e); process.exit(1); });
