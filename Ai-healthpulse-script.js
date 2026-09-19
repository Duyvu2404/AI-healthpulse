const HP_NAVIGATION_TYPE = (()=>{
  try{
    const entry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if(entry && entry.type) return entry.type;
    return performance.navigation && performance.navigation.type === 1 ? 'reload' : 'navigate';
  }catch(e){ return 'navigate'; }
})();
const HP_IS_RELOAD = HP_NAVIGATION_TYPE === 'reload';
const SHEETS_API_URL = "https://script.google.com/macros/s/AKfycby3etu9J1o-lY_V5xIXKrD59vYA21Cq4Z0tg-rST3hCI7KDu5HRL5uraFAr-K58X7Aw/exec";
  window.__SHEETS_READY = !!SHEETS_API_URL && !SHEETS_API_URL.startsWith("ĐIỀN_");

  function sheetsCollection(path){
    const base = SHEETS_API_URL;
    async function post(body){
      const res = await fetch(base, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(body) });
      return await res.json();
    }
    async function listDocs(){
      const res = await fetch(base + '?action=list&collection=' + encodeURIComponent(path));
      const j = await res.json();
      return (j.docs || []).map(d=>({ id:String(d.id), data: ()=>d.data }));
    }
    const api = {
      doc(id){
        id = id || (Date.now() + '_' + Math.random().toString(36).slice(2,8));
        return {
          id,
          async get(){
            const res = await fetch(base + '?action=get&collection=' + encodeURIComponent(path) + '&id=' + encodeURIComponent(id));
            const j = await res.json();
            return { id, exists: !!j.exists, data: ()=>j.data };
          },
          async set(data){ await post({ action:'set', collection:path, id, data }); },
          async update(patch){ await post({ action:'update', collection:path, id, data:patch }); },
          async delete(){ await post({ action:'delete', collection:path, id }); }
        };
      },
      async add(data){
        const j = await post({ action:'add', collection:path, data });
        return api.doc(j.id);
      },
      async get(){
        const docs = await listDocs();
        return { docs, empty: docs.length===0 };
      },
      onSnapshot(next, err){
        let stopped = false;
        const run = async ()=>{ if(stopped) return; try{ next(await api.get()); }catch(e){ if(err) err(e); } };
        run();
        const interval = setInterval(run, 4000);
        return ()=>{ stopped = true; clearInterval(interval); };
      }
    };
    return api;
  }

/* =================== AI backend (Claude / Gemini) =================== */
let sampleFn = null, dbFn = null;
function blobToBase64(blob){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(blob); }); }

const AIBackend = {
  mode:'none', geminiKey:null,
  async init(){
    if(sampleFn){ this.mode='claude'; this.geminiKey=null; return; }
    // API keys are loaded after the student account is restored. Do not use a
    // single global browser key: that would leak one student's key to another.
    this.geminiKey = null;
    this.mode = 'none';
  },
  useAccountKey(account){
    if(sampleFn){ this.mode='claude'; this.geminiKey=null; return; }
    const accountKey = account && (account.geminiApiKey || account.apiKey || account.geminiKey);
    const cacheKey = account && account.username ? 'hp_gemini_key:' + (account.role === 'admin' ? 'admin:' : '') + account.username : null;
    const legacyStudentKey = account && account.role === 'student' && account.username ? localStorage.getItem('hp_gemini_key:'+account.username) : null;
    const cachedKey = cacheKey ? localStorage.getItem(cacheKey) : legacyStudentKey;
    this.geminiKey = accountKey || cachedKey || null;
    this.mode = this.geminiKey ? 'gemini' : 'none';
    if(this.geminiKey && cacheKey){
      localStorage.setItem(cacheKey, this.geminiKey);
    }
  },
  useStudentKey(student){ this.useAccountKey(student ? Object.assign({role:'student'}, student) : null); },
  async json(prompt){
    if(this.mode==='claude') return await sampleFn.json(prompt, {modelTier:'quick'});
    if(this.mode==='gemini'){ const raw = await this._geminiCall(prompt + '\n\nChỉ trả JSON hợp lệ, không kèm chữ nào khác, không dùng markdown code fence.'); return JSON.parse(raw.replace(/```json|```/g,'').trim()); }
    throw {code:'no_ai'};
  },
  async text(prompt){
    if(this.mode==='claude'){ const r = await sampleFn(prompt, {modelTier:'default'}); return r.text; }
    if(this.mode==='gemini') return await this._geminiCall(prompt);
    throw {code:'no_ai'};
  },
  async _geminiCall(prompt){
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(this.geminiKey), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({contents:[{parts:[{text:prompt}]}]})
    });
    if(!res.ok) throw {code:'gemini_http_'+res.status};
    const data = await res.json();
    return ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p=>p.text||'').join('');
  }
};

/* =================== DB backend (Claude db / localStorage fallback) =================== */
function localCollection(path){
  const read = ()=>{ try{ return JSON.parse(localStorage.getItem('hpdb:'+path) || '{}'); }catch(e){ return {}; } };
  const write = (obj)=> localStorage.setItem('hpdb:'+path, JSON.stringify(obj));
  const api = {
    doc(id){ id = id || ('id_'+Date.now()+'_'+Math.random().toString(36).slice(2,8));
      return { id,
        async set(data){ const all=read(); all[id]=data; write(all); },
        async update(patch){ const all=read(); all[id]=Object.assign({}, all[id] || {}, patch); write(all); },
        async get(){ const all=read(); return {id, exists: !!all[id], data:()=>all[id]}; },
        async delete(){ const all=read(); delete all[id]; write(all); }
      };
    },
    async add(data){ const ref = api.doc(); await ref.set(data); return ref; },
    async get(){ const all = read(); const docs = Object.keys(all).map(id=>({id, data:()=>all[id]})); return {docs, empty:docs.length===0}; },
    onSnapshot(next, err){
      let stopped=false;
      const run=async()=>{ if(stopped) return; try{ next(await api.get()); }catch(e){ if(err) err(e); } };
      run();
      const handler=(e)=>{ if(e.key==='hpdb:'+path) run(); };
      window.addEventListener('storage', handler);
      return ()=>{ stopped=true; window.removeEventListener('storage', handler); };
    }
  };
  return api;
}
const DB = {
  mode:'none',
  init(){
    if(dbFn) this.mode='claude';
    else if(window.__SHEETS_READY) this.mode='sheets';
    else this.mode='local';
  },
  collection(path){
    if(this.mode==='claude') return dbFn.collection(path);
    if(this.mode==='sheets') return sheetsCollection(path);
    return localCollection(path);
  }
};

function $(id){return document.getElementById(id);}
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2400); }
function refreshIcons(){ try{ lucide.createIcons(); }catch(e){} }
function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

