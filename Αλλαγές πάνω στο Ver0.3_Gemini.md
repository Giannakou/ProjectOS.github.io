# Saving System:
## Gemini Coding:
### 1η αλλαγή:

Αυτό είναι ανάμεσα στα functions resetToSample() και wipeAll() στις γραμμές 290
```JavaScript
function exportData() {
  const dataStr = JSON.stringify(STATE, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = 'BusinessOS_Backup_' + todayISO() + '.json';
  a.click();
  
  URL.revokeObjectURL(url);
  toast('Τα δεδομένα εξήχθησαν (Backup).');
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      ensureShape(imported); // Fills in missing keys based on seedData
      STATE = imported;
      saveState(); // Writes immediately to IndexedDB
      toast('Τα δεδομένα ανακτήθηκαν επιτυχώς!');
      render(); // Refreshes the UI with the new data
    } catch (err) {
      toast('Σφάλμα κατά την ανάγνωση του αρχείου.', true);
    }
  };
  reader.readAsText(file);
  event.target.value = ''; // Reset the input so the same file can be uploaded again
}

```

### 2η αλλαγή:
Locate the `viewSettings()` {γραμμή 1636} function in `app.js`. Inject a new panel inside the `<div class="grid2">` structure so users have a dedicated interface to manage their backups:
``` JavaScript
<div class="panel">
  <div class="panel-head"><h2>💾 Data Backup</h2></div>
  <div class="panel-body pad">
    <p class="row-sub" style="margin-bottom: 12px;">Αποθήκευσε τα δεδομένα σου τοπικά ή επανάφερέ τα από προηγούμενο backup.</p>
    <div style="display:flex; gap:8px;">
      <button class="btn btn-primary btn-sm" id="btn-export">Εξαγωγή (Download)</button>
      <button class="btn btn-ghost btn-sm" id="btn-import-trigger">Εισαγωγή (Upload)</button>
      <input type="file" id="file-import" style="display:none" accept=".json">
    </div>
  </div>
</div>

```
### 3η αλλαγή:
Find the `bindViewEvents()` {1759} function and paste these event listeners inside it to connect the UI to your new logic:
``` Javascript
const btnExp = document.getElementById('btn-export');
if(btnExp) btnExp.addEventListener('click', exportData);

const btnImpTrig = document.getElementById('btn-import-trigger');
if(btnImpTrig) btnImpTrig.addEventListener('click', () => document.getElementById('file-import').click());

const fileImp = document.getElementById('file-import');
if(fileImp) fileImp.addEventListener('change', importData);

```