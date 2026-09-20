const HP_NAVIGATION_TYPE = (()=>{
  try{
    const entry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if(entry && entry.type) return entry.type;
    return performance.navigation && performance.navigation.type === 1 ? 'reload' : 'navigate';
  }catch(e){ return 'navigate'; }
})();
const HP_IS_RELOAD = HP_NAVIGATION_TYPE === 'reload';
const SHEETS_API_URL = "https://script.google.com/macros/s/AKfycbwreGveg-jznaednYvQsAA3VKzu32vYugHln2r9-cjKNfj1wugGDzXUkqtCojiSL7qi/exec";
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
  mode:'none', geminiKey:null, models:[], activeModel:null, modelRoute:[], modelDiscoveryError:null,
  fallbackModels:['models/gemini-2.5-flash','models/gemini-2.0-flash','models/gemini-1.5-flash'],
  async init(){
    if(sampleFn){ this.mode='claude'; this.geminiKey=null; return; }
    // API keys are loaded after the student account is restored. Do not use a
    // single global browser key: that would leak one student's key to another.
    this.geminiKey = null;
    this.models = [];
    this.activeModel = null;
    this.modelRoute = [];
    this.modelDiscoveryError = null;
    this.mode = 'none';
  },
  useAccountKey(account){
    if(sampleFn){ this.mode='claude'; this.geminiKey=null; return; }
    const accountKey = account && (account.geminiApiKey || account.apiKey || account.geminiKey);
    const cacheKey = account && account.username ? 'hp_gemini_key:' + (account.role === 'admin' ? 'admin:' : '') + account.username : null;
    const legacyStudentKey = account && account.role === 'student' && account.username ? localStorage.getItem('hp_gemini_key:'+account.username) : null;
    const cachedKey = cacheKey ? localStorage.getItem(cacheKey) : legacyStudentKey;
    this.geminiKey = accountKey || cachedKey || null;
    this.models = [];
    this.activeModel = null;
    this.modelRoute = [];
    this.modelDiscoveryError = null;
    this.mode = this.geminiKey ? 'gemini' : 'none';
    if(this.geminiKey && cacheKey){
      localStorage.setItem(cacheKey, this.geminiKey);
    }
  },
  useStudentKey(student){ this.useAccountKey(student ? Object.assign({role:'student'}, student) : null); },
  async discoverModels(){
    if(this.mode!=='gemini') return [];
    return await this._listModels();
  },
  async json(prompt){
    if(this.mode==='claude') return await sampleFn.json(prompt, {modelTier:'quick'});
    if(this.mode==='gemini'){
      return await this._callGeminiModels(prompt + '\n\nChỉ trả JSON hợp lệ, không kèm chữ nào khác, không dùng markdown code fence.', raw=>{
        const clean = String(raw || '').replace(/```json|```/gi,'').trim();
        try{ return JSON.parse(clean); }catch(e){}
        const objectMatch = clean.match(/\{[\s\S]*\}/);
        if(objectMatch){ try{ return JSON.parse(objectMatch[0]); }catch(e){} }
        return null;
      });
    }
    throw {code:'no_ai'};
  },
  async text(prompt){
    if(this.mode==='claude'){ const r = await sampleFn(prompt, {modelTier:'default'}); return r.text; }
    if(this.mode==='gemini') return await this._callGeminiModels(prompt, raw=>String(raw || '').trim() || null);
    throw {code:'no_ai'};
  },
  _normaliseModelName(name){
    const value = String(name || '').trim();
    if(!value) return '';
    return value.startsWith('models/') ? value : 'models/' + value;
  },
  _modelScore(name){
    const id = String(name || '').replace(/^models\//i,'').toLowerCase();
    let score = 0;
    if(id.includes('flash')) score += 100;
    if(id.includes('pro')) score += 45;
    if(id.includes('lite')) score += 10;
    if(id.includes('2.5')) score += 20;
    else if(id.includes('2.0')) score += 12;
    else if(id.includes('1.5')) score += 5;
    if(/preview|experimental|exp/.test(id)) score -= 35;
    return score;
  },
  _isUsableTextModel(model){
    if(!model || !model.name) return false;
    const id = String(model.name).toLowerCase();
    const methods = model.supportedGenerationMethods;
    if(Array.isArray(methods) && !methods.includes('generateContent')) return false;
    return !/(embedding|imagen|veo|aqa|tts|image-generation|robotics)/i.test(id);
  },
  async _readHttpError(res, prefix, model){
    let detail = '';
    try{
      const body = await res.json();
      detail = body && body.error && body.error.message ? String(body.error.message) : '';
    }catch(e){}
    return {code:prefix + res.status, status:res.status, model:model || null, detail};
  },
  async _listModels(){
    if(this.models.length) return this.models;
    if(!this.geminiKey) throw {code:'no_ai'};
    const found = [];
    let pageToken = '';
    try{
      for(let page = 0; page < 10; page++){
        let url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(this.geminiKey);
        if(pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
        const res = await fetch(url);
        if(!res.ok) throw await this._readHttpError(res, 'gemini_models_http_');
        const data = await res.json();
        (data.models || []).filter(model=>this._isUsableTextModel(model)).forEach(model=>{
          const name = this._normaliseModelName(model.name);
          if(name && !found.includes(name)) found.push(name);
        });
        pageToken = data.nextPageToken || '';
        if(!pageToken) break;
      }
      this.models = found.sort((a,b)=>this._modelScore(b)-this._modelScore(a) || a.localeCompare(b));
      if(!this.models.length) throw {code:'gemini_no_text_models'};
    }catch(err){
      // Nếu endpoint liệt kê tạm lỗi, vẫn thử các model văn bản phổ biến để
      // không làm chatbot dừng chỉ vì một lỗi tạm thời của endpoint /models.
      this.modelDiscoveryError = err;
      this.models = this.fallbackModels.slice();
    }
    return this.models;
  },
  async _generateWithModel(model, prompt){
    const modelPath = this._normaliseModelName(model);
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/' + modelPath + ':generateContent?key=' + encodeURIComponent(this.geminiKey), {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({contents:[{parts:[{text:prompt}]}]})
    });
    if(!res.ok) throw await this._readHttpError(res, 'gemini_http_', modelPath);
    const data = await res.json();
    const raw = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || []).map(p=>p.text||'').join('').trim();
    if(!raw) throw {code:'gemini_empty_response', model:modelPath, finishReason:data.candidates && data.candidates[0] && data.candidates[0].finishReason || ''};
    return raw;
  },
  async _callGeminiModels(prompt, transform){
    const models = await this._listModels();
    const failures = [];
    for(const model of models){
      try{
        const raw = await this._generateWithModel(model, prompt);
        const value = transform(raw);
        if(value !== null && value !== undefined){
          this.activeModel = model;
          this.modelRoute = models.slice(0, models.indexOf(model) + 1);
          return value;
        }
        failures.push({model, code:'invalid_response'});
      }catch(err){
        failures.push({model, code:err && err.code || 'gemini_request_failed', status:err && err.status || null, detail:err && err.detail || ''});
      }
    }
    throw {code:'gemini_all_models_failed', models:models.slice(), errors:failures, discoveryError:this.modelDiscoveryError || null};
  },
  errorMessage(err){
    if(this.mode==='none') return 'AI chưa được kết nối trong chế độ xem này.';
    const errors = err && Array.isArray(err.errors) ? err.errors : [];
    const statuses = errors.map(item=>Number(item.status)).filter(Boolean);
    if(statuses.includes(401) || statuses.includes(403)) return 'API key này chưa có quyền dùng các mô hình văn bản khả dụng — cậu kiểm tra lại khóa Gemini nhé.';
    if(statuses.includes(429)) return 'Các mô hình của API key này đang hết hạn mức tạm thời — cậu thử lại sau một chút nhé.';
    if(err && err.code==='gemini_no_text_models') return 'API key này chưa có mô hình hỗ trợ trả lời văn bản.';
    if(err && err.code==='gemini_all_models_failed') return 'Mình đã thử các mô hình mà API key này cho phép nhưng chưa nhận được câu trả lời — cậu kiểm tra hạn mức hoặc API key rồi thử lại nhé.';
    return 'Mình chưa kết nối được với mô hình AI — cậu kiểm tra API key rồi thử lại nhé.';
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
  await Promise.all([SchoolDirectory.populate('schoolSelect'), SchoolDirectory.populate('adminSchool')]);
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
      html += '<p>Cậu cần đăng nhập tài khoản trước khi lưu API Key Gemini.</p>';
    } else {
      const account = getActiveAccount();
      const accountLabel = account.role === 'admin' ? 'quản trị viên' : 'học sinh';
      const masked = AIBackend.geminiKey ? (AIBackend.geminiKey.slice(0,6) + '••••••••') : '';
      if(auto && !masked){
        html += '<div class="api-auto-note"><strong>Tài khoản này chưa có API Key.</strong><span>Cậu dán API Key Gemini một lần; hệ thống sẽ lưu theo tài khoản '+accountLabel+' để lần sau đăng nhập ở máy khác vẫn dùng được.</span></div>';
      } else {
        html += '<p>Để chatbot hoạt động thông minh, cậu cần một API Key Gemini. Khóa sẽ được lưu theo tài khoản '+accountLabel+' này, không dùng chung với tài khoản khác. Sau khi lưu, hệ thống tự dò các mô hình được phép dùng và tự chuyển sang mô hình khác nếu mô hình đang gọi bị lỗi.</p>';
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
    if(!account){ toast('Cậu đăng nhập tài khoản trước nhé'); return; }
    try{
      const collection = account.role === 'admin' ? 'admins' : 'students';
      await DB.collection(collection).doc(account.username).update({ geminiApiKey:v, apiKeyUpdatedAt:Date.now() });
      account.data.geminiApiKey = v;
      AIBackend.useAccountKey(account.data);
      try{ await AIBackend.discoverModels(); }catch(e){}
      toast('Đã lưu API theo tài khoản — đã dò mô hình AI!');
      Settings.close();
    }catch(e){ toast('Chưa lưu được API, cậu thử lại nhé'); }
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
    }catch(e){ toast('Chưa xóa được API, cậu thử lại nhé'); }
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
const state = { khoi:null, pendingKhoi:null, pendingSchool:null, pendingSurvey:false, hdtl:{ qIndex:0, attempts:0, extracted:{}, computed:null, docRef:null }, admin:null, student:null };

function resolveAccountDisplayName(data, fallback=''){
  const candidates = ['displayName','fullName','full_name','realName','hoTen','hoten','ten','name'];
  for(const key of candidates){
    const value = data && data[key];
    if(value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return String(fallback || '').trim();
}

function normaliseAdminAccount(data, fallbackUsername=''){
  const username = String((data && data.username) || fallbackUsername || '').trim().toLowerCase();
  const displayName = resolveAccountDisplayName(data, username);
  return Object.assign({}, data || {}, normaliseSchool(data), { username, displayName, role:'admin' });
}

function getActiveAccount(){
  if(state.admin){
    const username = String(state.admin.username || '').trim();
    return Object.assign({ role:'admin', username, displayName:resolveAccountDisplayName(state.admin, username), khoi:'', data:state.admin }, normaliseSchool(state.admin));
  }
  if(state.student) return Object.assign({ role:'student', username:state.student.username, displayName:state.student.displayName || state.student.username, khoi:state.student.khoi || '', data:state.student }, normaliseSchool(state.student));
  return null;
}

function normaliseIdentity(value){
  return String(value || '').trim().replace(/\s+/g,' ').toLocaleLowerCase('vi-VN');
}

/* =================== danh mục trường học & phạm vi dữ liệu =================== */
function stripSchoolDiacritics(value){
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D');
}
function schoolKey(value){
  return stripSchoolDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100);
}
function detectSchoolLevel(value){
  const text = stripSchoolDiacritics(value).toLowerCase();
  const hasThcs = /\bthcs\b|trung hoc co so/.test(text);
  const hasThpt = /\bthpt\b|trung hoc pho thong/.test(text);
  if(hasThcs && hasThpt) return 'THCS-THPT';
  if(hasThpt) return 'THPT';
  if(hasThcs) return 'THCS';
  return '';
}
function firstSchoolValue(source, keys){
  for(const key of keys){
    if(source && source[key] !== undefined && source[key] !== null && String(source[key]).trim()) return source[key];
  }
  return '';
}
function normaliseSchool(data, fallbackName=''){
  const source = typeof data === 'string' ? {schoolName:data} : (data || {});
  const schoolName = String(firstSchoolValue(source, ['officialName','official_name','tenChinhThuc','schoolName','school_name','school','truongHoc','truong','name']) || fallbackName || '').trim().replace(/\s+/g,' ');
  const wardName = String(firstSchoolValue(source, ['wardName','ward_name','phuongName','phuong_name','tenPhuong','ten_phuong','xaName','xa_name','tenXa','ten_xa','phuongXa','phuong_xa','ward','commune','communeName','commune_name','phuong','xa']) || '').trim().replace(/\s+/g,' ');
  const provinceName = String(firstSchoolValue(source, ['provinceName','province_name','tinhThanh','tinh_thanh','tinhThanhPho','tinh_thanh_pho','cityName','city_name','tinh','thanhPho','thanh_pho','province','city']) || '').trim().replace(/\s+/g,' ');
  const districtName = String(firstSchoolValue(source, ['districtName','district_name','quanHuyen','quan_huyen','huyen','quan','district']) || '').trim().replace(/\s+/g,' ');
  const provinceCode = String(firstSchoolValue(source, ['provinceCode','province_code','maTinh','ma_tinh','tinhCode','tinh_code']) || '').trim();
  const wardCode = String(firstSchoolValue(source, ['wardCode','ward_code','maPhuong','ma_phuong','maXa','ma_xa','xaCode','xa_code']) || '').trim();
  const address = String(firstSchoolValue(source, ['address','diaChi','dia_chi','địa chỉ']) || '').trim().replace(/\s+/g,' ');
  const locationKey = [schoolName, wardName, districtName, provinceName].filter(Boolean).join('-');
  const schoolId = String(firstSchoolValue(source, ['schoolId','school_id','schoolCode','school_code','unitCode','unit_code','maTruong','ma_truong','maDonVi','ma_don_vi','code','id']) || (locationKey ? schoolKey(locationKey) : '')).trim();
  const rawLevel = String(firstSchoolValue(source, ['schoolLevel','school_level','level','cap','capHoc','cap_hoc','loaiHinh','loai_hinh']) || '').trim().toUpperCase();
  let schoolLevel = rawLevel === 'THCS-THPT' || rawLevel === 'THCS' || rawLevel === 'THPT' ? rawLevel : '';
  if(!schoolLevel && /^(2|II)$/.test(rawLevel)) schoolLevel = 'THCS';
  if(!schoolLevel && /^(3|III)$/.test(rawLevel)) schoolLevel = 'THPT';
  if(!schoolLevel) schoolLevel = detectSchoolLevel(rawLevel + ' ' + schoolName);
  return { schoolId, schoolName, schoolLevel, wardName, districtName, provinceName, provinceCode, wardCode, address };
}
function schoolLabel(data){
  const school = normaliseSchool(data);
  const location = [school.wardName, school.districtName, school.provinceName].filter(Boolean).join(', ');
  return school.schoolName + (location ? ' — ' + location : '');
}
function isCompleteSchool(data){
  const school = normaliseSchool(data);
  return !!(school.schoolId && school.schoolName && school.schoolLevel && school.wardName && school.provinceName);
}
function schoolMatches(left, right){
  const a = normaliseSchool(left); const b = normaliseSchool(right);
  if(!a.schoolName || !b.schoolName) return false;
  if(a.schoolId && b.schoolId && a.schoolId === b.schoolId) return true;
  if(normaliseIdentity(a.schoolName) !== normaliseIdentity(b.schoolName)) return false;
  const hasLocation = a.wardName || a.provinceName || b.wardName || b.provinceName;
  if(hasLocation){
    return !!a.wardName && !!b.wardName && !!a.provinceName && !!b.provinceName &&
      normaliseIdentity(a.wardName) === normaliseIdentity(b.wardName) &&
      normaliseIdentity(a.provinceName) === normaliseIdentity(b.provinceName);
  }
  return true;
}
function schoolValidationMessage(school){
  if(!school || !school.schoolName) return 'Cậu chọn trường học nhé.';
  if(!school.schoolId || !school.schoolLevel) return 'Cậu chọn trường THCS/THPT trong danh mục nhé.';
  if(!school.wardName || !school.provinceName) return 'Danh mục trường này chưa có đủ phường/xã và tỉnh/thành, cậu chọn lại giúp mình nhé.';
  return '';
}
function schoolFromFields(selectId){
  const select = $(selectId);
  if(!select) return normaliseSchool('');
  const listed = SchoolDirectory.schools.find(item=>item.schoolId === select.value);
  return listed ? normaliseSchool(listed) : normaliseSchool('');
}

const SchoolDirectory = {
  schools:[], loaded:false, loading:null, lastUpdatedAt:0, loadError:null,
  addLocal(data){
    const school = normaliseSchool(data);
    if(data && data.active === false) return school;
    if(!isCompleteSchool(school)) return school;
    const index = this.schools.findIndex(item=>item.schoolId === school.schoolId);
    if(index === -1) this.schools.push(school); else this.schools[index] = Object.assign({}, this.schools[index], school);
    this.schools.sort((a,b)=>schoolLabel(a).localeCompare(schoolLabel(b),'vi'));
    return school;
  },
  async load(){
    if(this.loaded) return this.schools;
    if(this.loading) return this.loading;
    this.loading = (async()=>{
      try{
        const snap = await DB.collection('schools').get();
        (snap.docs || []).forEach(doc=>{
          const data = doc.data() || {};
          this.lastUpdatedAt = Math.max(this.lastUpdatedAt, Number(data.syncedAt || data.updatedAt || 0));
          this.addLocal(data);
        });
      }catch(e){ this.loadError = e; }
      this.loaded = true;
      this.loading = null;
      return this.schools;
    })();
    return this.loading;
  },
  has(data){
    const school = normaliseSchool(data);
    return !!this.schools.find(item=>schoolMatches(item, school));
  },
  async populate(selectId, selected){
    const select = $(selectId); if(!select) return;
    const selectedSchool = normaliseSchool(selected);
    select.innerHTML = '<option value="">Đang tải danh mục trường…</option>';
    await this.load();
    const items = this.schools.slice();
    let html = items.length ? '<option value="">— Chọn trường —</option>' : '<option value="">Danh mục trường đang được cập nhật…</option>';
    html += items.map(item=>'<option value="'+escapeHtml(item.schoolId)+'">'+escapeHtml(schoolLabel(item))+'</option>').join('');
    select.innerHTML = html;
    const selectedItem = items.find(item=>schoolMatches(item, selectedSchool));
    if(selectedItem) select.value = selectedItem.schoolId;
    else select.value = '';
    select.dataset.schoolReady = items.length ? 'true' : 'false';
  }
};

async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

const App = {
  goLanding(){
    state.pendingKhoi = null;
    state.pendingSchool = null;
    state.pendingSurvey = false;
    showView('view-landing');
    const account = getActiveAccount();
    SchoolDirectory.populate('schoolSelect', account || '');
    if(typeof AccountMenu !== 'undefined') AccountMenu.render();
  },
  goChat(){
    if(!getActiveAccount()){ this.goStudentAuth('login'); return; }
    showView('view-chat');
    if(typeof ChatHistory !== 'undefined') ChatHistory.openCurrent({adminFreeform:!!state.admin});
    if(typeof Settings !== 'undefined') Settings.maybeOpenForAccount();
  },
  goLibrary(){ showView('view-library'); Library.load(); },
  goAdminAuth(){ if(state.admin){ AdminAuth.onLoggedIn(); } else { showView('view-adminAuth'); AdminAuth.prefillSchool(); } },
  goStudentAuth(mode){
    StudentAuth.switchTab(mode || 'login');
    showView('view-studentAuth');
    StudentAuth.prefillGrade();
    StudentAuth.prefillSchool();
  },
  startSurvey(){
    const khoi = $('khoiSelect').value;
    const chosenSchool = schoolFromFields('schoolSelect');
    const accountSchool = getActiveAccount();
    const school = isCompleteSchool(chosenSchool) ? chosenSchool : normaliseSchool(accountSchool || '');
    if(!khoi){ $('startErr').textContent = 'Cậu chọn khối lớp giúp mình nhé.'; return; }
    const schoolError = schoolValidationMessage(school);
    if(schoolError){ $('startErr').textContent = schoolError; return; }
    $('startErr').textContent = '';
    state.pendingKhoi = khoi;
    state.pendingSchool = school;
    if(accountSchool && isCompleteSchool(accountSchool) && chosenSchool.schoolId && !schoolMatches(accountSchool, chosenSchool)){
      $('startErr').textContent = 'Tài khoản này thuộc '+schoolLabel(accountSchool)+'. Cậu không thể chọn trường khác.';
      return;
    }
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
    if(!khoi){ showView('view-landing'); $('startErr').textContent = 'Cậu chọn khối lớp giúp mình nhé.'; return; }
    const accountSchool = getActiveAccount();
    const school = accountSchool && isCompleteSchool(accountSchool) ? normaliseSchool(accountSchool) : (state.pendingSchool || normaliseSchool(accountSchool || ''));
    const schoolError = schoolValidationMessage(school);
    if(schoolError){ showView('view-landing'); $('startErr').textContent = schoolError; return; }
    state.khoi = khoi;
    state.pendingSchool = school;
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
      session.innerHTML = '<strong>Đang dùng tài khoản học sinh: '+escapeHtml(account.username)+'</strong><small>'+escapeHtml(isCompleteSchool(account) ? schoolLabel(account) : 'Chưa cập nhật trường')+'</small>';
      if(logoutBtn){ logoutBtn.classList.remove('hidden'); logoutBtn.onclick = ()=>this.logout(); }
    }else if(account && account.role === 'admin'){
      label.textContent = 'GV: ' + account.displayName;
      session.classList.remove('hidden');
      session.innerHTML = '<strong>'+escapeHtml(account.displayName)+'</strong><small>Tài khoản: '+escapeHtml(account.username)+' · '+escapeHtml(isCompleteSchool(account) ? schoolLabel(account) : 'Chưa cập nhật trường')+'</small>';
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
    if(!/^[a-z0-9._-]{3,32}$/.test(username)){ err.textContent = 'Tên đăng nhập không hợp lệ.'; return; }
    try{
      const snap = await DB.collection('admins').doc(username).get();
      if(!snap.exists){ err.textContent = 'Không tìm thấy tài khoản quản trị này.'; return; }
      let data = snap.data();
      if(data.builtin === true && !resolveAccountDisplayName(data, '')){
        err.textContent = 'Tài khoản quản trị mẫu đã được tắt. Hãy dùng tài khoản admin thật.'; return;
      }
      if(await sha256(password) !== data.passwordHash){ err.textContent = 'Sai mật khẩu.'; return; }
      const storedSchool = normaliseSchool(data);
      const enteredSchool = schoolFromFields('adminSchool');
      if(isCompleteSchool(storedSchool) && enteredSchool.schoolId && !schoolMatches(storedSchool, enteredSchool)){
        err.textContent = 'Tài khoản này đã được gán cho '+schoolLabel(storedSchool)+'.'; return;
      }
      const school = isCompleteSchool(storedSchool) ? storedSchool : enteredSchool;
      if(!isCompleteSchool(storedSchool)){
        const schoolError = schoolValidationMessage(school);
        if(schoolError){ err.textContent = 'Tài khoản admin cần được gán trường trước khi vào Dashboard. '+schoolError; return; }
        await DB.collection('admins').doc(username).update(Object.assign({}, school, {schoolUpdatedAt:Date.now()}));
        data = Object.assign({}, data, school);
      }
      state.admin = normaliseAdminAccount(data, username);
      localStorage.setItem('hp_admin_session', state.admin.username);
      try{ await DB.collection('admins').doc(username).update({lastLoginAt:Date.now()}); }catch(e){}
      await AdminAuth.onLoggedIn();
    }catch(e){ err.textContent = 'Có lỗi khi đăng nhập, thử lại nhé.'; }
  },
  async onLoggedIn(){
    state.admin = normaliseAdminAccount(state.admin, state.admin && state.admin.username);
    if(!isCompleteSchool(state.admin)){
      this.prefillSchool();
      showView('view-adminAuth');
      $('adminErr').textContent = 'Tài khoản admin chưa được gán trường. Cậu chọn trường rồi đăng nhập lại nhé.';
      return;
    }
    if(state.student){
      state.student = null;
      AIBackend.useStudentKey(null);
      localStorage.removeItem('hp_student_session');
    }
    AIBackend.useAccountKey(state.admin);
    if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForAccount();
    const adminName = resolveAccountDisplayName(state.admin, state.admin.username);
    $('adminNameChip').textContent = adminName;
    $('adminSchoolChip').textContent = schoolLabel(state.admin);
    AccountMenu.render();
    toast('Xin chào, ' + adminName + '!');
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
    try{
      const snap = await DB.collection('admins').doc(saved).get();
      if(snap.exists){
        const data = snap.data();
        if(data.builtin === true && !resolveAccountDisplayName(data, '')){
          localStorage.removeItem('hp_admin_session');
          return;
        }
        state.admin = normaliseAdminAccount(data, saved);
        if(!isCompleteSchool(state.admin)){
          this.prefillSchool();
          showView('view-adminAuth');
          $('adminErr').textContent = 'Tài khoản admin cũ chưa có trường. Cậu đăng nhập lại và chọn trường để tiếp tục nhé.';
          return;
        }
        AIBackend.useAccountKey(state.admin);
        AccountMenu.render();
        renderSteps('view-landing');
        if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForAccount();
      }else localStorage.removeItem('hp_admin_session');
    }catch(e){}
  },
  prefillSchool(){
    SchoolDirectory.populate('adminSchool', state.admin || '');
  }
};

/* =================== học sinh: đăng nhập & tạo tài khoản =================== */
const StudentAuth = {
  setStudent(data, fallbackUsername){
    const username = data.username || fallbackUsername;
    const school = normaliseSchool(data);
    state.student = {
      username,
      displayName:data.displayName || username,
      khoi:data.khoi || '',
      schoolId:school.schoolId,
      schoolName:school.schoolName,
      schoolLevel:school.schoolLevel,
      wardName:school.wardName,
      districtName:school.districtName,
      provinceName:school.provinceName,
      provinceCode:school.provinceCode,
      wardCode:school.wardCode,
      address:school.address,
      role:'student',
      createdAt:data.createdAt || null,
      geminiApiKey:data.geminiApiKey || data.apiKey || data.geminiKey || null
    };
    AIBackend.useStudentKey(state.student);
  },
  hasSchool(data){ return isCompleteSchool(data); },
  openSchoolSetup(){
    this.switchTab('school');
    showView('view-studentAuth');
    this.prefillSchool();
  },
  switchTab(tab){
    const isRegister = tab === 'register';
    const isForgot = tab === 'forgot';
    const isSchoolSetup = tab === 'school';
    $('studentAuthTabs').classList.toggle('hidden', isForgot || isSchoolSetup);
    $('studentTabLogin').classList.toggle('active', !isRegister);
    $('studentTabRegister').classList.toggle('active', isRegister);
    $('studentNameField').classList.toggle('hidden', !(isRegister || isForgot));
    $('studentGradeField').classList.toggle('hidden', !(isRegister || isForgot));
    $('studentSchoolField').classList.toggle('hidden', !(isRegister || isForgot || isSchoolSetup));
    $('studentUsernameField').classList.toggle('hidden', isSchoolSetup);
    $('studentPasswordField').classList.toggle('hidden', isSchoolSetup);
    $('studentConfirmField').classList.toggle('hidden', !(isRegister || isForgot));
    $('studentAuthTitle').textContent = isRegister ? 'Tạo tài khoản học sinh' : (isForgot ? 'Quên mật khẩu học sinh' : (isSchoolSetup ? 'Bổ sung trường học' : 'Đăng nhập học sinh'));
    $('studentAuthSubtitle').textContent = isRegister ? 'Tạo tài khoản để bắt đầu khảo sát hoạt động thể lực.' : (isForgot ? 'Nhập đúng thông tin đã dùng khi tạo tài khoản để đặt mật khẩu mới.' : (isSchoolSetup ? 'Tài khoản cũ chưa có trường. Cậu bổ sung một lần để hệ thống phân loại đúng dữ liệu của trường nhé.' : 'Đăng nhập để bắt đầu khảo sát hoạt động thể lực.'));
    $('studentSubmitBtn').textContent = isRegister ? 'Tạo tài khoản học sinh' : (isForgot ? 'Đặt lại mật khẩu' : (isSchoolSetup ? 'Lưu trường học' : 'Đăng nhập'));
    $('studentSubmitBtn').dataset.mode = tab;
    const passwordLabel = $('studentPasswordLabel');
    const confirmLabel = $('studentPasswordConfirmLabel');
    if(passwordLabel) passwordLabel.textContent = isForgot ? 'Mật khẩu mới' : 'Mật khẩu';
    if(confirmLabel) confirmLabel.textContent = isForgot ? 'Nhập lại mật khẩu mới' : 'Nhập lại mật khẩu';
    $('studentPassword').setAttribute('autocomplete', isRegister || isForgot ? 'new-password' : 'current-password');
    $('studentAuthSwitch').innerHTML = isSchoolSetup
      ? '<button onclick="StudentAuth.switchTab(\'login\')">Quay lại đăng nhập</button>'
      : (isRegister
      ? 'Đã có tài khoản? <button onclick="StudentAuth.switchTab(\'login\')">Đăng nhập</button>'
      : (isForgot
        ? '<button onclick="StudentAuth.switchTab(\'login\')">Quay lại đăng nhập</button>'
        : 'Chưa có tài khoản? <button onclick="StudentAuth.switchTab(\'register\')">Tạo tài khoản học sinh</button> · <button onclick="StudentAuth.switchTab(\'forgot\')">Quên mật khẩu?</button>'));
    $('studentErr').textContent = '';
    if(isRegister || isForgot) this.prefillGrade();
    if(isRegister || isForgot || isSchoolSetup) this.prefillSchool();
    refreshIcons();
  },
  prefillGrade(){
    const preferred = state.pendingKhoi || $('khoiSelect').value || '';
    if(preferred && $('studentGrade')) $('studentGrade').value = preferred;
  },
  prefillSchool(){
    const preferred = state.pendingSchool || state.student || $('schoolSelect') && schoolFromFields('schoolSelect');
    SchoolDirectory.populate('studentSchool', preferred || '');
  },
  async submit(){
    const mode = $('studentSubmitBtn').dataset.mode || 'login';
    const isRegister = mode === 'register';
    const isForgot = mode === 'forgot';
    const isSchoolSetup = mode === 'school';
    if(isSchoolSetup){
      const school = schoolFromFields('studentSchool');
      const schoolError = schoolValidationMessage(school);
      const err = $('studentErr'); err.textContent = '';
      if(!state.student){ err.textContent = 'Cậu đăng nhập tài khoản trước nhé.'; return; }
      if(schoolError){ err.textContent = schoolError; return; }
      try{
        await DB.collection('students').doc(state.student.username).update(Object.assign({}, school, {schoolUpdatedAt:Date.now()}));
        state.student = Object.assign({}, state.student, school);
        state.pendingSchool = school;
        this.switchTab('login');
        toast('Đã lưu trường học cho tài khoản.');
        await this.finishLoggedIn();
      }catch(e){ err.textContent = 'Chưa lưu được trường học, cậu thử lại nhé.'; }
      return;
    }
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
      const school = schoolFromFields('studentSchool');
      const confirm = $('studentPasswordConfirm').value;
      if(displayName.length < 2){ err.textContent = 'Cậu nhập họ và tên nhé.'; return; }
      if(!khoi){ err.textContent = 'Cậu chọn khối lớp nhé.'; return; }
      const schoolError = schoolValidationMessage(school);
      if(schoolError){ err.textContent = schoolError; return; }
      if(password !== confirm){ err.textContent = 'Hai lần nhập mật khẩu chưa giống nhau.'; return; }
      try{
        const existing = await DB.collection('students').doc(username).get();
        if(isForgot){
          if(!existing.exists){ err.textContent = 'Thông tin xác thực chưa khớp với tài khoản học sinh.'; return; }
          const account = existing.data();
          if(normaliseIdentity(account.displayName) !== normaliseIdentity(displayName) || String(account.khoi || '') !== String(khoi) || !schoolMatches(account, school)){
            err.textContent = 'Thông tin xác thực chưa khớp với tài khoản học sinh.'; return;
          }
          await DB.collection('students').doc(username).update({ passwordHash:await sha256(password), passwordUpdatedAt:Date.now() });
          this.switchTab('login');
          $('studentUsername').value = username;
          $('studentPassword').value = '';
          $('studentPasswordConfirm').value = '';
          $('studentName').value = '';
          $('studentGrade').value = '';
          $('studentSchool').value = '';
          toast('Cập nhật mật khẩu thành công. Cậu đăng nhập lại nhé.');
          return;
        }
        if(existing.exists){ err.textContent = 'Tài khoản đăng nhập này đã tồn tại. Cậu chọn tên đăng nhập khác nhé.'; return; }
        const doc = { username, displayName, khoi, role:'student', schoolId:school.schoolId, schoolName:school.schoolName, schoolLevel:school.schoolLevel, wardName:school.wardName, districtName:school.districtName, provinceName:school.provinceName, provinceCode:school.provinceCode, wardCode:school.wardCode, address:school.address, passwordHash: await sha256(password), geminiApiKey:null, createdAt: Date.now() };
        await DB.collection('students').doc(username).set(doc);
        this.setStudent(doc, username);
        state.pendingSchool = school;
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
    if(!this.hasSchool(state.student)){
      this.openSchoolSetup();
      $('studentErr').textContent = 'Tài khoản này chưa có trường. Cậu chọn trường để tiếp tục nhé.';
      return;
    }
    await this.finishLoggedIn();
  },
  async finishLoggedIn(options={}){
    this.renderSession();
    if(!options.silent) toast('Xin chào, ' + state.student.displayName + '!');
    if(typeof ChatHistory !== 'undefined') await ChatHistory.restoreForStudent();
    if(state.pendingSurvey){ App.beginSurvey(); }
    else { App.goLanding(); Settings.maybeOpenForStudent(); }
  },
  renderSession(){
    if(!state.student){ AccountMenu.render(); return; }
    if(state.student.khoi && $('khoiSelect') && !state.pendingKhoi) $('khoiSelect').value = state.student.khoi;
    SchoolDirectory.populate('schoolSelect', state.student);
    AccountMenu.render();
  },
  logout(){
    if(typeof ChatHistory !== 'undefined') ChatHistory.forgetSession();
    state.student = null;
    AIBackend.useStudentKey(null);
    localStorage.removeItem('hp_student_session');
    state.pendingKhoi = null; state.pendingSchool = null; state.pendingSurvey = false;
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
      if(!this.hasSchool(state.student)){
        this.openSchoolSetup();
        return;
      }
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
      ownerSchoolId:account && account.schoolId || '',
      ownerSchoolName:account && account.schoolName || '',
      ownerSchoolWardName:account && account.wardName || '',
      ownerSchoolProvinceName:account && account.provinceName || '',
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
        schoolId:account.schoolId || '',
        schoolName:account.schoolName || '',
        wardName:account.wardName || '',
        provinceName:account.provinceName || '',
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
    if(!account){ toast('Cậu đăng nhập tài khoản trước nhé'); App.goStudentAuth('login'); return; }
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
    const weeklySummary = getWeeklySummaryForConversation(this.current);
    if(weeklySummary) renderWeeklySummaryCard(weeklySummary);
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
    const summary = getWeeklySummaryForConversation(this.current);
    const summaryContext = summary
      ? '\n\nTỔNG KẾT TUẦN GẦN NHẤT: mức '+summary.level+', khoảng '+summary.minutes+' phút/tuần. Gợi ý: '+summary.recommendation+'. Đã thử: '+(summary.tried ? 'có' : 'chưa')
      : '';
    const previous = this.conversations.filter(c=>c.id!==this.current.id && c.messages && c.messages.length).slice(0,4).map(c=>{
      const last = c.messages.slice(-3).map(m=>(m.role==='user'?userLabel:'Chatbot')+': '+m.text).join(' | ');
      return '- '+(c.title||'Cuộc trò chuyện trước')+' ('+chatDate(c.updatedAt)+'): '+last;
    }).join('\n');
    return ('LỊCH SỬ CUỘC TRÒ CHUYỆN HIỆN TẠI:\n'+current+summaryContext+'\n\nTÓM TẮT CÁC CUỘC TRÒ CHUYỆN TRƯỚC CÙNG TÀI KHOẢN:\n'+previous).slice(-maxChars);
  }
};


/* =================== 6 câu hỏi khảo sát (đúng Prompt Log, Mục 3.2) =================== */
const QUESTIONS = [
  { id:'dichuyen', field:'di_chuyen_phut_tuan',
    ask:"Chào cậu! Mình cùng tìm hiểu xem một tuần cậu vận động thế nào nhé. Trước tiên, cậu có đi bộ hoặc đạp xe để đến trường không? Nếu có thì mỗi lần đi mất khoảng bao lâu, và mấy ngày một tuần cậu đi như vậy?",
    clarify:'Cậu cho mình biết tổng số phút đi bộ hoặc đạp xe để di chuyển trong một tuần nhé (ví dụ: 150 phút/tuần). Nếu không có, cậu nói “không có” giúp mình.',
    fields:'"di_chuyen_phut_tuan": số phút/tuần đi bộ hoặc đạp xe để di chuyển (0 nếu không có)' },
  { id:'thethao', field:'the_thao_ngoai_gio_phut_tuan',
    ask:"Trong tuần, cậu có tham gia môn thể thao nào ngoài giờ học không (đá bóng, cầu lông, bơi, nhảy...)? Mỗi tuần khoảng mấy buổi, mỗi buổi bao lâu?",
    clarify:'Cậu cho mình biết tổng số phút chơi thể thao ngoài giờ trong một tuần và hoạt động đó ở mức vừa hay mạnh nhé. Nếu không có, cậu nói “không có” giúp mình.',
    fields:'"the_thao_ngoai_gio_phut_tuan": tổng số phút/tuần chơi thể thao ngoài giờ học (0 nếu không có), "cuong_do": "vua" hoặc "manh" (dựa vào môn thể thao được nhắc tới)' },
  { id:'truong', field:'van_dong_truong_hoc',
    ask:"Vào giờ ra chơi hoặc giờ thể dục ở trường, cậu có vận động mạnh (chạy nhảy, chơi thể thao) hay chủ yếu ngồi/đứng nói chuyện?",
    clarify:'Ở trường cậu vận động mạnh hay chỉ vận động nhẹ/ngồi nghỉ? Cậu chọn giúp mình một ý nhé.',
    fields:'"van_dong_truong_hoc": "manh" | "nhe" | "khong_ro"' },
  { id:'vieenha', field:'viec_nha_phut_tuan',
    ask:"Ngoài giờ học, cậu có hay làm việc nhà vận động nhiều (quét dọn, làm vườn...) không? Khoảng bao nhiêu ngày/tuần, mỗi lần khoảng bao lâu?",
    clarify:'Cậu cho mình biết tổng số phút làm việc nhà cần vận động trong một tuần nhé (ví dụ: 90 phút/tuần). Nếu không có, cậu nói “không có” giúp mình.',
    fields:'"viec_nha_phut_tuan": số phút/tuần làm việc nhà cần vận động (0 nếu không có)' },
  { id:'ngoi', field:'thoi_gian_ngoi_gio_ngay',
    ask:"Một ngày bình thường, cậu ngồi học bài, xem điện thoại/máy tính, xem TV... tổng cộng khoảng bao nhiêu tiếng?",
    clarify:'Cậu ước lượng giúp mình tổng số giờ ngồi tĩnh tại trong một ngày nhé (ví dụ: 6 giờ/ngày).',
    fields:'"thoi_gian_ngoi_gio_ngay": số giờ/ngày ngồi tĩnh tại' },
  { id:'cuoituan', field:'hoat_dong_cuoi_tuan_phut_tuan',
    ask:"Cuối tuần cậu có hoạt động gì ngoài trời không (đi dạo, đạp xe, chơi thể thao cùng gia đình/bạn bè)? Khoảng bao nhiêu phút?",
    clarify:'Cậu cho mình biết tổng số phút hoạt động ngoài trời vào cuối tuần nhé (ví dụ: 120 phút/tuần). Nếu không có, cậu nói “không có” giúp mình.',
    fields:'"hoat_dong_cuoi_tuan_phut_tuan": tổng số phút hoạt động ngoài trời cuối tuần (0 nếu không có)' },
];
const LEVEL_META = {
  'Không HĐTL': {cls:'lvl-khong', headline:'Cậu gần như chưa có thời gian vận động — mình bắt đầu từ điều nhỏ nhé!'},
  'Không đủ':   {cls:'lvl-thieu', headline:'Cậu đã vận động, nhưng chưa chạm mốc khuyến cáo — chỉ cần thêm một chút!'},
  'Đủ':         {cls:'lvl-du', headline:'Rất tốt — cậu đang vận động đúng mức khuyến cáo của Bộ Y tế!'},
  'Cao':        {cls:'lvl-cao', headline:'Xuất sắc — cậu đang vận động ở mức cao, cứ duy trì nhé!'},
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
      if(result.can_hoi_lai){
        state.hdtl.attempts++;
        ChatHistory.updateSurvey({qIndex:state.hdtl.qIndex, attempts:state.hdtl.attempts, extracted:state.hdtl.extracted});
        addMsg('ai', result.cau_hoi_lai || q.clarify);
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
          addMsg('ai', 'Cảm ơn cậu! Mình tổng hợp kết quả nhé…');
          setTimeout(Hdtl.finish, 500);
        }
      }
    }catch(err){
      removeThinking();
      const msg = AIBackend.errorMessage(err);
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
      addMsg('ai', 'Mình vẫn đang lắng nghe cậu. Cậu có thể kể thêm điều đang làm cậu thấy nặng lòng không?');
    }
    $('sendBtn').disabled = false;
  },
  async finish(){
    if(state.hdtl.completed) return;
    const computed = computeHdtl(state.hdtl.extracted);
    state.hdtl.computed = computed;
    state.hdtl.completed = true;
    state.hdtl.finishing = false;
    const account = getActiveAccount();
    const studentName = (state.student && state.student.displayName) || (account && account.displayName) || (account && account.username) || '';
    const school = normaliseSchool(account || state.student || '');
    const resultDoc = { username:account && account.username || (state.student && state.student.username) || null, displayName:studentName, schoolId:school.schoolId, schoolName:school.schoolName, schoolLevel:school.schoolLevel, wardName:school.wardName, districtName:school.districtName, provinceName:school.provinceName, provinceCode:school.provinceCode, wardCode:school.wardCode, address:school.address, khoi: state.khoi, level: computed.level, quyDoi: computed.quyDoi, committed:false, weekKey:getWeekKey(), ts: Date.now() };
    try{ state.hdtl.docRef = await DB.collection('results').add(resultDoc); }catch(e){ state.hdtl.docRef = null; }
    const fb = await generateHdtlFeedback(computed);
    const summary = buildWeeklySummary(computed, fb);
    if(state.hdtl.docRef && state.hdtl.docRef.id) summary.resultId = state.hdtl.docRef.id;
    ChatHistory.updateSurvey({khoi:state.khoi, qIndex:QUESTIONS.length, extracted:state.hdtl.extracted, computed, summary, completed:true, finishing:false});
    addMsg('ai', 'Mình đã tổng hợp kết quả tuần này cho cậu ở thẻ bên dưới nhé.');
    renderWeeklySummaryCard(summary);
    if(ChatHistory.current){ ChatHistory.current.status='completed'; ChatHistory.current.updatedAt=Date.now(); ChatHistory._saveLocal(); ChatHistory.queuePersist(); }
    updateQCount();
    updateComposer();
    ChatHistory.renderList();
  },
  async markSummaryTried(){
    const conversation = ChatHistory.current;
    const summary = getWeeklySummaryForConversation(conversation);
    if(!conversation || !summary || summary.tried) return;
    const triedAt = Date.now();
    const updatedSummary = Object.assign({}, summary, {tried:true, triedAt});
    ChatHistory.updateSurvey({summary:updatedSummary});
    renderWeeklySummaryCard(updatedSummary);
    if(updatedSummary.resultId){
      try{ await DB.collection('results').doc(updatedSummary.resultId).update({committed:true, committedAt:triedAt}); }catch(e){}
    }
    toast('Đã ghi nhận cậu sẽ thử hoạt động này trong tuần.');
  }
};
function updateQCount(){
  const box = $('qcount'); if(!box) return;
  if(state.hdtl && state.hdtl.finishing) box.textContent = 'Đang tổng hợp câu trả lời…';
  else if(state.hdtl && state.hdtl.adminChat) box.textContent = 'Chatbot sẵn sàng · cậu có thể bắt đầu trò chuyện';
  else if(state.hdtl && state.hdtl.completed) box.textContent = 'Khảo sát đã hoàn tất · cậu có thể tiếp tục tâm sự bất cứ lúc nào';
  else box.textContent = 'Câu ' + ((state.hdtl && state.hdtl.qIndex || 0)+1) + ' / ' + QUESTIONS.length;
}
function updateComposer(){
  const input = $('chatInput'); const send = $('sendBtn');
  if(!input || !send) return;
  const freeform = state.hdtl && state.hdtl.completed;
  input.placeholder = freeform ? 'Chia sẻ điều cậu đang nghĩ...' : 'Trả lời câu hỏi của cậu...';
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

function getWeekKey(ts=Date.now()){
  const date = new Date(ts);
  const start = new Date(date.getFullYear(), 0, 1);
  const day = Math.floor((date - start) / 86400000);
  return date.getFullYear() + '-W' + String(Math.floor((day + start.getDay()) / 7) + 1).padStart(2, '0');
}

function buildWeeklySummary(computed, feedback=''){
  const level = LEVEL_META[computed.level] ? computed.level : 'Không đủ';
  const descriptions = {
    'Không HĐTL':'Tuần này cậu gần như chưa có hoạt động vận động. Mình bắt đầu từ một mục tiêu nhỏ, vừa sức nhé.',
    'Không đủ':'Cậu đã có một số hoạt động trong tuần nhưng vẫn còn thiếu so với mức khuyến cáo.',
    'Đủ':'Cậu đang duy trì mức vận động phù hợp với mức khuyến cáo. Tiếp tục giữ nhịp này nhé!',
    'Cao':'Tuần này cậu vận động ở mức cao. Hãy tiếp tục duy trì nhưng nhớ xen kẽ thời gian nghỉ ngơi.'
  };
  const recommendations = {
    'Không HĐTL':'Đi bộ nhanh 10 phút sau giờ học, 4 ngày/tuần.',
    'Không đủ':'Đi bộ nhanh 15 phút sau giờ học, 4 ngày/tuần.',
    'Đủ':'Duy trì hoạt động vừa đến mạnh khoảng 30 phút, 5 ngày/tuần.',
    'Cao':'Tiếp tục lịch hiện tại, uống đủ nước và xen kẽ ngày nghỉ để cơ thể hồi phục.'
  };
  return {
    title:'Tổng kết tuần',
    weekKey:getWeekKey(),
    createdAt:Date.now(),
    level,
    minutes:Math.max(0, Math.round(Number(computed.quyDoi)||0)),
    sittingHours:Math.max(0, Number(computed.gioNgoiNgay)||0),
    description:descriptions[level],
    recommendationTitle:'Thử trong tuần này',
    recommendation:recommendations[level],
    feedback:String(feedback || ''),
    tried:false,
    triedAt:null
  };
}

function getWeeklySummaryForConversation(conversation){
  if(!conversation) return null;
  const survey = conversation.survey || {};
  if(survey.summary && survey.summary.level){
    const base = survey.computed ? buildWeeklySummary(survey.computed, survey.summary.feedback || '') : {};
    return Object.assign(base, survey.summary);
  }
  if(survey.completed && survey.computed) return buildWeeklySummary(survey.computed, '');
  return null;
}

function renderWeeklySummaryCard(summary){
  const log = $('chatLog');
  if(!log || !summary) return;
  const old = log.querySelector('.weekly-summary-row');
  if(old) old.remove();
  const meta = LEVEL_META[summary.level] || LEVEL_META['Không đủ'];
  const minutes = Math.max(0, Math.round(Number(summary.minutes)||0));
  const tried = !!summary.tried;
  const feedback = String(summary.feedback || '').trim();
  const row = document.createElement('div');
  row.className = 'weekly-summary-row';
  row.innerHTML = '<article class="result-wrap weekly-summary-card" aria-label="Tổng kết vận động tuần này">' +
    '<div class="level-badge '+meta.cls+'"><span class="dot"></span>'+escapeHtml(String(summary.level).toUpperCase())+'</div>' +
    '<div class="weekly-minutes">'+minutes+'<span> phút/tuần</span></div>' +
    '<p class="weekly-summary-description">'+escapeHtml(summary.description || '')+'</p>' +
    '<div class="weekly-suggestion"><div class="weekly-suggestion-title"><i data-lucide="target"></i><strong>'+escapeHtml(summary.recommendationTitle || 'Thử trong tuần này')+'</strong></div><p>'+escapeHtml(summary.recommendation || '')+'</p></div>' +
    (feedback ? '<div class="weekly-summary-feedback"><i data-lucide="message-circle-heart"></i><span>'+escapeHtml(feedback)+'</span></div>' : '') +
    '<div class="commit-row"><button type="button" class="btn btn-primary weekly-summary-try" data-summary-action '+(tried?'disabled':'')+'><i data-lucide="'+(tried?'check':'circle-check')+'"></i> '+(tried?'Đã thử':'Mình đã thử')+'</button>'+(tried?'<span class="committed-note show"><i data-lucide="check-circle-2"></i> Đã ghi nhận cho tuần này</span>':'')+'</div>' +
    '</article>';
  log.appendChild(row);
  const button = row.querySelector('[data-summary-action]');
  if(button && !tried) button.addEventListener('click', ()=>Hdtl.markSummaryTried());
  refreshIcons();
  log.scrollTop = log.scrollHeight;
}

async function generateCompanionReply(userText){
  const account = getActiveAccount();
  const isAdmin = account && account.role === 'admin';
  const fallback = isAdmin
    ? 'Mình đã nghe cậu. Cậu hãy kể thêm điều đang quan tâm; mình sẽ cùng cậu sắp xếp suy nghĩ và tìm một hướng xử lý thực tế nhé.'
    : 'Mình đã nghe cậu. Cậu thử nói chậm lại một chút về điều đang khiến cậu mệt hoặc lo lắng; mình sẽ cùng cậu tìm một bước nhỏ, thực tế để xử lý nhé.';
  if(AIBackend.mode==='none') return fallback;
  const audience = isAdmin ? 'giáo viên hoặc quản trị viên' : 'học sinh';
  const prompt = 'Bạn là một người bạn đồng hành AI thân thiện của '+audience+'. Quy tắc xưng hô bắt buộc: xưng "mình" và gọi người dùng là "cậu"; không dùng cách gọi "em" hoặc "bạn". Hãy đọc lịch sử trò chuyện của đúng tài khoản này để nhận ra cảm xúc, mối quan tâm và cách trả lời phù hợp, rồi trả lời tin nhắn mới một cách ấm áp, cụ thể và không phán xét. Không chẩn đoán bệnh, không khẳng định chắc chắn về tâm lý. Nếu có dấu hiệu tự làm hại bản thân, nguy hiểm hoặc vấn đề y tế nghiêm trọng, hãy khuyên người dùng báo ngay cho người lớn đáng tin cậy và nhân viên y tế/dịch vụ khẩn cấp tại nơi họ sống. Trả lời bằng tiếng Việt, ngắn gọn 2–5 đoạn, ưu tiên một hoặc hai gợi ý có thể làm ngay.\n\n' +
    ChatHistory.buildContext() + '\n\nTIN NHẮN MỚI NHẤT CỦA NGƯỜI DÙNG:\n' + userText;
  try{ return await AIBackend.text(prompt); }catch(e){ return fallback; }
}

/* =================== AI xử lý dữ liệu phía sau (đúng Prompt Log, Mục 3.1) =================== */
function toFiniteNumber(value){
  if(typeof value === 'number' && Number.isFinite(value)) return value;
  if(typeof value === 'string' && /^\s*\d+(?:[.,]\d+)?\s*$/.test(value)) return Number(value.trim().replace(',', '.'));
  return null;
}

function normaliseIntensity(value){
  const text = String(value || '').trim().toLocaleLowerCase('vi-VN');
  if(text === 'manh' || text.includes('mạnh')) return 'manh';
  if(text === 'vua' || text.includes('vừa') || text.includes('trung bình')) return 'vua';
  return '';
}

function clarificationResult(q){
  return {can_hoi_lai:true, cau_hoi_lai:q.clarify};
}

function normaliseExtraction(q, raw){
  const result = raw && typeof raw === 'object' ? raw : {};
  const asksAgain = result.can_hoi_lai === true || String(result.can_hoi_lai || '').trim().toLowerCase() === 'true';
  if(asksAgain) return clarificationResult(q);

  if(q.id === 'truong'){
    const level = String(result.van_dong_truong_hoc || '').trim().toLocaleLowerCase('vi-VN');
    if(level === 'manh' || level.includes('mạnh')) return Object.assign({}, result, {van_dong_truong_hoc:'manh', can_hoi_lai:false});
    if(level === 'nhe' || level.includes('nhẹ')) return Object.assign({}, result, {van_dong_truong_hoc:'nhe', can_hoi_lai:false});
    return clarificationResult(q);
  }

  const value = toFiniteNumber(result[q.field]);
  const max = q.id === 'ngoi' ? 24 : 10080;
  if(value === null || value < 0 || value > max) return clarificationResult(q);

  const normalized = Object.assign({}, result, {[q.field]:value, can_hoi_lai:false});
  if(q.id === 'thethao'){
    const intensity = normaliseIntensity(result.cuong_do);
    if(value > 0 && !intensity) return clarificationResult(q);
    normalized.cuong_do = intensity || 'vua';
  }
  return normalized;
}

function isExplicitNoActivity(text){
  return /^(không(?:\s+có)?|ko|chưa(?:\s+từng)?|không\s+(?:đi|chơi|tham gia|làm))(?:\s|[.!?,]|$)/i.test(text.trim());
}

function fallbackExtraction(q, userText){
  const text = String(userText || '').trim().toLocaleLowerCase('vi-VN');
  if(q.id === 'truong'){
    if(/\b(?:mạnh|chạy|đá bóng|bóng đá|cầu lông|bơi|nhảy dây)\b/i.test(text)) return {van_dong_truong_hoc:'manh', can_hoi_lai:false};
    if(/\b(?:nhẹ|ngồi|đứng|nói chuyện|không vận động|nghỉ)\b/i.test(text)) return {van_dong_truong_hoc:'nhe', can_hoi_lai:false};
    return clarificationResult(q);
  }
  if(q.id !== 'ngoi' && isExplicitNoActivity(text)) return normaliseExtraction(q, Object.assign({can_hoi_lai:false}, {[q.field]:0, cuong_do:'vua'}));

  const numbers = text.match(/\d+(?:[.,]\d+)?/g) || [];
  const unitPattern = q.id === 'ngoi' ? /(?:giờ|tiếng|h)(?:\s*\/?\s*ngày)?/i : /phút\s*(?:\/|mỗi\s+)?\s*tuần|phút\/tuần/i;
  const explicitZero = numbers[0] === '0' && q.id !== 'ngoi';
  if(numbers.length !== 1 || (!explicitZero && !unitPattern.test(text))) return clarificationResult(q);

  const raw = {can_hoi_lai:false, [q.field]:Number(numbers[0].replace(',', '.'))};
  if(q.id === 'thethao'){
    const intensity = normaliseIntensity(text);
    if(raw[q.field] > 0 && !intensity) return clarificationResult(q);
    raw.cuong_do = intensity || 'vua';
  }
  return normaliseExtraction(q, raw);
}

async function extractField(q, userText){
  if(AIBackend.mode==='none') return fallbackExtraction(q, userText);
  const prompt = 'Bạn là trợ lý AI phân tích mức độ hoạt động thể lực (HĐTL) của học sinh THPT, dựa trên hướng dẫn chính thức của Bộ Y tế Việt Nam (Cẩm nang HĐTL 2026, Phụ lục 2).\n\n' +
    'Quy tắc xưng hô trong câu hỏi làm rõ: xưng "mình", gọi học sinh là "cậu".\n' +
    'Câu hỏi đã hỏi: "' + q.ask + '"\nCâu trả lời của học sinh: "' + userText + '"\n\n' +
    'Hãy trích xuất và trả về dưới dạng JSON đúng các trường sau: ' + q.fields + '.\n' +
    'Các trường số phải là number không âm, đúng đơn vị được hỏi. Nếu câu trả lời nói không có hoạt động thì trả về 0.\n' +
    'Nếu câu trả lời không có số liệu rõ ràng (ví dụ: "thỉnh thoảng", "ít", hoặc thiếu đơn vị), đặt "can_hoi_lai": true. Không tự đoán hoặc tự quy đổi khi chưa đủ dữ liệu.\n' +
    'Nếu đã đủ rõ, trả về JSON phẳng gồm đúng các trường yêu cầu, cộng thêm "can_hoi_lai": false.\n' +
    'Chỉ trả về JSON hợp lệ, không kèm chữ nào khác, không dùng markdown code fence.';
  const raw = await AIBackend.json(prompt);
  return normaliseExtraction(q, raw);
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
  const fallback = 'Cậu đang ở mức "' + computed.level + '". Cậu thử đi bộ nhanh 10 phút vào giờ ra chơi, 3 buổi/tuần nhé!';
  if(AIBackend.mode==='none') return fallback;
  const prompt = 'Bạn là trợ lý AI phân tích mức độ hoạt động thể lực (HĐTL) của học sinh THPT, dựa trên hướng dẫn chính thức của Bộ Y tế Việt Nam (Cẩm nang HĐTL 2026, Phụ lục 2).\n\n' +
    'Học sinh vừa được phân loại: mức "' + computed.level + '", tổng thời gian vận động quy đổi khoảng ' + computed.quyDoi + ' phút/tuần (mốc khuyến cáo tối thiểu là 420 phút/tuần), thời gian ngồi tĩnh tại khoảng ' + computed.gioNgoiNgay + ' giờ/ngày.\n\n' +
    'Viết lời khuyên ngắn gọn, gần gũi, KHÔNG dùng ngôn ngữ y tế khô khan. Phải bao gồm:\n' +
    '1. Nhận xét ngắn về mức độ hiện tại (khích lệ, không chê trách)\n' +
    '2. Đúng 1-2 gợi ý HÀNH ĐỘNG CỤ THỂ, khả thi trong tuần (VD: "Thử đi bộ nhanh 10 phút vào giờ ra chơi, 3 buổi/tuần"), dựa trên loại hình phù hợp lứa tuổi 5-17 (đi bộ nhanh, đạp xe, nhảy dây, bóng chuyền, cầu lông...)\n' +
    '3. Không dùng thuật ngữ MET, không liệt kê số liệu phức tạp\n\n' +
    'Giọng văn: thân thiện như một người anh/chị hướng dẫn, không phải bác sĩ. Bắt buộc xưng "mình", gọi học sinh là "cậu"; không dùng "em" hoặc "bạn". Chỉ trả về đoạn văn, không tiêu đề.\n\n' +
    'Nếu phù hợp, tham khảo thêm lịch sử trò chuyện sau để lời khuyên hợp với cảm xúc của cậu:\n' + ChatHistory.buildContext(5000);
  try{ return await AIBackend.text(prompt); }catch(e){ return fallback; }
}

/* =================== 4. Dashboard (GV/BGH) =================== */
const KHOI_ORDER = ['6','7','8','9','10','11','12'];
const LEVEL_ICON_COLOR = {'Không HĐTL':'#FF5D5D','Không đủ':'#FFB74D','Đủ':'#2F8F7D','Cao':'#123C3B'};
let allResults = [];
let rawResults = [];
let allStudents = [];
const Dashboard = {
  started:false,
  resultsStop:null,
  studentsStop:null,
  load(){
    if(this.started){ this.applyFilter(); return; }
    this.started = true;
    this.resultsStop = DB.collection('results').onSnapshot((snap)=>{
      rawResults = snap.docs.map(d=>Object.assign({id:d.id}, d.data()));
      Dashboard.rebuildResults();
      Dashboard.applyFilter();
    }, ()=>{ Dashboard.showLoadError(); });
    this.studentsStop = DB.collection('students').onSnapshot((snap)=>{
      allStudents = snap.docs.map(d=>Object.assign({id:d.id}, d.data()));
      Dashboard.rebuildResults();
      Dashboard.applyFilter();
    }, ()=>{
      // Vẫn hiển thị kết quả với tài khoản đã lưu nếu danh sách học sinh chưa tải được.
      Dashboard.rebuildResults();
      Dashboard.applyFilter();
    });
  },
  rebuildResults(){
    const byUsername = {};
    allStudents.forEach(student=>{
      const username = String(student.username || student.id || '').trim().toLowerCase();
      if(username) byUsername[username] = student;
    });
    allResults = rawResults.map(result=>{
      const username = String(result.username || '').trim();
      const student = byUsername[username.toLowerCase()] || {};
      const school = normaliseSchool({
        schoolId:result.schoolId || student.schoolId,
        schoolName:result.officialName || result.schoolName || student.officialName || student.schoolName || student.school || student.truongHoc,
        schoolLevel:result.schoolLevel || student.schoolLevel,
        wardName:result.wardName || student.wardName,
        districtName:result.districtName || student.districtName,
        provinceName:result.provinceName || student.provinceName,
        provinceCode:result.provinceCode || student.provinceCode,
        wardCode:result.wardCode || student.wardCode,
        address:result.address || student.address
      });
      return Object.assign({}, result, {
        username: username || String(student.username || student.id || '').trim(),
        displayName: resolveAccountDisplayName(result, resolveAccountDisplayName(student, 'Chưa cập nhật')),
        schoolId: school.schoolId,
        schoolName: school.schoolName,
        schoolLevel: school.schoolLevel,
        wardName: school.wardName,
        districtName: school.districtName,
        provinceName: school.provinceName,
        provinceCode: school.provinceCode,
        wardCode: school.wardCode,
        address: school.address,
        khoi: result.khoi || student.khoi || ''
      });
    });
  },
  showLoadError(){
    const message = '<div class="empty-dash">Không thể tải dữ liệu lúc này.</div>';
    if($('dashBars')) $('dashBars').innerHTML = message;
    if($('studentResultTable')) $('studentResultTable').innerHTML = message;
    if($('studentResultCount')) $('studentResultCount').textContent = '';
  },
  applyFilter(){
    const filter = $('khoiFilter');
    if(!filter) return;
    const account = getActiveAccount();
    const adminSchool = normaliseSchool(account || '');
    if(!isCompleteSchool(adminSchool)){
      $('dashTotal').textContent = '0';
      $('dashTopLevel').textContent = '—';
      if($('dashBars')) $('dashBars').innerHTML = '<div class="empty-dash">Tài khoản admin chưa được gán trường nên chưa thể xem dữ liệu.</div>';
      if($('pctTable')) $('pctTable').innerHTML = '<div class="empty-dash">Hãy đăng nhập lại và chọn đúng trường quản lý.</div>';
      if($('studentResultTable')) $('studentResultTable').innerHTML = '<div class="empty-dash">Chưa có phạm vi trường để hiển thị dữ liệu.</div>';
      if($('studentResultCount')) $('studentResultCount').textContent = '';
      if($('highlightNote')) $('highlightNote').classList.add('hidden');
      if($('dashWorstKhoi')) $('dashWorstKhoi').textContent = '—';
      return;
    }
    const khoi = filter.value;
    const schoolResults = allResults.filter(result=>schoolMatches(result, adminSchool));
    $('dashTotal').textContent = schoolResults.length;
    const filtered = khoi==='all' ? schoolResults : schoolResults.filter(r=>String(r.khoi||'')===String(khoi));
    renderBars(filtered);
    renderPctTable(schoolResults, khoi);
    renderStudentResults(filtered);
    Dashboard.renderSummaryStats(schoolResults);
  },
  renderSummaryStats(rows){
    rows = rows || [];
    if(rows.length===0){ $('dashTopLevel').textContent='—'; return; }
    const counts = {'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0};
    rows.forEach(r=>{ if(counts[r.level]!==undefined) counts[r.level]++; });
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
  rows.forEach(r=>{ const khoi = String(r.khoi || ''); if(!byKhoi[khoi]) byKhoi[khoi]={'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0}; if(byKhoi[khoi][r.level]!==undefined) byKhoi[khoi][r.level]++; });
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
  rows.forEach(r=>{ const khoi = String(r.khoi || ''); if(!byKhoi[khoi]) byKhoi[khoi]={'Không HĐTL':0,'Không đủ':0,'Đủ':0,'Cao':0}; if(byKhoi[khoi][r.level]!==undefined) byKhoi[khoi][r.level]++; });
  let html = '<table class="pct-table"><thead><tr><th>Khối</th><th>Không HĐTL</th><th>Không đủ</th><th>Đủ</th><th>Cao</th></tr></thead><tbody>';
  let worstKhoi=null, worstPct=-1;
  KHOI_ORDER.forEach(k=>{
    const c = byKhoi[k]; const total = Object.values(c).reduce((a,b)=>a+b,0);
    if(total===0) return;
    const pct = (n)=> Math.round(n/total*100)+'%';
    const thieuPct = (c['Không HĐTL']+c['Không đủ'])/total*100;
    if(thieuPct > worstPct){ worstPct = thieuPct; worstKhoi = k; }
    const style = selectedKhoi!=='all' && String(selectedKhoi)===String(k) ? ' style="background:var(--paper);"' : '';
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

function resultWeekLabel(result){
  const week = String(result.weekKey || '').trim();
  if(week) return week;
  if(result.ts){
    try{ return 'Tuần ' + getWeekKey(Number(result.ts)); }catch(e){}
  }
  return '—';
}

function resultLevelClass(level){
  return {'Không HĐTL':'lvl-khong','Không đủ':'lvl-thieu','Đủ':'lvl-du','Cao':'lvl-cao'}[level] || 'lvl-thieu';
}

function renderStudentResults(rows){
  const wrap = $('studentResultTable');
  const count = $('studentResultCount');
  if(!wrap) return;
  const sorted = rows.slice().sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0));
  const studentCount = new Set(sorted.map(r=>String(r.username||'').trim().toLowerCase()).filter(Boolean)).size;
  if(count) count.textContent = sorted.length ? sorted.length + ' bản ghi · ' + studentCount + ' học sinh' : '';
  if(!sorted.length){ wrap.innerHTML = '<div class="empty-dash">Chưa có kết quả khảo sát của học sinh.</div>'; return; }
  let html = '<div class="student-results-table-wrap"><table class="student-results-table"><thead><tr><th>Tài khoản</th><th>Họ tên</th><th>Trường / địa bàn</th><th>Khối</th><th>Tuần</th><th>Số phút/tuần</th><th>Kết quả</th><th>Đã thử</th></tr></thead><tbody>';
  sorted.forEach(result=>{
    const minutes = Number(result.quyDoi);
    const minuteLabel = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) + ' phút' : '—';
    const level = String(result.level || '—');
    html += '<tr>' +
      '<td class="student-username">' + escapeHtml(result.username || '—') + '</td>' +
      '<td class="student-full-name">' + escapeHtml(result.displayName || 'Chưa cập nhật') + '</td>' +
      '<td>' + escapeHtml(isCompleteSchool(result) ? schoolLabel(result) : (result.schoolName || 'Chưa cập nhật')) + '</td>' +
      '<td>Khối ' + escapeHtml(result.khoi || '—') + '</td>' +
      '<td>' + escapeHtml(resultWeekLabel(result)) + '</td>' +
      '<td class="student-minutes">' + escapeHtml(minuteLabel) + '</td>' +
      '<td><span class="student-level-chip ' + resultLevelClass(level) + '">' + escapeHtml(level) + '</span></td>' +
      '<td><span class="student-commit ' + (result.committed ? 'yes' : '') + '">' + (result.committed ? 'Đã thử' : 'Chưa đánh dấu') + '</span></td>' +
      '</tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

/* init */
renderSteps('view-landing');
refreshIcons();
bootAI();