async function bootAI(){
  try{
    if(window.claude && window.claude.use){ sampleFn = await window.claude.use('sample'); dbFn = await window.claude.use('db'); }
  }catch(e){}
  await AIBackend.init();
  DB.init();
  refreshIcons();
  try{ await AdminAuth.tryRestore(); }catch(e){}
  if(!state.admin){ try{ await StudentAuth.tryRestore(); }catch(e){} }
  if(HP_IS_RELOAD && getActiveAccount() && hpReadStorage(sessionStorage,'hp_last_view',null)==='view-chat') App.goChat();
}
/* =================== Cài đặt AI (khi chạy ngoài Claude) =================== */
const Settings = {
  open(options={}){
    const auto = options.auto === true;
    const body = $('settingsBody');
    let html = '';
    if(AIBackend.mode==='claude'){
      html += '<p>Trang đang chạy bên trong Claude — AI hoạt động sẵn, không cần nhập gì thêm.</p>';
    } else if(!getActiveAccount()){
      html += '<p>Em cần đăng nhập tài khoản trước khi lưu API Key Gemini.</p>';
    } else {
      const account = getActiveAccount();
      const accountLabel = account.role === 'admin' ? 'quản trị viên' : 'học sinh';
      const masked = AIBackend.geminiKey ? (AIBackend.geminiKey.slice(0,6) + '••••••••') : '';
      if(auto && !masked){
        html += '<div class="api-auto-note"><strong>Tài khoản này chưa có API Key.</strong><span>Em dán API Key Gemini một lần; hệ thống sẽ lưu theo tài khoản '+accountLabel+' để lần sau đăng nhập ở máy khác vẫn dùng được.</span></div>';
      } else {
        html += '<p>Để chatbot hoạt động thông minh, em cần một API Key Gemini. Khóa sẽ được lưu theo tài khoản '+accountLabel+' này, không dùng chung với tài khoản khác.</p>';
      }
      html +=
        '<p style="margin-top:8px;">1. Mở <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> và đăng nhập Google<br/>2. Bấm "Create API key", sao chép khóa<br/>3. Dán vào ô bên dưới</p>' +
        (masked ? '<div class="field" style="margin-top:12px;"><label class="field-label">Khóa hiện tại</label><input type="text" value="'+masked+'" disabled /></div>' : '') +
        '<div class="field" style="margin-top:12px;"><label class="field-label">Dán API Key Gemini</label><input type="password" id="geminiKeyInput" placeholder="AIza..." /></div>' +
        '<div style="display:flex;gap:10px;margin-top:6px;">' +
        '<button class="btn btn-primary btn-sm" onclick="Settings.save()">Lưu khóa</button>' +
        (AIBackend.geminiKey ? '<button class="btn btn-ghost btn-sm" onclick="Settings.clear()">Xóa khóa</button>' : '') + '</div>';
    }
    const dbLabel = {claude:'Claude (dùng chung, sẵn có)', sheets:'Google Sheets (dùng chung thật, đã kết nối)', local:'Chỉ lưu trên trình duyệt này — CHƯA dùng chung được giữa nhiều máy'}[DB.mode];
    html += '<div class="status-line"><span class="status-dot '+(DB.mode==='local'?'off':'on')+'"></span>Dữ liệu: '+dbLabel+'</div>';
    if(DB.mode==='local'){
      html += '<div class="status-line" style="margin-top:4px;">Để dữ liệu dùng chung thật giữa nhiều học sinh/thiết bị, cần kết nối Google Sheets — nhờ thầy/cô phụ trách kỹ thuật điền URL Apps Script vào file trang web.</div>';
    }
    body.innerHTML = html;
    $('settingsModal').classList.remove('hidden');
    const input = $('geminiKeyInput');
    if(input) setTimeout(()=>input.focus(), 50);
  },
  maybeOpenForStudent(){
    if(!state.student) return;
    this.maybeOpenForAccount();
  },
  maybeOpenForAccount(){
    const account = getActiveAccount();
    if(AIBackend.mode==='claude' || !account || AIBackend.geminiKey) return;
    setTimeout(()=>{
      if(account.role === 'admin') toast('Tài khoản admin chưa kích hoạt API Gemini.');
      this.open({auto:true});
    }, 180);
  },
  close(){ $('settingsModal').classList.add('hidden'); },
  async save(){
    const input = $('geminiKeyInput');
    const v = input ? input.value.trim() : '';
    if(!v){ toast('Dán API key vào trước nhé'); return; }
    const account = getActiveAccount();
    if(!account){ toast('Em đăng nhập tài khoản trước nhé'); return; }
    try{
      const collection = account.role === 'admin' ? 'admins' : 'students';
      await DB.collection(collection).doc(account.username).update({ geminiApiKey:v, apiKeyUpdatedAt:Date.now() });
      account.data.geminiApiKey = v;
      AIBackend.useAccountKey(account.data);
      toast('Đã lưu API theo tài khoản — AI sẵn sàng!');
      Settings.close();
    }catch(e){ toast('Chưa lưu được API, em thử lại nhé'); }
  },
  async clear(){
    const account = getActiveAccount();
    if(!account) return;
    try{
      const collection = account.role === 'admin' ? 'admins' : 'students';
      await DB.collection(collection).doc(account.username).update({ geminiApiKey:null, apiKeyUpdatedAt:Date.now() });
      account.data.geminiApiKey = null;
      localStorage.removeItem('hp_gemini_key:' + (account.role === 'admin' ? 'admin:' : '') + account.username);
      AIBackend.useAccountKey(account.data);
      toast('Đã xóa API khỏi tài khoản'); Settings.close();
    }catch(e){ toast('Chưa xóa được API, em thử lại nhé'); }
  }
};

/* =================== steps nav =================== */
const STEPS = [
  {id:'view-landing', label:'Home'},
  {id:'view-chat', label:'Chatbot'}
];
function getNavigationSteps(){
  const steps = STEPS.slice();
  if(state.admin) steps.push({id:'view-adminHome', label:'Dashboard'});
  return steps;
}
function renderSteps(activeId){
  const nav = $('stepNav'); nav.innerHTML = '';
  const steps = getNavigationSteps();
  const activeIdx = steps.findIndex(x=>x.id===activeId);
  steps.forEach((s,i)=>{
    if(i>0){ const c=document.createElement('div'); c.className='step-connector'+(i<=activeIdx?' done':''); nav.appendChild(c); }
    const el = document.createElement('button');
    el.type = 'button';
    let cls='step'; if(s.id===activeId) cls+=' active'; else if(i<activeIdx) cls+=' done';
    el.className = cls;
    el.innerHTML = '<span class="dot"></span><span class="step-label">'+s.label+'</span>';
    el.addEventListener('click', ()=>{
      if(s.id === 'view-chat') App.goChat();
      else if(s.id === 'view-adminHome'){
        if(!state.admin) return App.goAdminAuth();
        showView('view-adminHome');
        if(typeof AdminNav !== 'undefined') AdminNav.switchTab('overview');
      }else App.goLanding();
    });
    nav.appendChild(el);
  });
}
function showView(id){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  const view = $(id); if(!view) return;
  view.classList.add('active');
  if(id==='view-landing' || id==='view-chat') hpWriteStorage(sessionStorage,'hp_last_view',id);
  renderSteps(id);
  const settingsBtn = $('settingsBtn');
  if(settingsBtn) settingsBtn.classList.toggle('hidden', id!=='view-chat');
  if(typeof StudentAuth !== 'undefined' && StudentAuth.renderSession) StudentAuth.renderSession();
  window.scrollTo({top:0,behavior:'smooth'});
  refreshIcons();
}

/* =================== state =================== */
const state = { khoi:null, pendingKhoi:null, pendingSurvey:false, hdtl:{ qIndex:0, attempts:0, extracted:{}, computed:null, docRef:null }, admin:null, student:null };
const DEFAULT_ADMIN = { username: 'admin', password: 'HealthPulse@2026' }; // tài khoản dựng sẵn — không phải bảo mật thật, đổi nếu cần

function getActiveAccount(){
  if(state.admin) return { role:'admin', username:state.admin.username, displayName:state.admin.displayName || state.admin.username, khoi:'', data:state.admin };
  if(state.student) return { role:'student', username:state.student.username, displayName:state.student.displayName || state.student.username, khoi:state.student.khoi || '', data:state.student };
  return null;
}

function normaliseIdentity(value){
  return String(value || '').trim().replace(/\s+/g,' ').toLocaleLowerCase('vi-VN');
}

async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

const App = {
  goLanding(){
    state.pendingKhoi = null;
    state.pendingSurvey = false;
    showView('view-landing');
    if(typeof AccountMenu !== 'undefined') AccountMenu.render();
  },
  goChat(){
    if(!getActiveAccount()){ this.goStudentAuth('login'); return; }
    showView('view-chat');
    if(typeof ChatHistory !== 'undefined') ChatHistory.openCurrent({adminFreeform:!!state.admin});
    if(typeof Settings !== 'undefined') Settings.maybeOpenForAccount();
  },
  goLibrary(){ showView('view-library'); Library.load(); },
  goAdminAuth(){ if(state.admin){ AdminAuth.onLoggedIn(); } else { showView('view-adminAuth'); } },
  goStudentAuth(mode){
    StudentAuth.switchTab(mode || 'login');
    showView('view-studentAuth');
    StudentAuth.prefillGrade();
  },
  startSurvey(){
    const khoi = $('khoiSelect').value;
    if(!khoi){ $('startErr').textContent = 'Em chọn khối lớp giúp mình nhé.'; return; }
    $('startErr').textContent = '';
    state.pendingKhoi = khoi;
    if(state.admin && !state.student){
      toast('Tài khoản admin có thể trò chuyện trực tiếp với Chatbot.');
      App.goChat();
      return;
    }
    if(!state.student){
      state.pendingSurvey = true;
      App.goStudentAuth('login');
      return;
    }
    App.beginSurvey();
  },
  beginSurvey(){
    const khoi = state.pendingKhoi || $('khoiSelect').value || (state.student && state.student.khoi);
    if(!khoi){ showView('view-landing'); $('startErr').textContent = 'Em chọn khối lớp giúp mình nhé.'; return; }
    state.khoi = khoi;
    state.pendingKhoi = null;
    state.pendingSurvey = false;
    if(typeof ChatHistory !== 'undefined') ChatHistory.ensureCurrent(khoi, {newIfCompleted:true});
    showView('view-chat');
    Hdtl.start();
    Settings.maybeOpenForStudent();
  }
};

