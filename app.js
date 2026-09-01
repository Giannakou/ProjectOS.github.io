/* =========================================================================
   BusinessOS — Owner Cockpit
   Local, offline-first app. Όλα τα δεδομένα ζουν ΤΟΠΙΚΑ στο IndexedDB του
   browser. Δεν υπάρχει server, λογαριασμός, ή οποιοδήποτε δίκτυο tracking.

   ΔΟΜΗ ΑΡΧΕΙΟΥ (blueprint — για τον επόμενο developer):
     1) DATA LAYER  — module "Storage": μιλάει ΜΟΝΟ με το IndexedDB.
                       Δεν ξέρει τίποτα για DOM/HTML/UI.
     2) APP STATE   — το STATE object (μνήμη), seedData, loadState/saveState.
                       Εδώ γίνεται η "γέφυρα" μεταξύ Storage-layer και UI.
     3) UI LAYER    — SCHEMAS, modal, router, όλες οι view* συναρτήσεις.
                       Διαβάζουν/γράφουν πάνω στο STATE, ΠΟΤΕ απευθείας στο
                       IndexedDB — έτσι η οθόνη ενημερώνεται συγχρονισμένα
                       (synchronous) ενώ η αποθήκευση γίνεται ασύγχρονα
                       (asynchronous) στο παρασκήνιο.
   ========================================================================= */

function uid(prefix){
  return (prefix ? prefix + '_' : '') + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4);
}

/* =========================================================================
   1) DATA LAYER — "Storage": ο μοναδικός κώδικας που μιλάει με IndexedDB.
   =========================================================================
   Γιατί IndexedDB και όχι localStorage:
   - Η επιχείρηση θα έχει πολλούς πελάτες/έργα/συναλλαγές· το localStorage
     αποθηκεύει μόνο strings και αργά (serialize/deserialize ΟΛΟΚΛΗΡΟ το
     blob σε κάθε save), ενώ το IndexedDB είναι πραγματική τοπική βάση
     δεδομένων, με ξεχωριστό "object store" ανά τύπο entity.

   Σχεδίαση: κάθε πίνακας του STATE (tasks, customers, κ.λπ.) αντιστοιχεί
   1-προς-1 σε ένα IndexedDB object store με keyPath: 'id' (το ίδιο id που
   ήδη χρησιμοποιεί όλος ο κώδικας UI). Το owner/business (μοναδικά
   αντικείμενα, όχι λίστες) αποθηκεύονται σε ένα ξεχωριστό store
   "settings", με keyPath 'key' ('owner' ή 'business').

   Το module εκθέτει μόνο 3 μεθόδους προς τα έξω:
     Storage.loadState()     -> Promise<state-object|null>
     Storage.persistState(s) -> Promise (γράφει ΟΛΟΚΛΗΡΟ το state)
     Storage.wipe()          -> Promise (αδειάζει τα πάντα)
   Το πώς ανοίγει/διαχειρίζεται τη σύνδεση IndexedDB είναι εσωτερική
   λεπτομέρεια — κανένα άλλο σημείο του app.js δεν πρέπει να καλεί
   `indexedDB.*` απευθείας.
   --------------------------------------------------------------------- */
