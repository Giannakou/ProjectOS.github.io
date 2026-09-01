# Έβαλα τα παραπάνω functions στο app.js ανάμεσα στα resetToSample() και το wipeall() στην γραμμή 290
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