/* =================== menu tài khoản trên thanh điều hướng =================== */
const AccountMenu = {
  toggle(){
    const menu = $('accountMenu');
    const btn = $('accountMenuBtn');
    if(!menu || !btn) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
    if(willOpen) refreshIcons();
  },
  close(){
    const menu = $('accountMenu');
    const btn = $('accountMenuBtn');
    if(menu) menu.classList.add('hidden');
    if(btn) btn.setAttribute('aria-expanded','false');
  },
  openStudent(){ this.close(); App.goStudentAuth('login'); },
  openTeacher(){ this.close(); App.goAdminAuth(); },
  logout(){
    const account = getActiveAccount();
    if(account && account.role === 'student') StudentAuth.logout();
    else if(account && account.role === 'admin') AdminAuth.logout();
    this.close();
  },
  render(){
    const label = $('accountMenuLabel');
    const session = $('accountMenuSession');
    const logoutBtn = $('topbarLogoutBtn');
    if(!label || !session) return;
    const account = getActiveAccount();
    if(account && account.role === 'student'){
      label.textContent = account.displayName;
      session.classList.remove('hidden');
      session.innerHTML = '<strong>Đang dùng tài khoản học sinh: '+escapeHtml(account.username)+'</strong>';
      if(logoutBtn){ logoutBtn.classList.remove('hidden'); logoutBtn.onclick = ()=>this.logout(); }
    }else if(account && account.role === 'admin'){
      label.textContent = 'GV: ' + account.username;
      session.classList.remove('hidden');
      session.innerHTML = '<strong>Đang dùng tài khoản giáo viên: '+escapeHtml(account.username)+'</strong>';
      if(logoutBtn){ logoutBtn.classList.remove('hidden'); logoutBtn.onclick = ()=>this.logout(); }
    }else{
      label.textContent = 'Đăng nhập';
      session.classList.add('hidden');
      session.innerHTML = '';
      if(logoutBtn){ logoutBtn.classList.add('hidden'); logoutBtn.onclick = null; }
    }
    refreshIcons();
  }
};

document.addEventListener('click', (event)=>{
  if(!event.target.closest('.account-menu-wrap')) AccountMenu.close();
});

/* =================== tư liệu tham khảo (công khai) =================== */
function domainOf(url){ try{ return new URL(url).hostname.replace(/^www\./,''); }catch(e){ return url; } }
function libCardHtml(doc, id, withDelete){
  const safeUrl = escapeHtml(doc.url||'#');
  let html = '<div class="lib-card">' +
    '<div class="lib-title"><i data-lucide="book-open" style="width:17px;height:17px;"></i>'+escapeHtml(doc.title||'')+'</div>';
  if(doc.desc) html += '<div class="lib-desc">'+escapeHtml(doc.desc)+'</div>';
  html += '<span class="lib-domain">'+escapeHtml(domainOf(doc.url||''))+'</span>' +
    '<a class="lib-link" href="'+safeUrl+'" target="_blank" rel="noopener">Xem tài liệu <i data-lucide="arrow-up-right" style="width:13px;height:13px;"></i></a>';
  if(withDelete) html += '<button class="lib-del" onclick="AdminLibrary.remove(\''+id+'\')">Xóa tài liệu này</button>';
  html += '</div>';
  return html;
}
const Library = {
  async load(){
    const box = $('libraryList');
    box.innerHTML = '<div class="empty-lib">Đang tải…</div>';
    try{
      const snap = await DB.collection('references').get();
      if(snap.empty){ box.innerHTML = '<div class="empty-lib">Chưa có tư liệu nào được đăng.</div>'; return; }
      const docs = snap.docs.map(d=>({id:d.id, data:d.data()})).sort((a,b)=>(b.data.addedAt||0)-(a.data.addedAt||0));
      box.innerHTML = docs.map(d=>libCardHtml(d.data, d.id, false)).join('');
      refreshIcons();
    }catch(e){ box.innerHTML = '<div class="empty-lib">Không thể tải tư liệu lúc này.</div>'; }
  }
};

/* =================== admin: đăng nhập & quản lý tư liệu =================== */
const AdminAuth = {
  async submit(){
    const username = $('adminUsername').value.trim().toLowerCase();
    const password = $('adminPassword').value;
    const err = $('adminErr'); err.textContent = '';
    if(!username || password.length < 4){ err.textContent = 'Tên đăng nhập và mật khẩu (≥4 ký tự) là bắt buộc.'; return; }
    if(username !== DEFAULT_ADMIN.username && !/^[a-z0-9._-]{3,32}$/.test(username)){ err.textContent = 'Tên đăng nhập không hợp lệ.'; return; }
    if(username === DEFAULT_ADMIN.username && password === DEFAULT_ADMIN.password){
      state.admin = { username: DEFAULT_ADMIN.username, createdAt: null, builtin: true };
      localStorage.setItem('hp_admin_session', username);
      try{
        await DB.collection('admins').doc(username).set({
          username,
          role:'admin',
          passwordHash:await sha256(password),
          builtin:true,
          createdAt:null,
          lastLoginAt:Date.now()
        });
      }catch(e){}
      await AdminAuth.onLoggedIn();
      return;
    }
    try{
      const snap = await DB.collection('admins').doc(username).get();
      if(!snap.exists){ err.textContent = 'Không tìm thấy tài khoản quản trị này.'; return; }
      const data = snap.data();
      if(await sha256(password) !== data.passwordHash){ err.textContent = 'Sai mật khẩu.'; return; }
      state.admin = data; localStorage.setItem('hp_admin_session', username);
      try{ await DB.collection('admins').doc(username).update({lastLoginAt:Date.now()}); }catch(e){}
      await AdminAuth.onLoggedIn();
    }catch(e){ err.textContent = 'Có lỗi khi đăng nhập, thử lại nhé.'; }
  },
  async onLoggedIn(){
    if(state.student){
      state.student = null;
      AIBackend.useStudentKey(null);
      localStorage.removeItem('hp_student_session');
    }
    AIBackend.useAccountKey(state.admin);
    if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForAccount();
    $('adminNameChip').textContent = state.admin.username;
    AccountMenu.render();
    toast('Xin chào, ' + state.admin.username + '!');
    showView('view-adminHome');
    AdminNav.switchTab('overview');
  },
  logout(){
    if(typeof ChatHistory !== 'undefined') ChatHistory.forgetSession();
    state.admin = null; localStorage.removeItem('hp_admin_session');
    AccountMenu.render();
    showView('view-landing');
  },
  async tryRestore(){
    const saved = localStorage.getItem('hp_admin_session');
    if(!saved) return;
    if(saved === DEFAULT_ADMIN.username){
      state.admin = { username: DEFAULT_ADMIN.username, createdAt: null, builtin: true };
      AIBackend.useAccountKey(state.admin);
      AccountMenu.render();
      renderSteps('view-landing');
      if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForAccount();
      return;
    }
    try{
      const snap = await DB.collection('admins').doc(saved).get();
      if(snap.exists){
        state.admin = snap.data();
        AIBackend.useAccountKey(state.admin);
        AccountMenu.render();
        renderSteps('view-landing');
        if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForAccount();
      }
    }catch(e){}
  }
};