const Storage = (function(){
  const DB_NAME = 'businessos_db';
  const DB_VERSION = 1;

  // Ένα object store ανά λίστα-entity του STATE (βλ. seedData παρακάτω).
  const ENTITY_STORES = [
    'customers','suppliers','projects','tasks','events',
    'transactions','invoices','payments','goals','kpis',
    'alerts','documents','integrations'
  ];
  // Ξεχωριστό store για τα δύο "singleton" αντικείμενα (όχι λίστες).
  const SETTINGS_STORE = 'settings';

  let dbPromise = null;

  /** Ανοίγει (ή δημιουργεί, αν είναι η 1η φορά) τη βάση IndexedDB.
   *  Η dbPromise αποθηκεύεται ώστε να ανοίγουμε τη σύνδεση ΜΙΑ φορά. */
  function openDB(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject)=>{
      if(!('indexedDB' in window)){
        reject(new Error('Ο browser δεν υποστηρίζει IndexedDB.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // onupgradeneeded τρέχει μόνο στην 1η φορά (ή όταν αλλάζει DB_VERSION):
      // εδώ δημιουργούμε τα object stores, ένα ανά entity.
      req.onupgradeneeded = (e)=>{
        const db = e.target.result;
        ENTITY_STORES.forEach(name=>{
          if(!db.objectStoreNames.contains(name)){
            db.createObjectStore(name, { keyPath: 'id' });
          }
        });
        if(!db.objectStoreNames.contains(SETTINGS_STORE)){
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = ()=> resolve(req.result);
      req.onerror = ()=> reject(req.error);
    });
    return dbPromise;
  }

  /** Διαβάζει ΟΛΑ τα stores και τα επιστρέφει σε ένα object με το ίδιο
   *  "σχήμα" που περιμένει το υπόλοιπο app (STATE.tasks, STATE.owner, ...).
   *  Επιστρέφει null αν η βάση είναι εντελώς άδεια (πρώτο άνοιγμα ποτέ). */
  async function loadState(){
    const db = await openDB();
    const storeNames = ENTITY_STORES.concat([SETTINGS_STORE]);
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(storeNames, 'readonly');
      const state = {};
      let pending = storeNames.length;
      let hasAnyData = false;

      function done(){
        pending--;
        if(pending === 0) resolve(hasAnyData ? state : null);
      }

      ENTITY_STORES.forEach(name=>{
        const req = tx.objectStore(name).getAll();
        req.onsuccess = ()=>{
          state[name] = req.result || [];
          if(state[name].length) hasAnyData = true;
          done();
        };
        req.onerror = ()=> reject(req.error);
      });

      const settingsReq = tx.objectStore(SETTINGS_STORE).getAll();
      settingsReq.onsuccess = ()=>{
        state.owner = {}; state.business = {};
        (settingsReq.result || []).forEach(rec=>{
          const { key, ...rest } = rec; // βγάζουμε το τεχνικό "key" πεδίο
          state[key] = rest;
          if(Object.keys(rest).length) hasAnyData = true;
        });
        done();
      };
      settingsReq.onerror = ()=> reject(settingsReq.error);

      tx.onerror = ()=> reject(tx.error);
    });
  }

  /** Γράφει ΟΛΟΚΛΗΡΟ το state στο IndexedDB: για κάθε entity-store,
   *  αδειάζει τον παλιό πίνακα και ξαναγράφει την τρέχουσα λίστα.
   *  Όλα τα stores ενημερώνονται μέσα σε ΜΙΑ transaction — είτε
   *  αποθηκεύονται όλα, είτε (σε σφάλμα) κανένα, ώστε τα δεδομένα να
   *  μη μείνουν ποτέ σε "μισή" κατάσταση. */
  function persistState(state){
    return openDB().then(db=> new Promise((resolve, reject)=>{
      const storeNames = ENTITY_STORES.concat([SETTINGS_STORE]);
      const tx = db.transaction(storeNames, 'readwrite');
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
      tx.onabort = ()=> reject(tx.error);

      ENTITY_STORES.forEach(name=>{
        const store = tx.objectStore(name);
        store.clear();
        (state[name] || []).forEach(item=> store.put(item));
      });
      const settingsStore = tx.objectStore(SETTINGS_STORE);
      settingsStore.clear();
      settingsStore.put(Object.assign({ key: 'owner' }, state.owner || {}));
      settingsStore.put(Object.assign({ key: 'business' }, state.business || {}));
    }));
  }

  /** Αδειάζει τελείως όλα τα object stores (χρησιμοποιείται από το
   *  "διαγραφή όλων" στο sidebar/settings). */
  function wipe(){
    return openDB().then(db=> new Promise((resolve, reject)=>{
      const storeNames = ENTITY_STORES.concat([SETTINGS_STORE]);
      const tx = db.transaction(storeNames, 'readwrite');
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> reject(tx.error);
      storeNames.forEach(name=> tx.objectStore(name).clear());
    }));
  }

  return { loadState, persistState, wipe, ENTITY_STORES };
})();

/* ---------------------------------------------------------------------
   SEED DATA — mirrors the "Demo Café" sample data from the Obsidian vault
   --------------------------------------------------------------------- */
function seedData(){
  const cust_acme = uid('cust');
  const sup_coffee = uid('sup');
  const proj_none = null;

  return {
    owner: {
      name: 'Demo Owner',
      working_hours_start: '09:00',
      working_hours_end: '18:00',
      priorities: 'Cash collection\nRevenue growth\nProtect focus time',
      personal_goals: '',
      focus_hours: '',
      meeting_preferences: '',
      notification_preferences: '',
      current_focus: ''
    },
    business: {
      name: 'Demo Café',
      industry: 'hospitality',
      legal_form: 'IKE',
      city: 'Marousi',
      country: 'Greece',
      currency: 'EUR',
      mission: 'Quality coffee and fast service.',
      business_model: '',
      revenue_streams: '',
      current_priorities: 'Improve cash flow\nIncrease weekday revenue',
      key_constraints: '',
      notes: ''
    },
    customers: [
      { id: cust_acme, name: 'ACME', status: 'active', contact: 'Maria', email: 'demo@example.com', phone: '', industry: '', city: '', relationship: 'Active customer.', open_items: '', notes: '' }
    ],
    suppliers: [
      { id: sup_coffee, name: 'Coffee Supplier', contact: '', email: '', phone: '', category: 'coffee', status: 'active', notes: '' }
    ],
    projects: [],
    tasks: [
      { id: uid('task'), title: 'Collect overdue invoice', status: 'todo', priority: 'high', due_date: '2026-08-28', project_id: null, customer_id: cust_acme, estimated_minutes: 20, recurring: false, outcome: 'Collect overdue €1200 invoice.', notes: '', checklist: [ {id:uid('cl'), text:'Send reminder', done:false}, {id:uid('cl'), text:'Call customer', done:false} ] }
    ],
    events: [
      { id: uid('evt'), title: 'Customer meeting', start: '2026-08-27T10:00', end: '2026-08-27T10:45', event_type: 'meeting', customer_id: cust_acme, project_id: null, location: 'Online', status: 'scheduled', purpose: 'Discuss renewal.', participants: '', notes: '' }
    ],
    transactions: [
      { id: uid('txn'), title: 'Customer payment', transaction_type: 'income', date: '2026-08-20', category: 'sales', net_amount: 967.74, vat_amount: 232.26, gross_amount: 1200, currency: 'EUR', payment_status: 'paid', customer_id: cust_acme, supplier_id: null, project_id: null, recurring: false, notes: '' },
      { id: uid('txn'), title: 'Supplier purchase', transaction_type: 'expense', date: '2026-08-21', category: 'supplies', net_amount: 241.94, vat_amount: 58.06, gross_amount: 300, currency: 'EUR', payment_status: 'paid', customer_id: null, supplier_id: sup_coffee, project_id: null, recurring: false, notes: '' }
    ],
    invoices: [
      { id: uid('inv'), invoice_number: 'INV-001', customer_id: cust_acme, issue_date: '2026-08-01', due_date: '2026-08-20', net_amount: 967.74, vat_amount: 232.26, gross_amount: 1200, currency: 'EUR', status: 'overdue', project_id: null, notes: '' }
    ],
    payments: [],
    goals: [
      { id: uid('goal'), title: 'August Revenue', status: 'active', category: 'financial', target_value: 50000, current_value: 42000, unit: 'EUR', deadline: '2026-08-31', why: 'Reach monthly revenue target.', actions: '' }
    ],
    kpis: [],
    alerts: [
      { id: uid('alert'), title: 'Overdue invoice', severity: 'high', status: 'open', alert_date: '2026-08-26', related_entity: 'Invoice INV-001', reason: 'Invoice overdue', why_it_matters: '€1,200 has been outstanding for 6 days.', recommended_action: 'Contact customer today.', resolution: '' }
    ],
    documents: [],
    integrations: [
      { id: uid('int'), name: 'Τραπεζικός λογαριασμός', provider: '', status: 'planned', direction: 'inbound', sync_frequency: '', auth: 'OAuth', data_in: '', data_out: '', business_value: '' }
    ]
  };
}

/* =========================================================================
   2) APP STATE — η "γέφυρα" ανάμεσα στο Storage (IndexedDB) και το UI.
   =========================================================================
   Η STATE είναι ένα απλό, συγχρονισμένο (synchronous) object στη μνήμη.
   Όλος ο υπόλοιπος κώδικας (views, modal, κ.λπ.) διαβάζει/γράφει πάνω στη
   STATE ΚΑΝΟΝΙΚΑ, ακριβώς όπως πριν — καμία view δεν χρειάζεται `await`.

   Η ασυγχρονία (async) του IndexedDB "κρύβεται" εδώ, σε 2 σημεία μόνο:
     - loadState(): τρέχει ΜΙΑ φορά στην εκκίνηση (boot), πριν το πρώτο
       render(), και γεμίζει τη STATE από το IndexedDB.
     - saveState(): καλείται (όπως πριν) μετά από κάθε αλλαγή· ενημερώνει
       αμέσως το UI (η STATE είναι ήδη σωστή στη μνήμη) και ταυτόχρονα
       ξεκινάει, στο παρασκήνιο, ένα άσυγχρονο write στο IndexedDB.
   --------------------------------------------------------------------- */
let STATE = null;

/** Καλείται ΜΙΑ φορά στο boot(). Πρέπει να γίνει await πριν το πρώτο
 *  render(), αλλιώς η οθόνη θα προσπαθήσει να διαβάσει άδεια STATE. */
async function loadState(){
  try{
    const saved = await Storage.loadState();
    if(saved){
      STATE = saved;
      ensureShape(STATE);
    } else {
      // Πρώτο άνοιγμα ποτέ (ή άδεια βάση): γεμίζουμε με demo δεδομένα.
      STATE = seedData();
      await Storage.persistState(STATE);
    }
  }catch(e){
    console.warn('Αποτυχία φόρτωσης από IndexedDB — χρήση δεδομένων μόνο στη μνήμη.', e);
    STATE = seedData();
  }
}
function ensureShape(s){
  const shape = seedData();
  for(const k of Object.keys(shape)){
    if(!(k in s)) s[k] = shape[k];
  }
}
/** Persist στο IndexedDB. Σκόπιμα ΔΕΝ κάνουμε await εδώ στο σημείο
 *  κλήσης — η STATE είναι ήδη ενημερωμένη στη μνήμη, οπότε η οθόνη
 *  ξαναζωγραφίζεται αμέσως (render()) ενώ το write τρέχει ασύγχρονα. */
function saveState(){
  Storage.persistState(STATE).catch(err=>{
    console.error('Σφάλμα αποθήκευσης στο IndexedDB:', err);
    toast('Οι αλλαγές δεν αποθηκεύτηκαν τοπικά (σφάλμα IndexedDB).', true);
  });
}
function resetToSample(){
  STATE = seedData();
  saveState();
  toast('Τα δεδομένα επαναφέρθηκαν στο demo σετ.');
  render();
}
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
function wipeAll(){
  STATE = {owner:{}, business:{}, customers:[], suppliers:[], projects:[], tasks:[], events:[], transactions:[], invoices:[], payments:[], goals:[], kpis:[], alerts:[], documents:[], integrations:[]};
  saveState();
  toast('Όλα τα δεδομένα διαγράφηκαν.');
  render();
}

/* ---------------------------------------------------------------------
   UTILS
   --------------------------------------------------------------------- */
const fmtMoney = (v, currency) => {
  const n = Number(v)||0;
  try{
    return new Intl.NumberFormat('el-GR', {style:'currency', currency: currency || (STATE.business.currency)||'EUR'}).format(n);
  }catch(e){ return n.toFixed(2)+' '+(currency||'EUR'); }
};
const fmtDate = (d) => {
  if(!d) return '—';
  const dt = new Date(d.length===10 ? d+'T00:00:00' : d);
  if(isNaN(dt)) return d;
  return new Intl.DateTimeFormat('el-GR', {day:'2-digit', month:'short', year: 'numeric'}).format(dt);
};
const fmtDateShort = (d) => {
  if(!d) return '—';
  const dt = new Date(d.length===10 ? d+'T00:00:00' : d);
  if(isNaN(dt)) return d;
  return new Intl.DateTimeFormat('el-GR', {day:'2-digit', month:'short'}).format(dt);
};
const fmtTime = (d) => {
  if(!d) return '';
  const dt = new Date(d);
  if(isNaN(dt)) return '';
  return new Intl.DateTimeFormat('el-GR', {hour:'2-digit', minute:'2-digit'}).format(dt);
};
const fmtDateTime = (d) => {
  if(!d) return '—';
  const dt = new Date(d);
  if(isNaN(dt)) return d;
  return new Intl.DateTimeFormat('el-GR', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'}).format(dt);
};
function todayISO(){ return new Date().toISOString().slice(0,10); }
function daysDiff(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr.length===10 ? dateStr+'T00:00:00' : dateStr);
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((d - now) / 86400000);
}
function esc(s){
  if(s===undefined || s===null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function nl2list(s){
  if(!s) return [];
  return String(s).split('\n').map(x=>x.trim()).filter(Boolean);
}
function toast(msg, isErr){
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s'; setTimeout(()=>el.remove(), 250); }, 2600);
}
function findById(arr, id){ return (arr||[]).find(x=>x.id===id) || null; }

function autoInvoiceStatus(inv){
  if(inv.status === 'paid') return 'paid';
  if(inv.status === 'draft') return 'draft';
  const dd = daysDiff(inv.due_date);
  if(dd !== null && dd < 0) return 'overdue';
  return inv.status || 'unpaid';
}

/* ---------------------------------------------------------------------
   REFERENCE OPTIONS (for select dropdowns linking entities)
   --------------------------------------------------------------------- */
function refOptions(entityKey){
  const list = STATE[entityKey] || [];
  const labelKey = {customers:'name', suppliers:'name', projects:'title', invoices:'invoice_number'}[entityKey] || 'title';
  return list.map(x => ({ value: x.id, label: x[labelKey] || '(χωρίς τίτλο)' }));
}
function refLabel(entityKey, id){
  if(!id) return '—';
  const list = STATE[entityKey] || [];
  const labelKey = {customers:'name', suppliers:'name', projects:'title', invoices:'invoice_number'}[entityKey] || 'title';
  const item = list.find(x=>x.id===id);
  return item ? (item[labelKey] || '(χωρίς τίτλο)') : '—';
}

/* ---------------------------------------------------------------------
   SCHEMAS — drive the generic add/edit modal + table columns
   --------------------------------------------------------------------- */
const SCHEMAS = {
  task: {
    key: 'tasks', label: 'Εργασία', labelPlural: 'Εργασίες', icon:'TSK',
    titleField: 'title',
    fields: [
      {key:'title', label:'Τίτλος', type:'text', required:true, full:true},
      {key:'status', label:'Κατάσταση', type:'select', options:[['todo','Εκκρεμεί'],['in_progress','Σε εξέλιξη'],['done','Ολοκληρώθηκε']], default:'todo'},
      {key:'priority', label:'Προτεραιότητα', type:'select', options:[['low','Χαμηλή'],['medium','Μεσαία'],['high','Υψηλή']], default:'medium'},
      {key:'due_date', label:'Προθεσμία', type:'date'},
      {key:'estimated_minutes', label:'Εκτ. λεπτά', type:'number'},
      {key:'project_id', label:'Έργο', type:'ref', ref:'projects'},
      {key:'customer_id', label:'Πελάτης', type:'ref', ref:'customers'},
      {key:'recurring', label:'Επαναλαμβανόμενη', type:'checkbox'},
      {key:'outcome', label:'Επιθυμητό αποτέλεσμα', type:'textarea', full:true},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  event: {
    key:'events', label:'Ραντεβού', labelPlural:'Ημερολόγιο', icon:'CAL',
    titleField:'title',
    fields:[
      {key:'title', label:'Τίτλος', type:'text', required:true, full:true},
      {key:'start', label:'Έναρξη', type:'datetime-local', required:true},
      {key:'end', label:'Λήξη', type:'datetime-local'},
      {key:'event_type', label:'Τύπος', type:'select', options:[['meeting','Συνάντηση'],['call','Κλήση'],['deadline','Προθεσμία'],['other','Άλλο']], default:'meeting'},
      {key:'status', label:'Κατάσταση', type:'select', options:[['scheduled','Προγραμματισμένο'],['done','Έγινε'],['cancelled','Ακυρώθηκε']], default:'scheduled'},
      {key:'customer_id', label:'Πελάτης', type:'ref', ref:'customers'},
      {key:'project_id', label:'Έργο', type:'ref', ref:'projects'},
      {key:'location', label:'Τοποθεσία', type:'text'},
      {key:'purpose', label:'Σκοπός', type:'textarea', full:true},
      {key:'participants', label:'Συμμετέχοντες', type:'textarea', full:true},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  transaction: {
    key:'transactions', label:'Συναλλαγή', labelPlural:'Συναλλαγές', icon:'TXN',
    titleField:'title',
    fields:[
      {key:'title', label:'Περιγραφή', type:'text', required:true, full:true},
      {key:'transaction_type', label:'Τύπος', type:'select', options:[['income','Έσοδο'],['expense','Έξοδο']], default:'expense'},
      {key:'date', label:'Ημερομηνία', type:'date', required:true},
      {key:'category', label:'Κατηγορία', type:'text'},
      {key:'net_amount', label:'Καθαρό ποσό', type:'number', step:'0.01'},
      {key:'vat_amount', label:'ΦΠΑ', type:'number', step:'0.01'},
      {key:'gross_amount', label:'Μικτό ποσό', type:'number', step:'0.01'},
      {key:'currency', label:'Νόμισμα', type:'text', default:'EUR'},
      {key:'payment_status', label:'Κατάσταση πληρωμής', type:'select', options:[['paid','Πληρωμένο'],['pending','Εκκρεμεί']], default:'paid'},
      {key:'customer_id', label:'Πελάτης', type:'ref', ref:'customers'},
      {key:'supplier_id', label:'Προμηθευτής', type:'ref', ref:'suppliers'},
      {key:'project_id', label:'Έργο', type:'ref', ref:'projects'},
      {key:'recurring', label:'Επαναλαμβανόμενη', type:'checkbox'},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  invoice: {
    key:'invoices', label:'Τιμολόγιο', labelPlural:'Τιμολόγια', icon:'INV',
    titleField:'invoice_number',
    fields:[
      {key:'invoice_number', label:'Αριθμός τιμολογίου', type:'text', required:true},
      {key:'customer_id', label:'Πελάτης', type:'ref', ref:'customers', required:true},
      {key:'issue_date', label:'Ημερ. έκδοσης', type:'date'},
      {key:'due_date', label:'Ημερ. λήξης', type:'date'},
      {key:'net_amount', label:'Καθαρό ποσό', type:'number', step:'0.01'},
      {key:'vat_amount', label:'ΦΠΑ', type:'number', step:'0.01'},
      {key:'gross_amount', label:'Μικτό ποσό', type:'number', step:'0.01'},
      {key:'currency', label:'Νόμισμα', type:'text', default:'EUR'},
      {key:'status', label:'Κατάσταση', type:'select', options:[['draft','Πρόχειρο'],['unpaid','Ανεξόφλητο'],['paid','Εξοφλημένο'],['overdue','Ληξιπρόθεσμο']], default:'unpaid'},
      {key:'project_id', label:'Έργο', type:'ref', ref:'projects'},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  payment: {
    key:'payments', label:'Πληρωμή', labelPlural:'Πληρωμές', icon:'PAY',
    titleField:null,
    fields:[
      {key:'invoice_id', label:'Τιμολόγιο', type:'ref', ref:'invoices', required:true, full:true},
      {key:'payment_date', label:'Ημερομηνία', type:'date', required:true},
      {key:'amount', label:'Ποσό', type:'number', step:'0.01', required:true},
      {key:'currency', label:'Νόμισμα', type:'text', default:'EUR'},
      {key:'payment_method', label:'Τρόπος πληρωμής', type:'text'},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  goal: {
    key:'goals', label:'Στόχος', labelPlural:'Στόχοι', icon:'GOL',
    titleField:'title',
    fields:[
      {key:'title', label:'Τίτλος', type:'text', required:true, full:true},
      {key:'status', label:'Κατάσταση', type:'select', options:[['active','Ενεργός'],['done','Ολοκληρώθηκε'],['paused','Σε παύση']], default:'active'},
      {key:'category', label:'Κατηγορία', type:'select', options:[['financial','Οικονομικός'],['growth','Ανάπτυξη'],['operational','Λειτουργικός'],['personal','Προσωπικός']], default:'financial'},
      {key:'target_value', label:'Στόχος (τιμή)', type:'number', step:'0.01'},
      {key:'current_value', label:'Τρέχουσα τιμή', type:'number', step:'0.01'},
      {key:'unit', label:'Μονάδα', type:'text', default:'EUR'},
      {key:'deadline', label:'Προθεσμία', type:'date'},
      {key:'why', label:'Γιατί έχει σημασία', type:'textarea', full:true},
      {key:'actions', label:'Ενέργειες', type:'textarea', full:true},
    ]
  },
  kpi: {
    key:'kpis', label:'KPI', labelPlural:'KPIs', icon:'KPI',
    titleField:'name',
    fields:[
      {key:'name', label:'Όνομα', type:'text', required:true, full:true},
      {key:'target', label:'Στόχος', type:'number', step:'0.01'},
      {key:'actual', label:'Πραγματικό', type:'number', step:'0.01'},
      {key:'unit', label:'Μονάδα', type:'text'},
      {key:'period', label:'Περίοδος', type:'text', placeholder:'π.χ. Αύγουστος 2026'},
      {key:'source', label:'Πηγή δεδομένων', type:'text'},
      {key:'interpretation', label:'Ερμηνεία', type:'textarea', full:true},
      {key:'action_if_off_target', label:'Ενέργεια αν εκτός στόχου', type:'textarea', full:true},
    ]
  },
  customer: {
    key:'customers', label:'Πελάτης', labelPlural:'Πελάτες', icon:'CUS',
    titleField:'name',
    fields:[
      {key:'name', label:'Επωνυμία', type:'text', required:true, full:true},
      {key:'status', label:'Κατάσταση', type:'select', options:[['lead','Lead'],['active','Ενεργός'],['inactive','Ανενεργός']], default:'active'},
      {key:'contact', label:'Επικοινωνία (όνομα)', type:'text'},
      {key:'email', label:'Email', type:'email'},
      {key:'phone', label:'Τηλέφωνο', type:'tel'},
      {key:'industry', label:'Κλάδος', type:'text'},
      {key:'city', label:'Πόλη', type:'text'},
      {key:'relationship', label:'Σχέση', type:'textarea', full:true},
      {key:'open_items', label:'Εκκρεμότητες', type:'textarea', full:true},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  supplier: {
    key:'suppliers', label:'Προμηθευτής', labelPlural:'Προμηθευτές', icon:'SUP',
    titleField:'name',
    fields:[
      {key:'name', label:'Επωνυμία', type:'text', required:true, full:true},
      {key:'status', label:'Κατάσταση', type:'select', options:[['active','Ενεργός'],['inactive','Ανενεργός']], default:'active'},
      {key:'contact', label:'Επικοινωνία (όνομα)', type:'text'},
      {key:'email', label:'Email', type:'email'},
      {key:'phone', label:'Τηλέφωνο', type:'tel'},
      {key:'category', label:'Κατηγορία', type:'text'},
      {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
    ]
  },
  project: {
    key:'projects', label:'Έργο', labelPlural:'Έργα', icon:'PRJ',
    titleField:'title',
    fields:[
      {key:'title', label:'Τίτλος', type:'text', required:true, full:true},
      {key:'status', label:'Κατάσταση', type:'select', options:[['active','Ενεργό'],['done','Ολοκληρώθηκε'],['paused','Σε παύση']], default:'active'},
      {key:'customer_id', label:'Πελάτης', type:'ref', ref:'customers'},
      {key:'start_date', label:'Ημερ. έναρξης', type:'date'},
      {key:'deadline', label:'Προθεσμία', type:'date'},
      {key:'budget', label:'Προϋπολογισμός', type:'number', step:'0.01'},
      {key:'revenue', label:'Έσοδα', type:'number', step:'0.01'},
      {key:'costs', label:'Κόστη', type:'number', step:'0.01'},
      {key:'objective', label:'Στόχος έργου', type:'textarea', full:true},
      {key:'deliverables', label:'Παραδοτέα', type:'textarea', full:true},
    ]
  },
  alert: {
    key:'alerts', label:'Ειδοποίηση', labelPlural:'Ειδοποιήσεις', icon:'ALT',
    titleField:'title',
    fields:[
      {key:'title', label:'Τίτλος', type:'text', required:true, full:true},
      {key:'severity', label:'Σοβαρότητα', type:'select', options:[['low','Χαμηλή'],['medium','Μεσαία'],['high','Υψηλή']], default:'medium'},
      {key:'status', label:'Κατάσταση', type:'select', options:[['open','Ανοιχτή'],['resolved','Επιλύθηκε']], default:'open'},
      {key:'alert_date', label:'Ημερομηνία', type:'date'},
      {key:'related_entity', label:'Σχετίζεται με', type:'text', full:true},
      {key:'reason', label:'Αιτία', type:'text', full:true},
      {key:'why_it_matters', label:'Γιατί έχει σημασία', type:'textarea', full:true},
      {key:'recommended_action', label:'Προτεινόμενη ενέργεια', type:'textarea', full:true},
      {key:'resolution', label:'Επίλυση', type:'textarea', full:true},
    ]
  },
  integration: {
    key:'integrations', label:'Σύνδεση', labelPlural:'Συνδέσεις', icon:'INT',
    titleField:'name',
    fields:[
      {key:'name', label:'Όνομα', type:'text', required:true, full:true},
      {key:'provider', label:'Πάροχος', type:'text'},
      {key:'status', label:'Κατάσταση', type:'select', options:[['planned','Σχεδιασμένη'],['mocked','Mock'],['implemented','Υλοποιημένη'],['tested','Ελεγμένη']], default:'planned'},
      {key:'direction', label:'Κατεύθυνση', type:'select', options:[['inbound','Εισερχόμενη'],['outbound','Εξερχόμενη'],['bidirectional','Αμφίδρομη']], default:'inbound'},
      {key:'sync_frequency', label:'Συχνότητα sync', type:'text'},
      {key:'auth', label:'Auth', type:'text', default:'OAuth'},
      {key:'data_in', label:'Δεδομένα εισόδου', type:'textarea', full:true},
      {key:'data_out', label:'Δεδομένα εξόδου', type:'textarea', full:true},
      {key:'business_value', label:'Αξία για την επιχείρηση', type:'textarea', full:true},
    ]
  },
};

/* ---------------------------------------------------------------------
   GENERIC MODAL — add/edit any entity from its schema
   --------------------------------------------------------------------- */
let MODAL_STATE = null; // {schemaKey, id (null=new), draft, checklistDraft}

function openModal(schemaKey, id){
  const schema = SCHEMAS[schemaKey];
  let data = {};
  if(id){
    const existing = findById(STATE[schema.key], id);
    if(existing) data = JSON.parse(JSON.stringify(existing));
  } else {
    schema.fields.forEach(f=>{ if('default' in f) data[f.key] = f.default; });
    if(schemaKey === 'task') data.checklist = [];
  }
  MODAL_STATE = { schemaKey, id: id || null, draft: data };
  renderModal();
}
function closeModal(){
  MODAL_STATE = null;
  const host = document.getElementById('modal-root');
  if(host) host.innerHTML = '';
}
function fieldInput(f, value){
  const val = value===undefined || value===null ? '' : value;
  const req = f.required ? 'required' : '';
  if(f.type === 'select'){
    const opts = f.options.map(([v,l])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(l)}</option>`).join('');
    return `<select data-field="${f.key}">${opts}</select>`;
  }
  if(f.type === 'ref'){
    const opts = refOptions(f.ref).map(o=>`<option value="${esc(o.value)}" ${o.value===value?'selected':''}>${esc(o.label)}</option>`).join('');
    return `<select data-field="${f.key}"><option value="">—</option>${opts}</select>`;
  }
  if(f.type === 'textarea'){
    return `<textarea data-field="${f.key}" placeholder="${esc(f.placeholder||'')}">${esc(val)}</textarea>`;
  }
  if(f.type === 'checkbox'){
    return `<div class="field-check"><input type="checkbox" id="fld_${f.key}" data-field="${f.key}" ${value?'checked':''}><label for="fld_${f.key}">Ναι</label></div>`;
  }
  const step = f.step ? `step="${f.step}"` : '';
  return `<input type="${f.type}" data-field="${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder||'')}" ${step} ${req}>`;
}
function renderModal(){
  let host = document.getElementById('modal-root');
  if(!host){ host = document.createElement('div'); host.id='modal-root'; document.body.appendChild(host); }
  if(!MODAL_STATE){ host.innerHTML=''; return; }
  const schema = SCHEMAS[MODAL_STATE.schemaKey];
  const data = MODAL_STATE.draft;
  const isEdit = !!MODAL_STATE.id;

  let checklistHtml = '';
  if(MODAL_STATE.schemaKey === 'task'){
    const items = data.checklist || [];
    checklistHtml = `
      <div class="section-title">Checklist</div>
      <div id="checklist-box">
        ${items.map(it => `
          <div class="checklist-item">
            <input type="checkbox" ${it.done?'checked':''} data-cl-toggle="${it.id}">
            <span class="${it.done?'done':''}">${esc(it.text)}</span>
            <button data-cl-del="${it.id}" title="Διαγραφή">✕</button>
          </div>`).join('') || '<div class="row-sub">Καμία επισήμανση ακόμα.</div>'}
      </div>
      <div class="checklist-add">
        <input type="text" id="checklist-new-input" placeholder="Νέο βήμα... και Enter">
        <button class="btn btn-sm" id="checklist-add-btn">Προσθήκη</button>
      </div>
    `;
  }

  const fieldsHtml = schema.fields.map(f=>{
    const w = f.full ? 'grid-column: 1 / -1;' : '';
    return `<div class="field" style="${w}"><label>${esc(f.label)}</label>${fieldInput(f, data[f.key])}</div>`;
  }).join('');

  host.innerHTML = `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <h3>${isEdit ? 'Επεξεργασία' : 'Νέο'} — ${esc(schema.label)}</h3>
          <button class="modal-close" id="modal-close-btn">✕</button>
        </div>
        <div class="modal-body">
          <div class="field-row" style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
            ${fieldsHtml}
          </div>
          ${checklistHtml}
        </div>
        <div class="modal-foot">
          <div>
            ${isEdit ? `<button class="btn btn-danger btn-sm" id="modal-delete-btn">Διαγραφή</button>` : '<span></span>'}
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-ghost btn-sm" id="modal-cancel-btn">Άκυρο</button>
            <button class="btn btn-primary btn-sm" id="modal-save-btn">Αποθήκευση</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('modal-backdrop').addEventListener('click', (e)=>{ if(e.target.id==='modal-backdrop') closeModal(); });
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);

  host.querySelectorAll('[data-field]').forEach(el=>{
    el.addEventListener('change', ()=>{
      const key = el.getAttribute('data-field');
      MODAL_STATE.draft[key] = el.type === 'checkbox' ? el.checked : el.value;
      autoCalcAmounts();
    });
  });

  if(MODAL_STATE.schemaKey === 'task'){
    const addBtn = document.getElementById('checklist-add-btn');
    const input = document.getElementById('checklist-new-input');
    const addItem = ()=>{
      const v = input.value.trim();
      if(!v) return;
      if(!MODAL_STATE.draft.checklist) MODAL_STATE.draft.checklist = [];
      MODAL_STATE.draft.checklist.push({id: uid('cl'), text: v, done:false});
      renderModal();
    };
    addBtn.addEventListener('click', addItem);
    input.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); addItem(); } });
    host.querySelectorAll('[data-cl-toggle]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const id = cb.getAttribute('data-cl-toggle');
        const item = MODAL_STATE.draft.checklist.find(x=>x.id===id);
        if(item) item.done = cb.checked;
        renderModal();
      });
    });
    host.querySelectorAll('[data-cl-del]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-cl-del');
        MODAL_STATE.draft.checklist = MODAL_STATE.draft.checklist.filter(x=>x.id!==id);
        renderModal();
      });
    });
  }

  document.getElementById('modal-save-btn').addEventListener('click', saveModal);
  if(isEdit){
    document.getElementById('modal-delete-btn').addEventListener('click', ()=>{
      if(confirm('Σίγουρα θέλεις να διαγραφεί; Δεν αναιρείται.')){
        STATE[schema.key] = STATE[schema.key].filter(x=>x.id !== MODAL_STATE.id);
        saveState();
        toast(schema.label + ' διαγράφηκε.');
        closeModal();
        render();
      }
    });
  }
}
function autoCalcAmounts(){
  // for transaction / invoice forms: auto-fill gross = net + vat when both present and gross untouched-ish
  const d = MODAL_STATE.draft;
  if(['transaction','invoice'].includes(MODAL_STATE.schemaKey)){
    const net = parseFloat(d.net_amount), vat = parseFloat(d.vat_amount);
    if(!isNaN(net) && !isNaN(vat)){
      d.gross_amount = Math.round((net+vat)*100)/100;
      const el = document.querySelector('[data-field="gross_amount"]');
      if(el) el.value = d.gross_amount;
    }
  }
}
function saveModal(){
  const schema = SCHEMAS[MODAL_STATE.schemaKey];
  const draft = MODAL_STATE.draft;
  // required validation
  for(const f of schema.fields){
    if(f.required && !draft[f.key]){
      toast('Συμπλήρωσε το πεδίο: ' + f.label, true);
      return;
    }
  }
  // number coercion
  schema.fields.forEach(f=>{
    if(f.type==='number' && draft[f.key] !== undefined && draft[f.key] !== ''){
      draft[f.key] = parseFloat(draft[f.key]);
    }
  });
  if(MODAL_STATE.id){
    const idx = STATE[schema.key].findIndex(x=>x.id===MODAL_STATE.id);
    draft.id = MODAL_STATE.id;
    STATE[schema.key][idx] = draft;
    toast(schema.label + ' ενημερώθηκε.');
  } else {
    draft.id = uid(schema.key.slice(0,3));
    STATE[schema.key].push(draft);
    toast(schema.label + ' προστέθηκε.');
  }
  saveState();
  closeModal();
  render();
}

/* ---------------------------------------------------------------------
   ROUTER
   --------------------------------------------------------------------- */
let ROUTE = { view: 'dashboard', tab: null };
let SEARCH = {};
let MORE_OPEN = false; // αν είναι ανοιχτό το "Περισσότερα" bottom sheet (mobile)

function parseHash(){
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  ROUTE.view = parts[0] || 'dashboard';
  ROUTE.tab = parts[1] || null;
}
window.addEventListener('hashchange', ()=>{ parseHash(); render(); });

const NAV = [
  { group: 'Σήμερα', items: [
    { view:'dashboard', label:'Cockpit', ico:'◆' },
  ]},
  { group: 'Δουλειά', items: [
    { view:'tasks', label:'Εργασίες', ico:'☐', badgeFn: ()=>STATE.tasks.filter(t=>t.status!=='done').length },
    { view:'calendar', label:'Ημερολόγιο', ico:'▤' },
    { view:'projects', label:'Έργα', ico:'▦' },
  ]},
  { group: 'Χρήμα', items: [
    { view:'money', tab:'transactions', label:'Συναλλαγές', ico:'€' },
    { view:'money', tab:'invoices', label:'Τιμολόγια', ico:'⌸', badgeFn: ()=>STATE.invoices.filter(i=>autoInvoiceStatus(i)==='overdue').length, hot:true },
    { view:'money', tab:'payments', label:'Πληρωμές', ico:'⇄' },
  ]},
  { group: 'Στρατηγική', items: [
    { view:'goals', label:'Στόχοι & KPI', ico:'◎' },
  ]},
  { group: 'Σχέσεις', items: [
    { view:'crm', tab:'customers', label:'Πελάτες', ico:'●' },
    { view:'crm', tab:'suppliers', label:'Προμηθευτές', ico:'○' },
  ]},
  { group: 'Προσοχή', items: [
    { view:'alerts', label:'Ειδοποιήσεις', ico:'!', badgeFn: ()=>STATE.alerts.filter(a=>a.status==='open').length, hot:true },
    { view:'integrations', label:'Συνδέσεις', ico:'⇌' },
  ]},
  { group: 'Ρυθμίσεις', items: [
    { view:'settings', label:'Owner & Business', ico:'⚙' },
  ]},
];

function renderSidebar(){
  const groups = NAV.map(g=>{
    const items = g.items.map(it=>{
      const active = ROUTE.view === it.view && (it.tab ? ROUTE.tab===it.tab || (!ROUTE.tab && it.tab===defaultTabFor(it.view)) : true);
      const badge = it.badgeFn ? it.badgeFn() : null;
      const badgeHtml = (badge!==null && badge>0) ? `<span class="nav-badge ${it.hot?'hot':''}">${badge}</span>` : '';
      const href = '#/' + it.view + (it.tab ? '/'+it.tab : '');
      return `<div class="nav-item ${active?'active':''}" data-href="${href}">
        <span class="nav-ico">${it.ico}</span><span>${esc(it.label)}</span>${badgeHtml}
      </div>`;
    }).join('');
    return `<div class="nav-group"><div class="nav-group-label">${esc(g.group)}</div>${items}</div>`;
  }).join('');

  return `
    <div class="sidebar">
      <div class="brand">
        <div class="mark"><div class="dot"></div><div class="name">BusinessOS</div></div>
        <div class="sub">Owner Cockpit</div>
      </div>
      <div class="nav">${groups}</div>
      <div class="sidebar-foot">
        ${esc(STATE.business.name || 'Χωρίς όνομα επιχείρησης')} · local data
        <div>
          <button id="btn-reset-sample">επαναφορά demo</button> ·
          <button id="btn-wipe">διαγραφή όλων</button>
        </div>
      </div>
    </div>
  `;
}
function defaultTabFor(view){
  if(view==='money') return 'transactions';
  if(view==='crm') return 'customers';
  return null;
}

function bindSidebarEvents(){
  document.querySelectorAll('[data-href]').forEach(el=>{
    el.addEventListener('click', ()=>{ location.hash = el.getAttribute('data-href'); });
  });
  const rs = document.getElementById('btn-reset-sample');
  if(rs) rs.addEventListener('click', ()=>{ if(confirm('Επαναφορά στα demo δεδομένα; Θα χαθούν τα τρέχοντα.')) resetToSample(); });
  const wp = document.getElementById('btn-wipe');
  if(wp) wp.addEventListener('click', ()=>{ if(confirm('Διαγραφή ΟΛΩΝ των δεδομένων; Δεν αναιρείται.')) wipeAll(); });
}

/* =========================================================================
   BOTTOM NAVIGATION (mobile) — 4 βασικοί προορισμοί + "Περισσότερα"
   =========================================================================
   Το ίδιο NAV array από πάνω οδηγεί ΚΑΙ το desktop sidebar ΚΑΙ αυτό το
   bottom bar — έτσι δεν υπάρχουν δύο σημεία αλήθειας για τα menu items.
   Εδώ διαλέγουμε ποια 4 από όλα τα items προβάλλονται πρώτα (thumb-reach),
   και τα υπόλοιπα πάνε στο sheet "Περισσότερα" (βλ. moreNavGroups()).
   --------------------------------------------------------------------- */
const BOTTOM_NAV = [
  { view:'dashboard', label:'Home', ico:'◆' },
  { view:'tasks', label:'Εργασίες', ico:'☐', badgeFn: ()=>STATE.tasks.filter(t=>t.status!=='done').length },
  { view:'money', tab:'transactions', label:'Χρήμα', ico:'€' },
  { view:'crm', tab:'customers', label:'CRM', ico:'●' },
];
// Κλειδιά (view/tab) που ήδη καλύπτονται από τα 4 πάνω κουμπιά, ώστε να
// μην εμφανίζονται ξανά μέσα στο sheet "Περισσότερα".
const BOTTOM_NAV_KEYS = new Set(BOTTOM_NAV.map(it => it.view + '/' + (it.tab || '')));

function renderBottomNav(){
  const items = BOTTOM_NAV.map(it=>{
    const active = ROUTE.view === it.view && (it.tab ? (ROUTE.tab===it.tab || (!ROUTE.tab && it.tab===defaultTabFor(it.view))) : true);
    const badge = it.badgeFn ? it.badgeFn() : null;
    const href = '#/' + it.view + (it.tab ? '/'+it.tab : '');
    return `<button class="bn-item ${active?'active':''}" data-href="${href}">
      <span class="bn-ico">${it.ico}</span><span class="bn-label">${esc(it.label)}</span>
      ${(badge!==null && badge>0) ? `<span class="bn-dot">${badge>9?'9+':badge}</span>` : ''}
    </button>`;
  }).join('');

  // Το κουμπί "Περισσότερα" ανάβει είτε όταν το sheet είναι ανοιχτό, είτε
  // όταν η τρέχουσα σελίδα ζει μέσα σε αυτό (π.χ. Ημερολόγιο, Ρυθμίσεις).
  const moreActive = MORE_OPEN || !BOTTOM_NAV_KEYS.has(ROUTE.view + '/' + (ROUTE.tab || '')) && !BOTTOM_NAV.some(it=>it.view===ROUTE.view && !it.tab);
  const openAlertsCount = STATE.alerts.filter(a=>a.status==='open').length;

  return `
    <div class="bottom-nav">
      ${items}
      <button class="bn-item ${moreActive?'active':''}" id="bn-more-btn">
        <span class="bn-ico">⋯</span><span class="bn-label">Περισσότερα</span>
        ${openAlertsCount>0 ? `<span class="bn-dot">${openAlertsCount>9?'9+':openAlertsCount}</span>` : ''}
      </button>
    </div>
    <div id="more-sheet-root"></div>
  `;
}
function bindBottomNavEvents(){
  document.querySelectorAll('.bn-item[data-href]').forEach(el=>{
    el.addEventListener('click', ()=>{ closeMoreSheet(); location.hash = el.getAttribute('data-href'); });
  });
  const moreBtn = document.getElementById('bn-more-btn');
  if(moreBtn) moreBtn.addEventListener('click', openMoreSheet);
}

/** Ομαδοποιημένη λίστα των menu items που ΔΕΝ είναι ήδη στο bottom bar —
 *  ίδια δομή groups/items με το NAV, ώστε να ξαναχρησιμοποιήσουμε το CSS
 *  του sidebar (.nav-group, .nav-item) μέσα στο sheet. */
function moreNavGroups(){
  return NAV
    .map(g => ({ group: g.group, items: g.items.filter(it => !BOTTOM_NAV_KEYS.has(it.view + '/' + (it.tab || ''))) }))
    .filter(g => g.items.length > 0);
}
function openMoreSheet(){ MORE_OPEN = true; renderMoreSheet(); }
function closeMoreSheet(){
  MORE_OPEN = false;
  const host = document.getElementById('more-sheet-root');
  if(host) host.innerHTML = '';
}
function renderMoreSheet(){
  const host = document.getElementById('more-sheet-root');
  if(!host) return;
  if(!MORE_OPEN){ host.innerHTML = ''; return; }

  const groupsHtml = moreNavGroups().map(g=>{
    const itemsHtml = g.items.map(it=>{
      const active = ROUTE.view === it.view && (it.tab ? (ROUTE.tab===it.tab || (!ROUTE.tab && it.tab===defaultTabFor(it.view))) : true);
      const badge = it.badgeFn ? it.badgeFn() : null;
      const badgeHtml = (badge!==null && badge>0) ? `<span class="nav-badge ${it.hot?'hot':''}">${badge}</span>` : '';
      const href = '#/' + it.view + (it.tab ? '/'+it.tab : '');
      return `<div class="nav-item ${active?'active':''}" data-href="${href}">
        <span class="nav-ico">${it.ico}</span><span>${esc(it.label)}</span>${badgeHtml}
      </div>`;
    }).join('');
    return `<div class="nav-group"><div class="nav-group-label">${esc(g.group)}</div>${itemsHtml}</div>`;
  }).join('');

  host.innerHTML = `
    <div class="more-sheet-backdrop" id="more-sheet-backdrop">
      <div class="more-sheet">
        <div class="more-sheet-handle"></div>
        ${groupsHtml}
        <div class="more-sheet-foot">
          ${esc(STATE.business.name || 'Χωρίς όνομα επιχείρησης')} · local data
          <div>
            <button id="ms-btn-reset-sample">επαναφορά demo</button>
            <button id="ms-btn-wipe">διαγραφή όλων</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('more-sheet-backdrop').addEventListener('click', (e)=>{
    if(e.target.id === 'more-sheet-backdrop') closeMoreSheet();
  });
  host.querySelectorAll('[data-href]').forEach(el=>{
    el.addEventListener('click', ()=>{ closeMoreSheet(); location.hash = el.getAttribute('data-href'); });
  });
  const rs = document.getElementById('ms-btn-reset-sample');
  if(rs) rs.addEventListener('click', ()=>{ if(confirm('Επαναφορά στα demo δεδομένα; Θα χαθούν τα τρέχοντα.')){ closeMoreSheet(); resetToSample(); } });
  const wp = document.getElementById('ms-btn-wipe');
  if(wp) wp.addEventListener('click', ()=>{ if(confirm('Διαγραφή ΟΛΩΝ των δεδομένων; Δεν αναιρείται.')){ closeMoreSheet(); wipeAll(); } });
}

/* ---------------------------------------------------------------------
   TOPBAR
   --------------------------------------------------------------------- */
const VIEW_TITLES = {
  dashboard: ['Cockpit', 'Η εικόνα της επιχείρησης σήμερα'],
  tasks: ['Εργασίες', 'Τι πρέπει να γίνει'],
  calendar: ['Ημερολόγιο', 'Ραντεβού & προθεσμίες'],
  projects: ['Έργα', 'Ενεργές δουλειές με πελάτες'],
  money: ['Χρήμα', 'Συναλλαγές, τιμολόγια, πληρωμές'],
  goals: ['Στόχοι & KPI', 'Πού πάει η επιχείρηση'],
  crm: ['Σχέσεις', 'Πελάτες & προμηθευτές'],
  alerts: ['Ειδοποιήσεις', 'Τι χρειάζεται προσοχή'],
  integrations: ['Συνδέσεις', 'Εξωτερικά εργαλεία'],
  settings: ['Owner & Business', 'Το προφίλ σου'],
};
function renderTopbar(){
  const t = VIEW_TITLES[ROUTE.view] || ['BusinessOS',''];
  const now = new Date();
  return `
    <div class="topbar">
      <div>
        <div class="breadcrumb">${esc(t[1])}</div>
        <h1>${esc(t[0])}</h1>
      </div>
      <div class="topbar-right">
        <div class="clock">
          <div class="d1">${new Intl.DateTimeFormat('el-GR',{weekday:'long', day:'2-digit', month:'long'}).format(now)}</div>
          <div>${esc(STATE.owner.name || 'Owner')} · ${esc(STATE.business.name || '')}</div>
        </div>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------
   ROOT RENDER
   --------------------------------------------------------------------- */
function render(){
  const app = document.getElementById('app');
  let contentHtml = '';
  switch(ROUTE.view){
    case 'tasks': contentHtml = viewTasks(); break;
    case 'calendar': contentHtml = viewCalendar(); break;
    case 'projects': contentHtml = viewProjects(); break;
    case 'money': contentHtml = viewMoney(); break;
    case 'goals': contentHtml = viewGoals(); break;
    case 'crm': contentHtml = viewCRM(); break;
    case 'alerts': contentHtml = viewAlerts(); break;
    case 'integrations': contentHtml = viewIntegrations(); break;
    case 'settings': contentHtml = viewSettings(); break;
    default: contentHtml = viewDashboard();
  }

  app.innerHTML = `
    ${renderSidebar()}
    <div class="main">
      ${renderTopbar()}
      <div class="content">${contentHtml}</div>
    </div>
    ${renderBottomNav()}
  `;
  bindSidebarEvents();
  bindBottomNavEvents();
  bindViewEvents();
  renderModal();
  renderMoreSheet(); // αν το sheet ήταν ανοιχτό πριν το re-render, ξαναζωγραφίζεται
}

async function boot(){
  await loadState(); // περιμένουμε το IndexedDB πριν το πρώτο render
  parseHash();
  render();
}
document.addEventListener('DOMContentLoaded', ()=>{ boot(); });

/* =========================================================================
   DASHBOARD
   ========================================================================= */
function viewDashboard(){
  const openTasks = STATE.tasks.filter(t=>t.status!=='done');
  const attentionTasks = openTasks.slice().sort((a,b)=>{
    const da = a.due_date || '9999'; const db = b.due_date || '9999';
    return da.localeCompare(db);
  }).slice(0,7);

  const now = new Date();
  const upcomingEvents = STATE.events.filter(e=>e.status!=='cancelled').slice().sort((a,b)=>(a.start||'').localeCompare(b.start||'')).slice(0,6);

  const revenue = STATE.transactions.filter(t=>t.transaction_type==='income').reduce((s,t)=>s+(Number(t.gross_amount)||0),0);
  const expenses = STATE.transactions.filter(t=>t.transaction_type==='expense').reduce((s,t)=>s+(Number(t.gross_amount)||0),0);
  const net = revenue - expenses;
  const recentTxns = STATE.transactions.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,6);

  const overdueInvoices = STATE.invoices.filter(i=>autoInvoiceStatus(i)==='overdue');
  const openAlerts = STATE.alerts.filter(a=>a.status==='open').sort((a,b)=>{
    const sev = {high:0, medium:1, low:2};
    return (sev[a.severity]??3) - (sev[b.severity]??3);
  });

  const activeGoals = STATE.goals.filter(g=>g.status==='active');

  const overdueTasksCount = openTasks.filter(t=> t.due_date && daysDiff(t.due_date) < 0).length;

  const hud = `
    <div class="hud">
      <div class="hud-cell"><div class="hud-tick amber"></div>
        <div class="hl">⚠ Χρειάζονται προσοχή</div>
        <div class="hv">${openAlerts.length + overdueTasksCount}</div>
        <div class="hs">${openAlerts.length} ειδοποιήσεις · ${overdueTasksCount} εκπρόθεσμες εργασίες</div>
      </div>
      <div class="hud-cell"><div class="hud-tick teal"></div>
        <div class="hl">Καθαρό αποτέλεσμα</div>
        <div class="hv" style="color:${net>=0?'var(--teal)':'var(--coral)'}">${fmtMoney(net)}</div>
        <div class="hs">${fmtMoney(revenue)} έσοδα · ${fmtMoney(expenses)} έξοδα</div>
      </div>
      <div class="hud-cell"><div class="hud-tick coral"></div>
        <div class="hl">Ληξιπρόθεσμα τιμολόγια</div>
        <div class="hv">${overdueInvoices.length}</div>
        <div class="hs">${fmtMoney(overdueInvoices.reduce((s,i)=>s+(Number(i.gross_amount)||0),0))} σε εκκρεμότητα</div>
      </div>
      <div class="hud-cell"><div class="hud-tick blue"></div>
        <div class="hl">Ενεργοί στόχοι</div>
        <div class="hv">${activeGoals.length}</div>
        <div class="hs">${activeGoals.length ? Math.round(activeGoals.reduce((s,g)=>s+Math.min(100,(g.current_value/g.target_value*100)||0),0)/activeGoals.length)+'% μ.ο. πρόοδος' : 'δεν έχεις ορίσει στόχο'}</div>
      </div>
    </div>
  `;

  const attentionPanel = `
    <div class="panel">
      <div class="panel-head"><h2>🔴 Attention</h2><span class="count">${attentionTasks.length} από ${openTasks.length}</span></div>
      <div class="panel-body">
        ${attentionTasks.length ? `<table><tbody>
          ${attentionTasks.map(t=>{
            const overdue = t.due_date && daysDiff(t.due_date) < 0;
            const dueBadge = t.due_date ? `<span class="badge ${overdue?'coral':(daysDiff(t.due_date)===0?'amber':'grey')}"><span class="bd"></span>${fmtDateShort(t.due_date)}</span>` : '<span class="badge grey">χωρίς προθεσμία</span>';
            return `<tr data-open="task:${t.id}">
              <td style="width:26px;"><input type="checkbox" data-task-done="${t.id}" ${t.status==='done'?'checked':''} onclick="event.stopPropagation()"></td>
              <td><div class="row-title">${esc(t.title)}</div><div class="row-sub">${refLabel('customers', t.customer_id) !== '—' ? '👤 '+esc(refLabel('customers', t.customer_id)) : ''}</div></td>
              <td>${priorityBadge(t.priority)}</td>
              <td style="text-align:right;">${dueBadge}</td>
            </tr>`;
          }).join('')}
        </tbody></table>` : `<div class="panel-empty">Δεν υπάρχουν ανοιχτές εργασίες. 🎉</div>`}
      </div>
    </div>
  `;

  const eventsPanel = `
    <div class="panel">
      <div class="panel-head"><h2>📅 Επόμενα ραντεβού</h2><span class="count">${upcomingEvents.length}</span></div>
      <div class="panel-body">
        ${upcomingEvents.length ? `<table><tbody>
          ${upcomingEvents.map(e=>`
            <tr data-open="event:${e.id}">
              <td class="mono" style="width:110px;">${fmtDateShort(e.start)} · ${fmtTime(e.start)}</td>
              <td><div class="row-title">${esc(e.title)}</div><div class="row-sub">${esc(e.location||'')}</div></td>
              <td style="text-align:right;">${eventTypeBadge(e.event_type)}</td>
            </tr>
          `).join('')}
        </tbody></table>` : `<div class="panel-empty">Κανένα προγραμματισμένο ραντεβού.</div>`}
      </div>
    </div>
  `;

  const moneyPanel = `
    <div class="panel">
      <div class="panel-head"><h2>💰 Money snapshot</h2><span class="count">τελευταίες κινήσεις</span></div>
      <div class="panel-body">
        ${recentTxns.length ? `<table><tbody>
          ${recentTxns.map(t=>`
            <tr data-open="transaction:${t.id}">
              <td class="mono" style="width:90px;">${fmtDateShort(t.date)}</td>
              <td><div class="row-title">${esc(t.title)}</div></td>
              <td style="text-align:right;" class="num ${t.transaction_type==='income'?'':''}">
                <span style="color:${t.transaction_type==='income'?'var(--teal)':'var(--coral)'}">${t.transaction_type==='income'?'+':'−'}${fmtMoney(Math.abs(t.gross_amount||0), t.currency)}</span>
              </td>
            </tr>
          `).join('')}
        </tbody></table>` : `<div class="panel-empty">Δεν έχεις καταχωρήσει συναλλαγές ακόμα.</div>`}
      </div>
    </div>
  `;

  const goalsPanel = `
    <div class="panel">
      <div class="panel-head"><h2>🎯 Ενεργοί στόχοι</h2><span class="count">${activeGoals.length}</span></div>
      <div class="panel-body pad">
        ${activeGoals.length ? activeGoals.map(g=>{
          const pct = g.target_value ? Math.min(100, Math.round((g.current_value/g.target_value)*100)) : 0;
          const dd = g.deadline ? daysDiff(g.deadline) : null;
          return `<div style="margin-bottom:16px; cursor:pointer;" data-open="goal:${g.id}">
            <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
              <span style="font-weight:500; font-size:13px;">${esc(g.title)}</span>
              <span class="mono" style="font-size:12px; color:var(--text-dim);">${pct}%</span>
            </div>
            <div class="progress-track"><div class="progress-fill ${pct<50?'over':''}" style="width:${pct}%; background:${pct>=100?'var(--teal)':'var(--amber)'}"></div></div>
            <div class="row-sub" style="margin-top:5px;">${fmtMoneyOrUnit(g.current_value,g.unit)} / ${fmtMoneyOrUnit(g.target_value,g.unit)}${dd!==null ? ' · '+(dd>=0?dd+' μέρες ακόμα':Math.abs(dd)+' μέρες καθυστέρηση') : ''}</div>
          </div>`;
        }).join('') : `<div class="panel-empty">Δεν έχεις ορίσει ενεργό στόχο.</div>`}
      </div>
    </div>
  `;

  const alertsPanel = `
    <div class="panel">
      <div class="panel-head"><h2>⚠️ Ανοιχτές ειδοποιήσεις</h2><span class="count">${openAlerts.length}</span></div>
      <div class="panel-body">
        ${openAlerts.length ? `<table><tbody>
          ${openAlerts.map(a=>`
            <tr data-open="alert:${a.id}">
              <td style="width:90px;">${severityBadge(a.severity)}</td>
              <td><div class="row-title">${esc(a.title)}</div><div class="row-sub">${esc(a.reason||'')}</div></td>
              <td class="mono" style="text-align:right; width:90px;">${fmtDateShort(a.alert_date)}</td>
            </tr>
          `).join('')}
        </tbody></table>` : `<div class="panel-empty">Καμία ανοιχτή ειδοποίηση.</div>`}
      </div>
    </div>
  `;

  return `
    ${hud}
    <div class="grid2">
      <div>${attentionPanel}${eventsPanel}${moneyPanel}</div>
      <div>${goalsPanel}${alertsPanel}</div>
    </div>
  `;
}
function fmtMoneyOrUnit(v, unit){
  if(unit === 'EUR' || !unit) return fmtMoney(v, 'EUR');
  return (Number(v)||0).toLocaleString('el-GR') + ' ' + unit;
}
function priorityBadge(p){
  const map = {high:['coral','Υψηλή'], medium:['amber','Μεσαία'], low:['grey','Χαμηλή']};
  const [cls,label] = map[p] || ['grey', p||'—'];
  return `<span class="badge ${cls}"><span class="bd"></span>${label}</span>`;
}
function severityBadge(s){
  const map = {high:['coral','Υψηλή'], medium:['amber','Μεσαία'], low:['grey','Χαμηλή']};
  const [cls,label] = map[s] || ['grey', s||'—'];
  return `<span class="badge ${cls}"><span class="bd"></span>${label}</span>`;
}
function statusBadge(s, map){
  const info = map[s] || ['grey', s||'—'];
  return `<span class="badge ${info[0]}"><span class="bd"></span>${info[1]}</span>`;
}
function eventTypeBadge(t){
  const map = {meeting:['blue','Συνάντηση'], call:['blue','Κλήση'], deadline:['coral','Προθεσμία'], other:['grey','Άλλο']};
  const [cls,label] = map[t] || ['grey', t];
  return `<span class="badge ${cls}"><span class="bd"></span>${label}</span>`;
}

/* =========================================================================
   GENERIC LIST VIEW HELPER
   ========================================================================= */
function toolbarHtml(schemaKey, count, addLabel){
  const q = SEARCH[schemaKey] || '';
  return `
    <div class="toolbar">
      <input type="text" class="search-input" id="search-${schemaKey}" placeholder="Αναζήτηση..." value="${esc(q)}">
      <div style="display:flex; align-items:center; gap:12px;">
        <span class="stats">${count} εγγραφές</span>
        <button class="btn btn-primary" data-add="${schemaKey}">+ ${esc(addLabel)}</button>
      </div>
    </div>
  `;
}
function filterList(list, schemaKey, textKeys){
  const q = (SEARCH[schemaKey]||'').toLowerCase().trim();
  if(!q) return list;
  return list.filter(item => textKeys.some(k => String(item[k]||'').toLowerCase().includes(q)));
}
function emptyState(msg, schemaKey, addLabel){
  return `<div class="empty-state"><div class="es-ico">·  ·  ·</div><p>${esc(msg)}</p><button class="btn btn-primary btn-sm" data-add="${schemaKey}">+ ${esc(addLabel)}</button></div>`;
}

/* =========================================================================
   TASKS
   ========================================================================= */
function viewTasks(){
  let list = STATE.tasks.slice().sort((a,b)=>(a.due_date||'9999').localeCompare(b.due_date||'9999'));
  list = filterList(list, 'tasks', ['title','notes','outcome']);
  return `
    ${toolbarHtml('tasks', list.length, 'Νέα εργασία')}
    <div class="panel">
      ${list.length ? `<table>
        <thead><tr><th style="width:26px;"></th><th>Τίτλος</th><th>Προτεραιότητα</th><th>Πελάτης / Έργο</th><th>Προθεσμία</th></tr></thead>
        <tbody>
          ${list.map(t=>{
            const overdue = t.status!=='done' && t.due_date && daysDiff(t.due_date) < 0;
            return `<tr data-open="task:${t.id}">
              <td><input type="checkbox" data-task-done="${t.id}" ${t.status==='done'?'checked':''} onclick="event.stopPropagation()"></td>
              <td><div class="row-title" style="${t.status==='done'?'color:var(--text-faint); text-decoration:line-through;':''}">${esc(t.title)}</div></td>
              <td>${priorityBadge(t.priority)}</td>
              <td class="row-sub">${refLabel('customers',t.customer_id)!=='—'?esc(refLabel('customers',t.customer_id)):(refLabel('projects',t.project_id)!=='—'?esc(refLabel('projects',t.project_id)):'—')}</td>
              <td>${t.due_date ? `<span class="badge ${overdue?'coral':'grey'}"><span class="bd"></span>${fmtDateShort(t.due_date)}</span>` : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : emptyState('Δεν υπάρχουν εργασίες ακόμα.', 'tasks', 'Νέα εργασία')}
    </div>
  `;
}

/* =========================================================================
   CALENDAR
   ========================================================================= */
function viewCalendar(){
  let list = STATE.events.slice().sort((a,b)=>(a.start||'').localeCompare(b.start||''));
  list = filterList(list, 'events', ['title','location','purpose']);
  return `
    ${toolbarHtml('events', list.length, 'Νέο ραντεβού')}
    <div class="panel">
      ${list.length ? `<table>
        <thead><tr><th>Έναρξη</th><th>Τίτλος</th><th>Τύπος</th><th>Πελάτης</th><th>Τοποθεσία</th><th>Κατάσταση</th></tr></thead>
        <tbody>
          ${list.map(e=>`
            <tr data-open="event:${e.id}">
              <td class="mono">${fmtDateShort(e.start)} · ${fmtTime(e.start)}</td>
              <td class="row-title">${esc(e.title)}</td>
              <td>${eventTypeBadge(e.event_type)}</td>
              <td class="row-sub">${esc(refLabel('customers', e.customer_id))}</td>
              <td class="row-sub">${esc(e.location||'—')}</td>
              <td>${statusBadge(e.status, {scheduled:['blue','Προγρ/νο'], done:['teal','Έγινε'], cancelled:['grey','Ακυρώθηκε']})}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : emptyState('Δεν έχεις προγραμματίσει ραντεβού.', 'events', 'Νέο ραντεβού')}
    </div>
  `;
}

/* =========================================================================
   PROJECTS
   ========================================================================= */
function viewProjects(){
  let list = STATE.projects.slice().sort((a,b)=>(a.deadline||'9999').localeCompare(b.deadline||'9999'));
  list = filterList(list, 'projects', ['title','objective']);
  return `
    ${toolbarHtml('projects', list.length, 'Νέο έργο')}
    <div class="panel">
      ${list.length ? `<table>
        <thead><tr><th>Τίτλος</th><th>Πελάτης</th><th>Κατάσταση</th><th>Προθεσμία</th><th class="num">Έσοδα</th><th class="num">Κόστη</th><th class="num">Περιθώριο</th></tr></thead>
        <tbody>
          ${list.map(p=>{
            const margin = (Number(p.revenue)||0) - (Number(p.costs)||0);
            return `<tr data-open="project:${p.id}">
              <td class="row-title">${esc(p.title)}</td>
              <td class="row-sub">${esc(refLabel('customers', p.customer_id))}</td>
              <td>${statusBadge(p.status, {active:['blue','Ενεργό'], done:['teal','Ολοκληρώθηκε'], paused:['grey','Σε παύση']})}</td>
              <td>${p.deadline ? fmtDateShort(p.deadline) : '—'}</td>
              <td class="num"><span class="cell-label">Έσοδα</span>${fmtMoney(p.revenue||0)}</td>
              <td class="num"><span class="cell-label">Κόστη</span>${fmtMoney(p.costs||0)}</td>
              <td class="num" style="color:${margin>=0?'var(--teal)':'var(--coral)'}"><span class="cell-label">Περιθώριο</span>${fmtMoney(margin)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : emptyState('Δεν έχεις καταχωρήσει έργα.', 'projects', 'Νέο έργο')}
    </div>
  `;
}

/* =========================================================================
   MONEY (tabs: transactions / invoices / payments)
   ========================================================================= */
function viewMoney(){
  const tab = ROUTE.tab || 'transactions';
  const tabs = `
    <div class="tabs">
      <div class="tab ${tab==='transactions'?'active':''}" data-href="#/money/transactions">Συναλλαγές</div>
      <div class="tab ${tab==='invoices'?'active':''}" data-href="#/money/invoices">Τιμολόγια</div>
      <div class="tab ${tab==='payments'?'active':''}" data-href="#/money/payments">Πληρωμές</div>
    </div>
  `;
  const revenue = STATE.transactions.filter(t=>t.transaction_type==='income').reduce((s,t)=>s+(Number(t.gross_amount)||0),0);
  const expenses = STATE.transactions.filter(t=>t.transaction_type==='expense').reduce((s,t)=>s+(Number(t.gross_amount)||0),0);

  let body = '';
  if(tab === 'transactions'){
    let list = STATE.transactions.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    list = filterList(list, 'transactions', ['title','category']);
    body = `
      <div class="hud" style="grid-template-columns: repeat(3,1fr);">
        <div class="hud-cell"><div class="hud-tick teal"></div><div class="hl">Έσοδα</div><div class="hv" style="color:var(--teal)">${fmtMoney(revenue)}</div></div>
        <div class="hud-cell"><div class="hud-tick coral"></div><div class="hl">Έξοδα</div><div class="hv" style="color:var(--coral)">${fmtMoney(expenses)}</div></div>
        <div class="hud-cell"><div class="hud-tick blue"></div><div class="hl">Καθαρό</div><div class="hv">${fmtMoney(revenue-expenses)}</div></div>
      </div>
      ${toolbarHtml('transactions', list.length, 'Νέα συναλλαγή')}
      <div class="panel">
        ${list.length ? `<table>
          <thead><tr><th>Ημ/νία</th><th>Περιγραφή</th><th>Κατηγορία</th><th>Πελάτης/Προμ.</th><th class="num">Ποσό</th><th>Κατάσταση</th></tr></thead>
          <tbody>
            ${list.map(t=>`
              <tr data-open="transaction:${t.id}">
                <td class="mono">${fmtDateShort(t.date)}</td>
                <td class="row-title">${esc(t.title)}</td>
                <td class="row-sub">${esc(t.category||'—')}</td>
                <td class="row-sub">${t.customer_id ? esc(refLabel('customers',t.customer_id)) : (t.supplier_id ? esc(refLabel('suppliers',t.supplier_id)) : '—')}</td>
                <td class="num" style="color:${t.transaction_type==='income'?'var(--teal)':'var(--coral)'}">${t.transaction_type==='income'?'+':'−'}${fmtMoney(Math.abs(t.gross_amount||0), t.currency)}</td>
                <td>${statusBadge(t.payment_status, {paid:['teal','Πληρωμένο'], pending:['amber','Εκκρεμεί']})}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : emptyState('Δεν υπάρχουν συναλλαγές.', 'transactions', 'Νέα συναλλαγή')}
      </div>
    `;
  } else if(tab === 'invoices'){
    let list = STATE.invoices.slice().sort((a,b)=>(a.due_date||'9999').localeCompare(b.due_date||'9999'));
    list = filterList(list, 'invoices', ['invoice_number']);
    body = `
      ${toolbarHtml('invoices', list.length, 'Νέο τιμολόγιο')}
      <div class="panel">
        ${list.length ? `<table>
          <thead><tr><th>Αριθμός</th><th>Πελάτης</th><th>Έκδοση</th><th>Λήξη</th><th class="num">Ποσό</th><th>Κατάσταση</th></tr></thead>
          <tbody>
            ${list.map(i=>{
              const st = autoInvoiceStatus(i);
              return `<tr data-open="invoice:${i.id}">
                <td class="mono row-title">${esc(i.invoice_number)}</td>
                <td class="row-sub">${esc(refLabel('customers', i.customer_id))}</td>
                <td><span class="cell-label">Έκδοση</span>${fmtDateShort(i.issue_date)}</td>
                <td><span class="cell-label">Λήξη</span>${fmtDateShort(i.due_date)}</td>
                <td class="num">${fmtMoney(i.gross_amount, i.currency)}</td>
                <td>${statusBadge(st, {draft:['grey','Πρόχειρο'], unpaid:['blue','Ανεξόφλητο'], paid:['teal','Εξοφλημένο'], overdue:['coral','Ληξιπρόθεσμο']})}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : emptyState('Δεν έχεις εκδώσει τιμολόγια.', 'invoices', 'Νέο τιμολόγιο')}
      </div>
    `;
  } else {
    let list = STATE.payments.slice().sort((a,b)=>(b.payment_date||'').localeCompare(a.payment_date||''));
    body = `
      ${toolbarHtml('payments', list.length, 'Νέα πληρωμή')}
      <div class="panel">
        ${list.length ? `<table>
          <thead><tr><th>Ημ/νία</th><th>Τιμολόγιο</th><th class="num">Ποσό</th><th>Μέθοδος</th></tr></thead>
          <tbody>
            ${list.map(p=>`
              <tr data-open="payment:${p.id}">
                <td class="mono">${fmtDateShort(p.payment_date)}</td>
                <td class="row-title">${esc(refLabel('invoices', p.invoice_id))}</td>
                <td class="num">${fmtMoney(p.amount, p.currency)}</td>
                <td class="row-sub">${esc(p.payment_method||'—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : emptyState('Δεν έχουν καταχωρηθεί πληρωμές.', 'payments', 'Νέα πληρωμή')}
      </div>
    `;
  }
  return tabs + body;
}

/* =========================================================================
   GOALS & KPI
   ========================================================================= */
function viewGoals(){
  const goals = STATE.goals.slice().sort((a,b)=>(a.deadline||'9999').localeCompare(b.deadline||'9999'));
  const kpis = STATE.kpis.slice();
  return `
    <div class="toolbar">
      <div class="stats">${goals.length} στόχοι · ${kpis.length} KPIs</div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-primary" data-add="goals">+ Νέος στόχος</button>
        <button class="btn" data-add="kpis">+ Νέο KPI</button>
      </div>
    </div>
    <div class="grid2">
      <div class="panel">
        <div class="panel-head"><h2>🎯 Στόχοι</h2></div>
        <div class="panel-body pad">
          ${goals.length ? goals.map(g=>{
            const pct = g.target_value ? Math.min(100, Math.round((g.current_value/g.target_value)*100)) : 0;
            return `<div style="margin-bottom:18px; cursor:pointer;" data-open="goal:${g.id}">
              <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                <span style="font-weight:500;">${esc(g.title)}</span>
                <span class="mono" style="font-size:12px; color:var(--text-dim);">${pct}%</span>
              </div>
              <div class="progress-track"><div class="progress-fill" style="width:${pct}%; background:${pct>=100?'var(--teal)':'var(--amber)'}"></div></div>
              <div class="row-sub" style="margin-top:5px;">${fmtMoneyOrUnit(g.current_value,g.unit)} / ${fmtMoneyOrUnit(g.target_value,g.unit)} · ${statusBadge(g.status,{active:['blue','Ενεργός'],done:['teal','Ολοκληρώθηκε'],paused:['grey','Παύση']})} ${g.deadline?(' · έως '+fmtDateShort(g.deadline)):''}</div>
            </div>`;
          }).join('') : emptyState('Δεν έχεις ορίσει στόχους.', 'goals', 'Νέος στόχος')}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>📈 KPIs</h2></div>
        <div class="panel-body">
          ${kpis.length ? `<table><tbody>
            ${kpis.map(k=>`
              <tr data-open="kpi:${k.id}">
                <td><div class="row-title">${esc(k.name)}</div><div class="row-sub">${esc(k.period||'')}</div></td>
                <td class="num mono">${k.actual ?? '—'} / ${k.target ?? '—'} ${esc(k.unit||'')}</td>
              </tr>
            `).join('')}
          </tbody></table>` : emptyState('Δεν έχεις ορίσει KPIs.', 'kpis', 'Νέο KPI')}
        </div>
      </div>
    </div>
  `;
}

/* =========================================================================
   CRM (tabs: customers / suppliers)
   ========================================================================= */
function viewCRM(){
  const tab = ROUTE.tab || 'customers';
  const tabs = `
    <div class="tabs">
      <div class="tab ${tab==='customers'?'active':''}" data-href="#/crm/customers">Πελάτες</div>
      <div class="tab ${tab==='suppliers'?'active':''}" data-href="#/crm/suppliers">Προμηθευτές</div>
    </div>
  `;
  let body = '';
  if(tab === 'customers'){
    let list = STATE.customers.slice();
    list = filterList(list, 'customers', ['name','contact','email','city']);
    body = `
      ${toolbarHtml('customers', list.length, 'Νέος πελάτης')}
      <div class="panel">
        ${list.length ? `<table>
          <thead><tr><th>Επωνυμία</th><th>Επικοινωνία</th><th>Πόλη</th><th>Κατάσταση</th></tr></thead>
          <tbody>
            ${list.map(c=>`
              <tr data-open="customer:${c.id}">
                <td class="row-title">${esc(c.name)}</td>
                <td class="row-sub">${esc(c.contact||'—')} ${c.email?'· '+esc(c.email):''}</td>
                <td class="row-sub">${esc(c.city||'—')}</td>
                <td>${statusBadge(c.status,{lead:['blue','Lead'],active:['teal','Ενεργός'],inactive:['grey','Ανενεργός']})}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : emptyState('Δεν έχεις καταχωρήσει πελάτες.', 'customers', 'Νέος πελάτης')}
      </div>
    `;
  } else {
    let list = STATE.suppliers.slice();
    list = filterList(list, 'suppliers', ['name','contact','email','category']);
    body = `
      ${toolbarHtml('suppliers', list.length, 'Νέος προμηθευτής')}
      <div class="panel">
        ${list.length ? `<table>
          <thead><tr><th>Επωνυμία</th><th>Κατηγορία</th><th>Επικοινωνία</th><th>Κατάσταση</th></tr></thead>
          <tbody>
            ${list.map(s=>`
              <tr data-open="supplier:${s.id}">
                <td class="row-title">${esc(s.name)}</td>
                <td class="row-sub">${esc(s.category||'—')}</td>
                <td class="row-sub">${esc(s.contact||'—')} ${s.email?'· '+esc(s.email):''}</td>
                <td>${statusBadge(s.status,{active:['teal','Ενεργός'],inactive:['grey','Ανενεργός']})}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>` : emptyState('Δεν έχεις καταχωρήσει προμηθευτές.', 'suppliers', 'Νέος προμηθευτής')}
      </div>
    `;
  }
  return tabs + body;
}

/* =========================================================================
   ALERTS
   ========================================================================= */
function viewAlerts(){
  let list = STATE.alerts.slice().sort((a,b)=>{
    if(a.status!==b.status) return a.status==='open' ? -1 : 1;
    const sev = {high:0,medium:1,low:2};
    return (sev[a.severity]??3)-(sev[b.severity]??3);
  });
  list = filterList(list, 'alerts', ['title','reason','related_entity']);
  return `
    ${toolbarHtml('alerts', list.length, 'Νέα ειδοποίηση')}
    <div class="panel">
      ${list.length ? `<table>
        <thead><tr><th>Σοβαρότητα</th><th>Τίτλος</th><th>Σχετίζεται με</th><th>Ημ/νία</th><th>Κατάσταση</th></tr></thead>
        <tbody>
          ${list.map(a=>`
            <tr data-open="alert:${a.id}">
              <td>${severityBadge(a.severity)}</td>
              <td><div class="row-title">${esc(a.title)}</div><div class="row-sub">${esc(a.reason||'')}</div></td>
              <td class="row-sub">${esc(a.related_entity||'—')}</td>
              <td class="mono">${fmtDateShort(a.alert_date)}</td>
              <td>${statusBadge(a.status,{open:['coral','Ανοιχτή'],resolved:['teal','Επιλύθηκε']})}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : emptyState('Καμία ειδοποίηση. Όλα καθαρά.', 'alerts', 'Νέα ειδοποίηση')}
    </div>
  `;
}

/* =========================================================================
   INTEGRATIONS
   ========================================================================= */
function viewIntegrations(){
  let list = STATE.integrations.slice();
  list = filterList(list, 'integrations', ['name','provider']);
  return `
    ${toolbarHtml('integrations', list.length, 'Νέα σύνδεση')}
    <div class="panel">
      ${list.length ? `<table>
        <thead><tr><th>Όνομα</th><th>Πάροχος</th><th>Κατεύθυνση</th><th>Κατάσταση</th></tr></thead>
        <tbody>
          ${list.map(i=>`
            <tr data-open="integration:${i.id}">
              <td class="row-title">${esc(i.name)}</td>
              <td class="row-sub">${esc(i.provider||'—')}</td>
              <td class="row-sub">${esc({inbound:'Εισερχόμενη',outbound:'Εξερχόμενη',bidirectional:'Αμφίδρομη'}[i.direction]||i.direction||'—')}</td>
              <td>${statusBadge(i.status,{planned:['grey','Σχεδιασμένη'],mocked:['blue','Mock'],implemented:['amber','Υλοποιημένη'],tested:['teal','Ελεγμένη']})}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>` : emptyState('Δεν έχεις καταχωρήσει συνδέσεις.', 'integrations', 'Νέα σύνδεση')}
    </div>
  `;
}

/* =========================================================================
   SETTINGS — Owner & Business
   ========================================================================= */
function viewSettings(){
  const o = STATE.owner, b = STATE.business;
  return `
    <div class="grid2">
      <div class="panel">
        <div class="panel-head"><h2>👤 Owner</h2></div>
        <div class="panel-body pad">
          <div class="owner-hero">
            <div class="avatar">${esc((o.name||'?').slice(0,1).toUpperCase())}</div>
            <div><h2>${esc(o.name||'—')}</h2><div class="sub">${esc(o.working_hours_start||'—')}–${esc(o.working_hours_end||'—')} ώρες εργασίας</div></div>
          </div>
          <div class="section-title">Προτεραιότητες</div>
          <div class="prose">${esc(o.priorities || '—')}</div>
          <div class="section-title">Τρέχουσα εστίαση</div>
          <div class="prose">${esc(o.current_focus || '—')}</div>
          <div style="margin-top:16px;"><button class="btn btn-sm" id="edit-owner-btn">Επεξεργασία</button></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>🏢 Business</h2></div>
        <div class="panel-body pad">
          <div class="owner-hero">
            <div class="avatar">${esc((b.name||'?').slice(0,1).toUpperCase())}</div>
            <div><h2>${esc(b.name||'—')}</h2><div class="sub">${esc(b.industry||'—')} · ${esc(b.city||'')}, ${esc(b.country||'')}</div></div>
          </div>
          <div class="kv">
            <dt>Νομική μορφή</dt><dd>${esc(b.legal_form||'—')}</dd>
            <dt>Νόμισμα</dt><dd>${esc(b.currency||'EUR')}</dd>
          </div>
          <div class="section-title">Αποστολή</div>
          <div class="prose">${esc(b.mission || '—')}</div>
          <div class="section-title">Τρέχουσες προτεραιότητες</div>
          <div class="prose">${esc(b.current_priorities || '—')}</div>
          <div style="margin-top:16px;"><button class="btn btn-sm" id="edit-business-btn">Επεξεργασία</button></div>
        </div>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------
   SINGLETON SCHEMAS — Owner & Business (no id list, single object)
   --------------------------------------------------------------------- */
SCHEMAS.owner = {
  key: '_owner', label: 'Owner', labelPlural: 'Owner', singleton: true,
  fields: [
    {key:'name', label:'Όνομα', type:'text', required:true, full:true},
    {key:'working_hours_start', label:'Ώρα έναρξης', type:'text', placeholder:'09:00'},
    {key:'working_hours_end', label:'Ώρα λήξης', type:'text', placeholder:'18:00'},
    {key:'priorities', label:'Προτεραιότητες (μία ανά γραμμή)', type:'textarea', full:true},
    {key:'personal_goals', label:'Προσωπικοί στόχοι', type:'textarea', full:true},
    {key:'focus_hours', label:'Ώρες εστίασης', type:'text', full:true},
    {key:'meeting_preferences', label:'Προτιμήσεις meetings', type:'text', full:true},
    {key:'notification_preferences', label:'Προτιμήσεις ειδοποιήσεων', type:'text', full:true},
    {key:'current_focus', label:'Τρέχουσα εστίαση', type:'textarea', full:true},
  ]
};
SCHEMAS.business = {
  key: '_business', label: 'Business', labelPlural: 'Business', singleton: true,
  fields: [
    {key:'name', label:'Επωνυμία', type:'text', required:true, full:true},
    {key:'industry', label:'Κλάδος', type:'text'},
    {key:'legal_form', label:'Νομική μορφή', type:'text'},
    {key:'city', label:'Πόλη', type:'text'},
    {key:'country', label:'Χώρα', type:'text'},
    {key:'currency', label:'Νόμισμα', type:'text', default:'EUR'},
    {key:'mission', label:'Αποστολή', type:'textarea', full:true},
    {key:'business_model', label:'Business model', type:'textarea', full:true},
    {key:'revenue_streams', label:'Πηγές εσόδων', type:'textarea', full:true},
    {key:'current_priorities', label:'Τρέχουσες προτεραιότητες (μία ανά γραμμή)', type:'textarea', full:true},
    {key:'key_constraints', label:'Βασικοί περιορισμοί', type:'textarea', full:true},
    {key:'notes', label:'Σημειώσεις', type:'textarea', full:true},
  ]
};

function openSingletonModal(kind){
  const schema = SCHEMAS[kind];
  const data = JSON.parse(JSON.stringify(STATE[kind] || {}));
  MODAL_STATE = { schemaKey: kind, id: '__singleton__', draft: data, isSingleton: true };
  renderModal();
}

/* override save logic to branch for singleton */
const _origSaveModal = saveModal;
saveModal = function(){
  if(MODAL_STATE && MODAL_STATE.isSingleton){
    const schema = SCHEMAS[MODAL_STATE.schemaKey];
    for(const f of schema.fields){
      if(f.required && !MODAL_STATE.draft[f.key]){
        toast('Συμπλήρωσε το πεδίο: ' + f.label, true);
        return;
      }
    }
    STATE[MODAL_STATE.schemaKey] = MODAL_STATE.draft;
    saveState();
    toast(schema.label + ' ενημερώθηκε.');
    closeModal();
    render();
    return;
  }
  _origSaveModal();
};

/* override modal head/foot rendering for singleton (no delete button) */
const _origRenderModal = renderModal;
renderModal = function(){
  _origRenderModal();
  if(MODAL_STATE && MODAL_STATE.isSingleton){
    const delBtn = document.getElementById('modal-delete-btn');
    if(delBtn) delBtn.remove();
  }
};

/* ---------------------------------------------------------------------
   OPEN ENTITY (row click -> edit modal)
   --------------------------------------------------------------------- */
function openEntity(type, id){
  if(SCHEMAS[type]) openModal(type, id);
}

/* ---------------------------------------------------------------------
   VIEW EVENT BINDINGS
   --------------------------------------------------------------------- */
function bindViewEvents(){
  // tab / sub-nav links
  document.querySelectorAll('.tab[data-href]').forEach(el=>{
    el.addEventListener('click', ()=>{ location.hash = el.getAttribute('data-href'); });
  });
  // row open
  document.querySelectorAll('[data-open]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      const [type, id] = el.getAttribute('data-open').split(':');
      openEntity(type, id);
    });
  });
  // add buttons
  document.querySelectorAll('[data-add]').forEach(el=>{
    el.addEventListener('click', ()=>{ openModalSmart(el.getAttribute('data-add')); });
  });
  // search inputs
  Object.keys(SEARCH).length; // no-op
  ['tasks','events','transactions','invoices','payments','customers','suppliers','projects','alerts','integrations','goals','kpis'].forEach(k=>{
    const el = document.getElementById('search-'+k);
    if(el){
      el.addEventListener('input', ()=>{ SEARCH[k] = el.value; render(); setTimeout(()=>{ const e2=document.getElementById('search-'+k); if(e2){ e2.focus(); e2.selectionStart=e2.selectionEnd=e2.value.length; } }); });
    }
  });
  // task quick-toggle checkboxes (dashboard + list)
  document.querySelectorAll('[data-task-done]').forEach(cb=>{
    cb.addEventListener('click', (e)=>{
      e.stopPropagation();
      const id = cb.getAttribute('data-task-done');
      const t = findById(STATE.tasks, id);
      if(t){ t.status = cb.checked ? 'done' : 'todo'; saveState(); toast(cb.checked ? 'Η εργασία ολοκληρώθηκε.' : 'Η εργασία επανήλθε σε εκκρεμότητα.'); render(); }
    });
  });
  const eo = document.getElementById('edit-owner-btn');
  if(eo) eo.addEventListener('click', ()=> openSingletonModal('owner'));
  const eb = document.getElementById('edit-business-btn');
  if(eb) eb.addEventListener('click', ()=> openSingletonModal('business'));
}

/* map plural add-buttons (state array keys) to schema keys */
const ADD_KEY_MAP = { tasks:'task', events:'event', transactions:'transaction', invoices:'invoice', payments:'payment', customers:'customer', suppliers:'supplier', projects:'project', alerts:'alert', integrations:'integration', goals:'goal', kpis:'kpi' };
function openModalSmart(stateKey){
  const schemaKey = ADD_KEY_MAP[stateKey];
  if(schemaKey) openModal(schemaKey, null);
}