/* =================== học sinh: đăng nhập & tạo tài khoản =================== */
const StudentAuth = {
  setStudent(data, fallbackUsername){
    const username = data.username || fallbackUsername;
    state.student = {
      username,
      displayName:data.displayName || username,
      khoi:data.khoi || '',
      role:'student',
      createdAt:data.createdAt || null,
      geminiApiKey:data.geminiApiKey || data.apiKey || data.geminiKey || null
    };
    AIBackend.useStudentKey(state.student);
  },
  switchTab(tab){
    const isRegister = tab === 'register';
    const isForgot = tab === 'forgot';
    $('studentAuthTabs').classList.toggle('hidden', isForgot);
    $('studentTabLogin').classList.toggle('active', !isRegister);
    $('studentTabRegister').classList.toggle('active', isRegister);
    $('studentNameField').classList.toggle('hidden', !(isRegister || isForgot));
    $('studentGradeField').classList.toggle('hidden', !(isRegister || isForgot));
    $('studentConfirmField').classList.toggle('hidden', !(isRegister || isForgot));
    $('studentAuthTitle').textContent = isRegister ? 'Tạo tài khoản học sinh' : (isForgot ? 'Quên mật khẩu học sinh' : 'Đăng nhập học sinh');
    $('studentAuthSubtitle').textContent = isRegister ? 'Tạo tài khoản để bắt đầu khảo sát hoạt động thể lực.' : (isForgot ? 'Nhập đúng thông tin đã dùng khi tạo tài khoản để đặt mật khẩu mới.' : 'Đăng nhập để bắt đầu khảo sát hoạt động thể lực.');
    $('studentSubmitBtn').textContent = isRegister ? 'Tạo tài khoản học sinh' : (isForgot ? 'Đặt lại mật khẩu' : 'Đăng nhập');
    $('studentSubmitBtn').dataset.mode = tab;
    const passwordLabel = $('studentPasswordLabel');
    const confirmLabel = $('studentPasswordConfirmLabel');
    if(passwordLabel) passwordLabel.textContent = isForgot ? 'Mật khẩu mới' : 'Mật khẩu';
    if(confirmLabel) confirmLabel.textContent = isForgot ? 'Nhập lại mật khẩu mới' : 'Nhập lại mật khẩu';
    $('studentPassword').setAttribute('autocomplete', isRegister || isForgot ? 'new-password' : 'current-password');
    $('studentAuthSwitch').innerHTML = isRegister
      ? 'Đã có tài khoản? <button onclick="StudentAuth.switchTab(\'login\')">Đăng nhập</button>'
      : (isForgot
        ? '<button onclick="StudentAuth.switchTab(\'login\')">Quay lại đăng nhập</button>'
        : 'Chưa có tài khoản? <button onclick="StudentAuth.switchTab(\'register\')">Tạo tài khoản học sinh</button> · <button onclick="StudentAuth.switchTab(\'forgot\')">Quên mật khẩu?</button>');
    $('studentErr').textContent = '';
    if(isRegister || isForgot) this.prefillGrade();
    refreshIcons();
  },
  prefillGrade(){
    const preferred = state.pendingKhoi || $('khoiSelect').value || '';
    if(preferred && $('studentGrade')) $('studentGrade').value = preferred;
  },
  async submit(){
    const mode = $('studentSubmitBtn').dataset.mode || 'login';
    const isRegister = mode === 'register';
    const isForgot = mode === 'forgot';
    const username = $('studentUsername').value.trim().toLowerCase();
    const password = $('studentPassword').value;
    const err = $('studentErr'); err.textContent = '';
    if(!/^[a-z0-9._-]{3,24}$/.test(username)){
      err.textContent = 'Tên đăng nhập cần 3–24 ký tự không dấu (chữ, số, ., _ hoặc -).'; return;
    }
    if(password.length < 6){ err.textContent = 'Mật khẩu cần ít nhất 6 ký tự.'; return; }
    if(isRegister || isForgot){
      const displayName = $('studentName').value.trim();
      const khoi = $('studentGrade').value;
      const confirm = $('studentPasswordConfirm').value;
      if(displayName.length < 2){ err.textContent = 'Em nhập họ và tên nhé.'; return; }
      if(!khoi){ err.textContent = 'Em chọn khối lớp nhé.'; return; }
      if(password !== confirm){ err.textContent = 'Hai lần nhập mật khẩu chưa giống nhau.'; return; }
      try{
        const existing = await DB.collection('students').doc(username).get();
        if(isForgot){
          if(!existing.exists){ err.textContent = 'Thông tin xác thực chưa khớp với tài khoản học sinh.'; return; }
          const account = existing.data();
          if(normaliseIdentity(account.displayName) !== normaliseIdentity(displayName) || String(account.khoi || '') !== String(khoi)){
            err.textContent = 'Thông tin xác thực chưa khớp với tài khoản học sinh.'; return;
          }
          await DB.collection('students').doc(username).update({ passwordHash:await sha256(password), passwordUpdatedAt:Date.now() });
          this.switchTab('login');
          $('studentUsername').value = username;
          $('studentPassword').value = '';
          $('studentPasswordConfirm').value = '';
          $('studentName').value = '';
          $('studentGrade').value = '';
          toast('Cập nhật mật khẩu thành công. Em đăng nhập lại nhé.');
          return;
        }
        if(existing.exists){ err.textContent = 'Tài khoản đăng nhập này đã tồn tại. Em chọn tên đăng nhập khác nhé.'; return; }
        const doc = { username, displayName, khoi, role:'student', passwordHash: await sha256(password), geminiApiKey:null, createdAt: Date.now() };
        await DB.collection('students').doc(username).set(doc);
        this.setStudent(doc, username);
        localStorage.setItem('hp_student_session', username);
        await this.onLoggedIn();
      }catch(e){ err.textContent = 'Có lỗi khi tạo tài khoản, thử lại nhé.'; }
      return;
    }
    try{
      const snap = await DB.collection('students').doc(username).get();
      if(!snap.exists){ err.textContent = 'Không tìm thấy tài khoản học sinh này.'; return; }
      const data = snap.data();
      if(data.role && data.role !== 'student'){ err.textContent = 'Tài khoản này không thuộc khu vực học sinh.'; return; }
      if(await sha256(password) !== data.passwordHash){ err.textContent = 'Sai mật khẩu.'; return; }
      this.setStudent(data, username);
      localStorage.setItem('hp_student_session', username);
      await this.onLoggedIn();
    }catch(e){ err.textContent = 'Có lỗi khi đăng nhập, thử lại nhé.'; }
  },
  async onLoggedIn(){
    if(state.admin){
      state.admin = null;
      localStorage.removeItem('hp_admin_session');
    }
    this.renderSession();
    toast('Xin chào, ' + state.student.displayName + '!');
    if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForStudent();
    if(state.pendingSurvey){ App.beginSurvey(); }
    else { App.goLanding(); Settings.maybeOpenForStudent(); }
  },
  renderSession(){
    if(!state.student){ AccountMenu.render(); return; }
    if(state.student.khoi && $('khoiSelect') && !state.pendingKhoi) $('khoiSelect').value = state.student.khoi;
    AccountMenu.render();
  },
  logout(){
    if(typeof ChatHistory !== 'undefined') ChatHistory.forgetSession();
    state.student = null;
    AIBackend.useStudentKey(null);
    localStorage.removeItem('hp_student_session');
    state.pendingKhoi = null; state.pendingSurvey = false;
    AccountMenu.render();
    toast('Đã đăng xuất tài khoản học sinh.');
    App.goLanding();
  },
  async tryRestore(){
    const saved = localStorage.getItem('hp_student_session');
    if(!saved) return;
    try{
      const snap = await DB.collection('students').doc(saved).get();
      if(snap.exists){
        const data = snap.data();
        if(!data.role || data.role === 'student') this.setStudent(data, saved);
      }
    }catch(e){}
    this.renderSession();
    if(state.student){
      if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForStudent();
      this.maybeOpenAccountApi();
    }
  },
  maybeOpenAccountApi(){
    if(typeof Settings !== 'undefined') Settings.maybeOpenForStudent();
  }
};
const AdminLibrary = {
  async add(){
    const title = $('refTitle').value.trim();
    const desc = $('refDesc').value.trim();
    const url = $('refUrl').value.trim();
    const err = $('refErr'); err.textContent = '';
    if(!title || !url){ err.textContent = 'Cần nhập tiêu đề và đường dẫn.'; return; }
    if(!/^https?:\/\//i.test(url)){ err.textContent = 'Link cần bắt đầu bằng http:// hoặc https://'; return; }
    try{
      await DB.collection('references').add({ title, desc, url, addedAt: Date.now(), addedBy: state.admin.username });
      $('refTitle').value=''; $('refDesc').value=''; $('refUrl').value='';
      toast('Đã thêm tư liệu!');
      AdminLibrary.load();
    }catch(e){ err.textContent = 'Không thêm được lúc này, thử lại nhé.'; }
  },
  async load(){
    const box = $('adminLibraryList');
    box.innerHTML = '<div class="empty-lib">Đang tải…</div>';
    try{
      const snap = await DB.collection('references').get();
      if(snap.empty){ box.innerHTML = '<div class="empty-lib">Chưa có tư liệu nào.</div>'; return; }
      const docs = snap.docs.map(d=>({id:d.id, data:d.data()})).sort((a,b)=>(b.data.addedAt||0)-(a.data.addedAt||0));
      box.innerHTML = docs.map(d=>libCardHtml(d.data, d.id, true)).join('');
      refreshIcons();
    }catch(e){ box.innerHTML = '<div class="empty-lib">Không thể tải danh sách lúc này.</div>'; }
  },
  async remove(id){
    try{ await DB.collection('references').doc(id).delete(); toast('Đã xóa tư liệu'); AdminLibrary.load(); }catch(e){ toast('Không xóa được lúc này'); }
  }
};

/* =================== lịch sử trò chuyện theo tài khoản =================== */
function hpReadStorage(storage, key, fallback){
  try{
    const value = storage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  }catch(e){ return fallback; }
}
function hpWriteStorage(storage, key, value){
  try{ storage.setItem(key, JSON.stringify(value)); }catch(e){}
}
function chatDate(ts){
  if(!ts) return '';
  try{
    return new Intl.DateTimeFormat('vi-VN',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ts));
  }catch(e){ return ''; }
}

const ChatHistory = {
  current:null,
  conversations:[],
  persistTimer:null,
  account(){ return getActiveAccount(); },
  storageKey(account){
    const key = typeof account === 'string' ? account : (account && account.role === 'admin' ? 'admin:' + account.username : account && account.username);
    return 'hp_chat_history:' + (key || 'anonymous');
  },
  activeKey(account){
    const key = typeof account === 'string' ? account : (account && account.role === 'admin' ? 'admin:' + account.username : account && account.username);
    return 'hp_active_chat:' + (key || 'anonymous');
  },
  remoteId(account){ return account && account.role === 'admin' ? 'admin:' + account.username : account && account.username; },
  _create(khoi, account){
    const now = Date.now();
    return {
      id:'chat_' + now + '_' + Math.random().toString(36).slice(2,8),
      title:'Cuộc trò chuyện mới',
      startedAt:now,
      updatedAt:now,
      status:'active',
      khoi:khoi || '',
      ownerRole:account && account.role || '',
      ownerUsername:account && account.username || '',
      messages:[],
      survey:{qIndex:0, attempts:0, extracted:{}, computed:null, completed:false}
    };
  },
  _normalise(item){
    if(!item || !item.id) return null;
    return Object.assign({
      title:'Cuộc trò chuyện mới', startedAt:Date.now(), updatedAt:Date.now(), status:'active',
      khoi:'', messages:[], survey:{qIndex:0, attempts:0, extracted:{}, computed:null, completed:false}
    }, item, {
      messages:Array.isArray(item.messages) ? item.messages : [],
      survey:Object.assign({qIndex:0, attempts:0, extracted:{}, computed:null, completed:false}, item.survey || {})
    });
  },
  _merge(localItems, remoteItems){
    const map = new Map();
    [...(localItems||[]), ...(remoteItems||[])].forEach(item=>{
      const c = this._normalise(item); if(!c) return;
      const old = map.get(c.id);
      if(!old || (c.updatedAt||0) >= (old.updatedAt||0)) map.set(c.id,c);
    });
    return Array.from(map.values()).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,60);
  },
  _sort(){ this.conversations.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)); },
  _saveLocal(){
    const account = this.account();
    if(!account) return;
    hpWriteStorage(localStorage, this.storageKey(account), this.conversations);
  },
  queuePersist(){
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(()=>this.persistNow(), 350);
  },
  async persistNow(){
    const account = this.account();
    if(!account || !this.conversations.length) return;
    try{
      await DB.collection('conversations').doc(this.remoteId(account)).set({
        username:account.username,
        role:account.role,
        updatedAt:Date.now(),
        conversations:this.conversations.slice(0,60)
      });
      const status = $('chatStatus');
      if(status){ status.classList.remove('offline'); status.innerHTML = '<i data-lucide="cloud-check" style="width:12px;height:12px;"></i> Đã lưu'; refreshIcons(); }
    }catch(e){
      const status = $('chatStatus');
      if(status){ status.classList.add('offline'); status.innerHTML = '<i data-lucide="hard-drive" style="width:12px;height:12px;"></i> Đã lưu trên máy'; refreshIcons(); }
    }
  },
  async restoreForAccount(){
    const account = this.account();
    if(!account) return;
    const localItems = hpReadStorage(localStorage, this.storageKey(account), []);
    let remoteItems = [];
    try{
      const snap = await DB.collection('conversations').doc(this.remoteId(account)).get();
      const data = snap.exists ? snap.data() : null;
      if(data && Array.isArray(data.conversations)) remoteItems = data.conversations;
    }catch(e){}
    this.conversations = this._merge(localItems, remoteItems);

    let active = null;
    const activeId = hpReadStorage(sessionStorage, this.activeKey(account), null);
    if(HP_IS_RELOAD && activeId) active = this.conversations.find(c=>c.id===activeId) || null;
    if(!active){
      active = this._create(account.khoi || '', account);
      this.conversations.unshift(active);
    }
    this.current = active;
    hpWriteStorage(sessionStorage, this.activeKey(account), active.id);
    this._sort();
    this._saveLocal();
    this.renderList();
    this.renderHeader();
    if(!HP_IS_RELOAD) this.queuePersist();
  },
  async restoreForStudent(){ return this.restoreForAccount(); },
  ensureCurrent(khoi, options={}){
    const account = this.account();
    if(!account) return null;
    if(!this.current) this.current = this._create(khoi || account.khoi || '', account);
    if(options.forceNew || (options.newIfCompleted && this.current.status === 'completed')) this.startNew(khoi);
    if(khoi && !this.current.khoi) this.current.khoi = khoi;
    this._saveLocal();
    return this.current;
  },
  startNew(khoi){
    const account = this.account();
    if(!account) return null;
    if(this.current && this.current.messages.length && this.current.status === 'active') this.current.status = 'closed';
    const next = this._create(khoi || account.khoi || '', account);
    this.current = next;
    this.conversations = [next, ...this.conversations.filter(c=>c.id!==next.id)].slice(0,60);
    hpWriteStorage(sessionStorage, this.activeKey(account), next.id);
    this._saveLocal();
    this.queuePersist();
    this.renderList();
    this.renderHeader();
    return next;
  },
  newConversation(){
    const account = this.account();
    if(!account){ toast('Em đăng nhập tài khoản trước nhé'); App.goStudentAuth('login'); return; }
    this.startNew(account.role === 'admin' ? '' : (state.khoi || account.khoi || ''));
    showView('view-chat');
    Hdtl.restoreCurrent({adminFreeform:account.role === 'admin'});
  },
  open(id){
    const found = this.conversations.find(c=>c.id===id);
    if(!found) return this.openCurrent();
    this.current = found;
    const account = this.account();
    if(account) hpWriteStorage(sessionStorage, this.activeKey(account), found.id);
    showView('view-chat');
    Hdtl.restoreCurrent({adminFreeform:account && account.role === 'admin'});
  },
  openCurrent(options={}){
    const account = this.account();
    if(!account){ App.goStudentAuth('login'); return; }
    if(!this.current) this.ensureCurrent(account.khoi || '');
    showView('view-chat');
    Hdtl.restoreCurrent(options);
  },
  forgetSession(){
    const account = this.account();
    if(account) sessionStorage.removeItem(this.activeKey(account));
    clearTimeout(this.persistTimer);
    this.current = null;
    this.conversations = [];
  },
  clearMoodMemory(conversationId){
    const account = this.account();
    if(!account) return;
    const keys = ['hp_mood_memory:' + account.role + ':' + account.username];
    if(account.role === 'student') keys.push('hp_mood_memory:' + account.username);
    keys.forEach(key=>{
      const memory = hpReadStorage(localStorage, key, {});
      if(memory && Object.prototype.hasOwnProperty.call(memory, conversationId)){
        delete memory[conversationId];
        hpWriteStorage(localStorage, key, memory);
      }
    });
  },
  deleteConversation(id){
    const account = this.account();
    if(!account) return;
    const target = this.conversations.find(c=>c.id===id);
    if(!target) return;
    const ok = typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm('Xóa cuộc trò chuyện này? Nội dung tâm trạng trong cuộc trò chuyện cũng sẽ bị xóa và không dùng để ghi nhớ nữa.');
    if(!ok) return;
    const wasCurrent = this.current && this.current.id === id;
    this.clearMoodMemory(id);
    this.conversations = this.conversations.filter(c=>c.id!==id);
    if(wasCurrent){
      this.current = this.conversations[0] || this._create(account.khoi || '', account);
      if(!this.conversations.length) this.conversations = [this.current];
      hpWriteStorage(sessionStorage, this.activeKey(account), this.current.id);
    }
    this._saveLocal();
    this.queuePersist();
    this.renderList();
    this.renderHeader();
    if(wasCurrent){ showView('view-chat'); Hdtl.restoreCurrent(); }
    toast('Đã xóa trò chuyện và dữ liệu tâm trạng liên quan.');
  },
  addMessage(role, text){
    if(!this.current || !text) return;
    this.current.messages = Array.isArray(this.current.messages) ? this.current.messages : [];
    this.current.messages.push({role, text:String(text), ts:Date.now()});
    if(role === 'user' && this.current.title === 'Cuộc trò chuyện mới'){
      const clean = String(text).replace(/\s+/g,' ').trim();
      if(clean) this.current.title = clean.length > 42 ? clean.slice(0,42) + '…' : clean;
    }
    this.current.updatedAt = Date.now();
    this._sort();
    this._saveLocal();
    this.queuePersist();
    this.renderList();
    this.renderHeader();
  },
  updateSurvey(patch){
    if(!this.current) return;
    this.current.survey = Object.assign({}, this.current.survey || {}, patch || {});
    if(patch && patch.khoi) this.current.khoi = patch.khoi;
    this.current.updatedAt = Date.now();
    this._saveLocal();
    this.queuePersist();
    this.renderList();
  },
  renderMessages(){
    const log = $('chatLog');
    if(!log) return;
    log.innerHTML = '';
    if(!this.current) return;
    (this.current.messages || []).forEach(message=>appendMsgElement(message.role, message.text));
    log.scrollTop = log.scrollHeight;
  },
  renderHeader(){
    const title = $('chatTitle');
    const count = $('conversationCount');
    const hint = $('conversationAccountHint');
    if(title) title.textContent = this.current ? this.current.title : 'Cuộc trò chuyện mới';
    if(count) count.textContent = String(this.conversations.length);
    const account = this.account();
    if(hint) hint.textContent = account ? 'Tài khoản: '+account.username+' · lịch sử chỉ hiển thị với tài khoản này.' : 'Đăng nhập để lưu lịch sử trò chuyện riêng.';
  },
  renderList(){
    const box = $('conversationList');
    if(!box) return;
    this._sort();
    if(!this.account() || !this.conversations.length){ box.innerHTML = '<div class="conversation-empty">Đăng nhập tài khoản để bắt đầu lưu lịch sử.</div>'; this.renderHeader(); return; }
    box.innerHTML = this.conversations.map(c=>{
      const active = this.current && c.id===this.current.id ? ' active' : '';
      const status = c.status==='completed' ? 'Đã xong' : (c.status==='closed' ? 'Đã lưu' : 'Đang mở');
      const safeId = escapeHtml(c.id);
      return '<div class="conversation-item'+active+'">' +
        '<button class="conversation-open" onclick="ChatHistory.open(\''+safeId+'\')">' +
          '<span class="conversation-item-title">'+escapeHtml(c.title || 'Cuộc trò chuyện mới')+'</span>' +
          '<span class="conversation-item-meta"><span>'+chatDate(c.updatedAt)+'</span><span class="conversation-item-status">'+status+'</span></span>' +
        '</button>' +
        '<button class="conversation-delete" onclick="event.stopPropagation();ChatHistory.deleteConversation(\''+safeId+'\')" title="Xóa cuộc trò chuyện" aria-label="Xóa cuộc trò chuyện"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>' +
        '</div>';
    }).join('');
    this.renderHeader();
    refreshIcons();
  },
  buildContext(maxChars=8500){
    if(!this.current) return 'Chưa có lịch sử trò chuyện.';
    const account = this.account();
    const userLabel = account && account.role === 'admin' ? 'Người dùng' : 'Học sinh';
    const current = (this.current.messages || []).slice(-16).map(m=>(m.role==='user'?userLabel:'Chatbot')+': '+m.text).join('\n');
    const previous = this.conversations.filter(c=>c.id!==this.current.id && c.messages && c.messages.length).slice(0,4).map(c=>{
      const last = c.messages.slice(-3).map(m=>(m.role==='user'?userLabel:'Chatbot')+': '+m.text).join(' | ');
      return '- '+(c.title||'Cuộc trò chuyện trước')+' ('+chatDate(c.updatedAt)+'): '+last;
    }).join('\n');
    return ('LỊCH SỬ CUỘC TRÒ CHUYỆN HIỆN TẠI:\n'+current+'\n\nTÓM TẮT CÁC CUỘC TRÒ CHUYỆN TRƯỚC CÙNG TÀI KHOẢN:\n'+previous).slice(-maxChars);
  }
};


/* =================== 6 câu hỏi khảo sát (đúng Prompt Log, Mục 3.2) =================== */
const QUESTIONS = [
  { id:'dichuyen', field:'di_chuyen_phut_tuan',
    ask:"Chào em! Mình cùng tìm hiểu xem một tuần của em vận động thế nào nhé. Trước tiên, em có đi bộ hoặc đạp xe để đến trường không? Nếu có thì mỗi lần đi mất khoảng bao lâu, và mấy ngày một tuần em đi như vậy?",
    fields:'"di_chuyen_phut_tuan": số phút/tuần đi bộ hoặc đạp xe để di chuyển (0 nếu không có)' },
  { id:'thethao', field:'the_thao_ngoai_gio_phut_tuan',
    ask:"Trong tuần, em có tham gia môn thể thao nào ngoài giờ học không (đá bóng, cầu lông, bơi, nhảy...)? Mỗi tuần khoảng mấy buổi, mỗi buổi bao lâu?",
    fields:'"the_thao_ngoai_gio_phut_tuan": tổng số phút/tuần chơi thể thao ngoài giờ học (0 nếu không có), "cuong_do": "vua" hoặc "manh" (dựa vào môn thể thao được nhắc tới)' },
  { id:'truong', field:'van_dong_truong_hoc',
    ask:"Vào giờ ra chơi hoặc giờ thể dục ở trường, em có vận động mạnh (chạy nhảy, chơi thể thao) hay chủ yếu ngồi/đứng nói chuyện?",
    fields:'"van_dong_truong_hoc": "manh" | "nhe" | "khong_ro"' },
  { id:'vieenha', field:'viec_nha_phut_tuan',
    ask:"Ngoài giờ học, em có hay làm việc nhà vận động nhiều (quét dọn, làm vườn...) không? Khoảng bao nhiêu ngày/tuần, mỗi lần khoảng bao lâu?",
    fields:'"viec_nha_phut_tuan": số phút/tuần làm việc nhà cần vận động (0 nếu không có)' },
  { id:'ngoi', field:'thoi_gian_ngoi_gio_ngay',
    ask:"Một ngày bình thường, em ngồi học bài, xem điện thoại/máy tính, xem TV... tổng cộng khoảng bao nhiêu tiếng?",
    fields:'"thoi_gian_ngoi_gio_ngay": số giờ/ngày ngồi tĩnh tại' },
  { id:'cuoituan', field:'hoat_dong_cuoi_tuan_phut_tuan',
    ask:"Cuối tuần em có hoạt động gì ngoài trời không (đi dạo, đạp xe, chơi thể thao cùng gia đình/bạn bè)? Khoảng bao nhiêu phút?",
    fields:'"hoat_dong_cuoi_tuan_phut_tuan": tổng số phút hoạt động ngoài trời cuối tuần (0 nếu không có)' },
];
const LEVEL_META = {
  'Không HĐTL': {cls:'lvl-khong', headline:'Em gần như chưa có thời gian vận động — bắt đầu từ điều nhỏ nhé!'},
  'Không đủ':   {cls:'lvl-thieu', headline:'Em đã vận động, nhưng chưa chạm mốc khuyến cáo — chỉ cần thêm một chút!'},
  'Đủ':         {cls:'lvl-du', headline:'Rất tốt — em đang vận động đúng mức khuyến cáo của Bộ Y tế!'},
  'Cao':        {cls:'lvl-cao', headline:'Xuất sắc — em đang vận động ở mức cao, cứ duy trì nhé!'},
};
const LEVEL_COLOR = {'Không HĐTL':'var(--pulse)','Không đủ':'var(--amber)','Đủ':'var(--teal)','Cao':'var(--deep)'};

const Hdtl = {
  restoreCurrent(options={}){
    const conversation = ChatHistory.current;
    if(!conversation) return;
    const survey = conversation.survey || {};
    const account = getActiveAccount();
    const adminFreeform = !!options.adminFreeform && account && account.role === 'admin';
    state.khoi = conversation.khoi || (account && account.role === 'student' ? (state.khoi || account.khoi) : '') || '';
    state.hdtl = {
      qIndex:Number(survey.qIndex)||0,
      attempts:Number(survey.attempts)||0,
      extracted:survey.extracted || {},
      computed:survey.computed || null,
      docRef:null,
      completed:adminFreeform ? true : !!survey.completed,
      finishing:adminFreeform ? false : !!survey.finishing,
      adminChat:adminFreeform || !!survey.adminChat
    };
    if(adminFreeform && !survey.adminChat) ChatHistory.updateSurvey({completed:true, adminChat:true, finishing:false});
    ChatHistory.renderMessages();
    updateQCount();
    updateComposer();
    if(!conversation.messages.length && !state.hdtl.completed && !state.hdtl.finishing && !state.hdtl.adminChat) addMsg('ai', QUESTIONS[0].ask);
  },
  start(){
    ChatHistory.ensureCurrent(state.khoi, {newIfCompleted:true});
    this.restoreCurrent({adminFreeform:false});
  },
  async sendAnswer(){
    const input = $('chatInput');
    const text = input.value.trim();
    if(!text) return;
    input.value = '';
    if(state.hdtl.completed || state.hdtl.qIndex >= QUESTIONS.length) return this.sendFreeform(text);
    if(state.hdtl.finishing) return;
    $('sendBtn').disabled = true;
    addMsg('user', text);
    const q = QUESTIONS[state.hdtl.qIndex];
    showThinking();
    try{
      const result = await extractField(q, text);
      removeThinking();
      if(result.can_hoi_lai && state.hdtl.attempts < 1){
        state.hdtl.attempts++;
        ChatHistory.updateSurvey({qIndex:state.hdtl.qIndex, attempts:state.hdtl.attempts, extracted:state.hdtl.extracted});
        addMsg('ai', result.cau_hoi_lai || 'Em ước lượng giúp mình khoảng mấy lần một tuần được không?');
      } else {
        state.hdtl.extracted[q.id] = result;
        state.hdtl.attempts = 0;
        state.hdtl.qIndex++;
        ChatHistory.updateSurvey({qIndex:state.hdtl.qIndex, attempts:0, extracted:state.hdtl.extracted});
        if(state.hdtl.qIndex < QUESTIONS.length){
          updateQCount();
          addMsg('ai', QUESTIONS[state.hdtl.qIndex].ask);
        } else {
          state.hdtl.finishing = true;
          ChatHistory.updateSurvey({qIndex:state.hdtl.qIndex, extracted:state.hdtl.extracted, finishing:true});
          updateQCount();
          addMsg('ai', 'Cảm ơn em! Để mình tổng hợp kết quả nhé…');
          setTimeout(Hdtl.finish, 500);
        }
      }
    }catch(err){
      removeThinking();
      const msg = AIBackend.mode==='none' ? 'AI chưa được kết nối trong chế độ xem này.' : 'Mình chưa nghe rõ lắm — em thử trả lời lại được không?';
      addMsg('ai', msg);
    }
    $('sendBtn').disabled = false;
  },
  async sendFreeform(text){
    if(!text) return;
    $('sendBtn').disabled = true;
    addMsg('user', text);
    showThinking();
    try{
      const reply = await generateCompanionReply(text);
      removeThinking();
      addMsg('ai', reply);
    }catch(err){
      removeThinking();
      addMsg('ai', 'Mình vẫn đang lắng nghe em. Em có thể kể thêm điều đang làm em thấy nặng lòng không?');
    }
    $('sendBtn').disabled = false;
  },
  async finish(){
    if(state.hdtl.completed) return;
    const computed = computeHdtl(state.hdtl.extracted);
    state.hdtl.computed = computed;
    state.hdtl.completed = true;
    state.hdtl.finishing = false;
    ChatHistory.updateSurvey({khoi:state.khoi, qIndex:QUESTIONS.length, extracted:state.hdtl.extracted, computed, completed:true, finishing:false});
    const account = getActiveAccount();
    const resultDoc = { username:account && account.username || null, khoi: state.khoi, level: computed.level, quyDoi: computed.quyDoi, committed:false, ts: Date.now() };
    try{ state.hdtl.docRef = await DB.collection('results').add(resultDoc); }catch(e){}
    addMsg('ai', buildSurveySummary(computed));
    const fb = await generateHdtlFeedback(computed);
    addMsg('ai', fb);
    if(ChatHistory.current){ ChatHistory.current.status='completed'; ChatHistory.current.updatedAt=Date.now(); ChatHistory._saveLocal(); ChatHistory.queuePersist(); }
    updateQCount();
    updateComposer();
    ChatHistory.renderList();
  }
};
function updateQCount(){
  const box = $('qcount'); if(!box) return;
  if(state.hdtl && state.hdtl.finishing) box.textContent = 'Đang tổng hợp câu trả lời…';
  else if(state.hdtl && state.hdtl.adminChat) box.textContent = 'Chatbot sẵn sàng · bạn có thể bắt đầu trò chuyện';
  else if(state.hdtl && state.hdtl.completed) box.textContent = 'Khảo sát đã hoàn tất · em có thể tiếp tục tâm sự bất cứ lúc nào';
  else box.textContent = 'Câu ' + ((state.hdtl && state.hdtl.qIndex || 0)+1) + ' / ' + QUESTIONS.length;
}
function updateComposer(){
  const input = $('chatInput'); const send = $('sendBtn');
  if(!input || !send) return;
  const freeform = state.hdtl && state.hdtl.completed;
  input.placeholder = freeform ? 'Chia sẻ điều em đang nghĩ...' : 'Trả lời câu hỏi của em...';
  input.disabled = !!(state.hdtl && state.hdtl.finishing);
  send.disabled = !!(state.hdtl && state.hdtl.finishing);
}
function appendMsgElement(role, text){
  const log = $('chatLog');
  if(!log) return;
  const row = document.createElement('div');
  row.className = 'msg-row ' + role;
  const avatar = role==='ai' ? '<div class="avatar-ai"></div>' : '';
  row.innerHTML = avatar + '<div class="msg '+role+'">'+escapeHtml(text)+'</div>';
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
}
function addMsg(role, text){
  appendMsgElement(role, text);
  ChatHistory.addMessage(role, text);
  window.scrollTo({top:document.body.scrollHeight, behavior:'smooth'});
}
function showThinking(){
  const log = $('chatLog');
  const row = document.createElement('div');
  row.className='msg-row ai'; row.id='thinkingBubble';
  row.innerHTML = '<div class="avatar-ai"></div><div class="msg thinking"><span class="dot-flash"></span><span class="dot-flash"></span><span class="dot-flash"></span></div>';
  log.appendChild(row); log.scrollTop = log.scrollHeight;
}
function removeThinking(){ const b=$('thinkingBubble'); if(b) b.remove(); }

function buildSurveySummary(computed){
  const meta = LEVEL_META[computed.level];
  return meta.headline + '\n\nMức hiện tại: ' + computed.level + '\nVận động quy đổi: khoảng ' + computed.quyDoi + ' phút/tuần\nThời gian ngồi tĩnh tại: khoảng ' + computed.gioNgoiNgay + ' giờ/ngày';
}

async function generateCompanionReply(userText){
  const account = getActiveAccount();
  const isAdmin = account && account.role === 'admin';
  const fallback = isAdmin
    ? 'Mình đã nghe bạn. Hãy kể thêm điều bạn đang quan tâm; mình sẽ cùng bạn sắp xếp suy nghĩ và tìm một hướng xử lý thực tế nhé.'
    : 'Mình đã nghe em. Hãy thử nói chậm lại một chút về điều đang khiến em mệt hoặc lo lắng; mình sẽ cùng em tìm một bước nhỏ, thực tế để xử lý nhé.';
  if(AIBackend.mode==='none') return fallback;
  const audience = isAdmin ? 'giáo viên hoặc quản trị viên' : 'học sinh';
  const prompt = 'Bạn là một người bạn đồng hành AI thân thiện của '+audience+'. Hãy đọc lịch sử trò chuyện của đúng tài khoản này để nhận ra cảm xúc, mối quan tâm và cách xưng hô phù hợp, rồi trả lời tin nhắn mới một cách ấm áp, cụ thể và không phán xét. Không chẩn đoán bệnh, không khẳng định chắc chắn về tâm lý. Nếu có dấu hiệu tự làm hại bản thân, nguy hiểm hoặc vấn đề y tế nghiêm trọng, hãy khuyên người dùng báo ngay cho người lớn đáng tin cậy và nhân viên y tế/dịch vụ khẩn cấp tại nơi họ sống. Trả lời bằng tiếng Việt, ngắn gọn 2–5 đoạn, ưu tiên một hoặc hai gợi ý có thể làm ngay.\n\n' +
    ChatHistory.buildContext() + '\n\nTIN NHẮN MỚI NHẤT CỦA NGƯỜI DÙNG:\n' + userText;
  try{ return await AIBackend.text(prompt); }catch(e){ return fallback; }
}

/* =================== AI xử lý dữ liệu phía sau (đúng Prompt Log, Mục 3.1) =================== */
async function extractField(q, userText){
  if(AIBackend.mode==='none'){
    const num = parseInt((userText.match(/\d+/)||[0])[0], 10) || 0;
    const out = {can_hoi_lai:false, cuong_do:'vua', van_dong_truong_hoc: num>0 ? 'manh':'nhe'};
    out[q.field] = num;
    return out;
  }
  const prompt = 'Bạn là trợ lý AI phân tích mức độ hoạt động thể lực (HĐTL) của học sinh THPT, dựa trên hướng dẫn chính thức của Bộ Y tế Việt Nam (Cẩm nang HĐTL 2026, Phụ lục 2).\n\n' +
    'Câu hỏi đã hỏi: "' + q.ask + '"\nCâu trả lời của học sinh: "' + userText + '"\n\n' +
    'Hãy trích xuất và trả về dưới dạng JSON đúng các trường sau: ' + q.fields + '.\n' +
    'Nếu câu trả lời không có số liệu rõ ràng (VD: "thỉnh thoảng", "ít"), đặt "can_hoi_lai": true và "cau_hoi_lai" là một câu hỏi làm rõ thân thiện, ngắn gọn kiểu "Em ước lượng giúp mình khoảng mấy lần một tuần được không?". KHÔNG tự đoán số liệu.\n' +
    'Nếu đã đủ rõ, trả về JSON phẳng gồm đúng các trường yêu cầu, cộng thêm "can_hoi_lai": false.\n' +
    'Chỉ trả về JSON hợp lệ, không kèm chữ nào khác, không dùng markdown code fence.';
  return await AIBackend.json(prompt);
}
function computeHdtl(ex){
  // Công thức chính thức tại Phụ lục 2, mục B (Cẩm nang HĐTL):
  // Tổng phút HĐTL cường độ vừa/tuần = di_chuyen_phut_tuan + the_thao_ngoai_gio_phut_tuan (nếu vận động vừa) + viec_nha_phut_tuan
  // Tổng phút HĐTL cường độ mạnh/tuần = the_thao_ngoai_gio_phut_tuan (nếu vận động mạnh) + hoạt động thể dục mạnh ở trường
  // Quy đổi: 1 phút cường độ mạnh = 2 phút cường độ vừa
  // (Hoạt động cuối tuần — câu hỏi 6 — là phần bổ sung ngoài schema gốc để phản ánh đầy đủ hơn, được cộng vào nhóm cường độ vừa.)
  const di_chuyen = (ex.dichuyen && ex.dichuyen.di_chuyen_phut_tuan) || 0;
  const the_thao = (ex.thethao && ex.thethao.the_thao_ngoai_gio_phut_tuan) || 0;
  const the_thao_cuong_do = (ex.thethao && ex.thethao.cuong_do) || 'vua';
  const truong_manh = ex.truong && ex.truong.van_dong_truong_hoc === 'manh';
  const viec_nha = (ex.vieenha && ex.vieenha.viec_nha_phut_tuan) || 0;
  const cuoi_tuan = (ex.cuoituan && ex.cuoituan.hoat_dong_cuoi_tuan_phut_tuan) || 0;
  const gio_ngoi = (ex.ngoi && ex.ngoi.thoi_gian_ngoi_gio_ngay) || 0;

  let phutVua = di_chuyen + viec_nha + cuoi_tuan;
  let phutManh = 0;
  if(the_thao_cuong_do === 'manh') phutManh += the_thao; else phutVua += the_thao;
  if(truong_manh) phutManh += 45;

  const quyDoi = phutVua + phutManh*2;
  let level;
  if(quyDoi === 0) level = 'Không HĐTL';
  else if(quyDoi < 420) level = 'Không đủ';
  else if(quyDoi <= 600) level = 'Đủ';
  else level = 'Cao';
  return {phutVua, phutManh, quyDoi, level, gioNgoiNgay: gio_ngoi};
}
async function generateHdtlFeedback(computed){
  const fallback = 'Em đang ở mức "' + computed.level + '". Thử đi bộ nhanh 10 phút vào giờ ra chơi, 3 buổi/tuần nhé!';
  if(AIBackend.mode==='none') return fallback;
  const prompt = 'Bạn là trợ lý AI phân tích mức độ hoạt động thể lực (HĐTL) của học sinh THPT, dựa trên hướng dẫn chính thức của Bộ Y tế Việt Nam (Cẩm nang HĐTL 2026, Phụ lục 2).\n\n' +
    'Học sinh vừa được phân loại: mức "' + computed.level + '", tổng thời gian vận động quy đổi khoảng ' + computed.quyDoi + ' phút/tuần (mốc khuyến cáo tối thiểu là 420 phút/tuần), thời gian ngồi tĩnh tại khoảng ' + computed.gioNgoiNgay + ' giờ/ngày.\n\n' +
    'Viết lời khuyên ngắn gọn, gần gũi, KHÔNG dùng ngôn ngữ y tế khô khan. Phải bao gồm:\n' +
    '1. Nhận xét ngắn về mức độ hiện tại (khích lệ, không chê trách)\n' +
    '2. Đúng 1-2 gợi ý HÀNH ĐỘNG CỤ THỂ, khả thi trong tuần (VD: "Thử đi bộ nhanh 10 phút vào giờ ra chơi, 3 buổi/tuần"), dựa trên loại hình phù hợp lứa tuổi 5-17 (đi bộ nhanh, đạp xe, nhảy dây, bóng chuyền, cầu lông...)\n' +
    '3. Không dùng thuật ngữ MET, không liệt kê số liệu phức tạp\n\n' +
    'Giọng văn: thân thiện như một người anh/chị hướng dẫn, không phải bác sĩ. Chỉ trả về đoạn văn, không tiêu đề.\n\n' +
    'Nếu phù hợp, tham khảo thêm lịch sử trò chuyện sau để lời khuyên hợp với cảm xúc của em:\n' + ChatHistory.buildContext(5000);
  try{ return await AIBackend.text(prompt); }catch(e){ return fallback; }
}

/* =================== 4. Dashboard (GV/BGH) =================== */
const KHOI_ORDER = ['6','7','8','9','10','11','12'];
const LEVEL_ICON_COLOR = {'Không HĐTL':'#FF5D5D','Không đủ':'#FFB74D','Đủ':'#2F8F7D','Cao':'#123C3B'};
let allResults = [];
const Dashboard = {
  load(){
    DB.collection('results').onSnapshot((snap)=>{
      allResults = snap.docs.map(d=>d.data());
      Dashboard.applyFilter();
    }, ()=>{ $('dashBars').innerHTML = '<div class="empty-dash">Không thể tải dữ liệu lúc này.</div>'; });
  },
  applyFilter(){
    const khoi = $('khoiFilter').value;
    $('dashTotal').textContent = allResults.length;
    const filtered = khoi==='all' ? allResults : allResults.filter(r=>r.khoi===khoi);
    renderBars(filtered);
    renderPctTable(allResults, khoi);
    Dashboard.renderSummaryStats();
  },
  renderSummaryStats(){
    if(allResults.length===0){ $('dashTopLevel').textContent='—'; return; }
    const counts = {'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0};
    allResults.forEach(r=>{ if(counts[r.level]!==undefined) counts[r.level]++; });
    const topLevel = Object.keys(counts).reduce((a,b)=> counts[a]>=counts[b] ? a : b);
    $('dashTopLevel').textContent = topLevel;
  }
};
const AdminNav = {
  switchTab(tab){
    document.querySelectorAll('.atab2').forEach(t=>t.classList.toggle('active', t.dataset.atab===tab));
    document.querySelectorAll('.admin-panel').forEach(p=>p.classList.toggle('active', p.id==='ap-'+tab));
    if(tab==='overview') Dashboard.load();
    if(tab==='library') AdminLibrary.load();
    refreshIcons();
  }
};
function renderBars(rows){
  const box = $('dashBars');
  if(rows.length===0){ box.innerHTML = '<div class="empty-dash">Chưa có dữ liệu khảo sát.</div>'; return; }
  const byKhoi = {}; KHOI_ORDER.forEach(k=>byKhoi[k]={'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0});
  rows.forEach(r=>{ if(!byKhoi[r.khoi]) byKhoi[r.khoi]={'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0}; if(byKhoi[r.khoi][r.level]!==undefined) byKhoi[r.khoi][r.level]++; });
  let html='';
  KHOI_ORDER.forEach(k=>{
    const c = byKhoi[k]; const total = Object.values(c).reduce((a,b)=>a+b,0);
    if(total===0) return;
    html += '<div class="bar-row"><div class="khoi-lbl">Khối '+k+'</div><div class="bar-track">';
    Object.keys(c).forEach(l=>{ const pct=c[l]/total*100; if(pct>0) html += '<div class="bar-seg" style="width:'+pct.toFixed(1)+'%;background:'+LEVEL_COLOR[l]+';" title="'+l+': '+c[l]+'"></div>'; });
    html += '</div><div class="cnt">'+total+'</div></div>';
  });
  box.innerHTML = html || '<div class="empty-dash">Chưa có dữ liệu khảo sát.</div>';
}
function renderPctTable(rows, selectedKhoi){
  const wrap = $('pctTable'); const note = $('highlightNote');
  if(rows.length===0){ wrap.innerHTML=''; note.classList.add('hidden'); return; }
  const byKhoi = {}; KHOI_ORDER.forEach(k=>byKhoi[k]={'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0});
  rows.forEach(r=>{ if(!byKhoi[r.khoi]) byKhoi[r.khoi]={'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0}; if(byKhoi[r.khoi][r.level]!==undefined) byKhoi[r.khoi][r.level]++; });
  let html = '<table class="pct-table"><thead><tr><th>Khối</th><th>Không HĐTL</th><th>Không đủ</th><th>Đủ</th><th>Cao</th></tr></thead><tbody>';
  let worstKhoi=null, worstPct=-1;
  KHOI_ORDER.forEach(k=>{
    const c = byKhoi[k]; const total = Object.values(c).reduce((a,b)=>a+b,0);
    if(total===0) return;
    const pct = (n)=> Math.round(n/total*100)+'%';
    const thieuPct = (c['Không HĐTL']+c['Không đủ'])/total*100;
    if(thieuPct > worstPct){ worstPct = thieuPct; worstKhoi = k; }
    const style = selectedKhoi!=='all' && selectedKhoi===k ? ' style="background:var(--paper);"' : '';
    html += '<tr'+style+'><td>Khối '+k+'</td><td>'+pct(c['Không HĐTL'])+'</td><td>'+pct(c['Không đủ'])+'</td><td>'+pct(c['Đủ'])+'</td><td>'+pct(c['Cao'])+'</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  if(worstKhoi){
    note.classList.remove('hidden');
    note.innerHTML = '<i data-lucide="alert-triangle" style="width:15px;height:15px;"></i><span>Khối '+worstKhoi+' đang có tỷ lệ thiếu vận động cao nhất — khoảng '+Math.round(worstPct)+'%. Nên ưu tiên tổ chức hoạt động thể chất cho khối này.</span>';
    refreshIcons();
    const wEl = $('dashWorstKhoi'); if(wEl) wEl.textContent = 'Khối ' + worstKhoi;
  } else { note.classList.add('hidden'); const wEl = $('dashWorstKhoi'); if(wEl) wEl.textContent = '—'; }
}

/* init */
renderSteps('view-landing');
refreshIcons();
bootAI();
