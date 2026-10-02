/* =====================================================================

   AI HealthPulse — Apps Script lưu TOÀN BỘ dữ liệu vào MỘT trang: "Trang tính1"

   ---------------------------------------------------------------------

   • Mỗi dòng = 1 bản ghi. Khóa của dòng = LOẠI DỮ LIỆU + MÃ BẢN GHI.

       LOẠI DỮ LIỆU: students | admins | results | conversations | references | healthDaily | healthPeriods

   • Cột DỮ LIỆU ĐẦY ĐỦ (JSON) là bản gốc; các cột còn lại là bản dễ đọc.

   • Thầy cô SỬA TRỰC TIẾP ô ở cột thường (Họ và tên, Khối lớp, Trường, Trạng thái, Đang hoạt động…)

     → web đọc được ngay bản đã sửa (cột thường được ưu tiên hơn JSON). Cột tiêu đề màu xám = chỉ xem.

   • CHỈ dùng 1 trang "Trang tính1" — script KHÔNG tạo tab nào khác. Nếu thấy tab students / conversations /

     healthDaily tự sinh ra: đó là bản Apps Script CŨ vẫn đang chạy → xóa file .gs cũ trong dự án Apps Script

     (chỉ giữ file này) và tạo "Phiên bản mới" khi triển khai (xem bước 4).

   • Lịch sử trò chuyện nằm NGAY TRÊN DÒNG TÀI KHOẢN, ở cột LỊCH SỬ TRÒ CHUYỆN (JSON). Nếu dài quá 50.000 ký tự/ô,

     script tự nén (bắt đầu bằng "gz:"), vẫn quá dài thì bỏ bớt cuộc trò chuyện cũ nhất.

   • Giữ nguyên giao diện API cũ nên KHÔNG cần sửa trang web:

       GET  ?action=list&collection=X          → {docs:[{id,data}]}

       GET  ?action=get&collection=X&id=Y      → {exists,data}

       POST {action:'set'|'update'|'delete'|'add', collection, id, data}   (add → {id})



   CÁCH CÀI:

   1) Mở Google Sheet → Tiện ích mở rộng → Apps Script → xóa code cũ → dán toàn bộ file này → Lưu.

   2) Tải lại trang Sheet → menu "AI HealthPulse" → "1. Thiết lập Trang tính1" (tự thêm cột thiếu, định dạng).

   3) (Nếu đang có tab cũ students/conversations/healthDaily/…) → "2. Chuyển dữ liệu từ các tab cũ…" → chọn Có để xóa tab cũ.

   4) Triển khai → Quản lý các bản triển khai → bút chì (Sửa) → Phiên bản: "Phiên bản mới" → Triển khai.

      (Sửa bản triển khai cũ thì URL /exec GIỮ NGUYÊN, không phải sửa SHEETS_API_URL trên web.)

      Lần đầu: Triển khai mới → Ứng dụng web → Thực thi: Tôi · Ai có quyền truy cập: Bất kỳ ai.

   ===================================================================== */



const SHEET_NAME = 'Trang tính1';

const VERSION = 'HP-TrangTinh1-v4';     // web kiểm tra số này để biết Apps Script đã được triển khai bản mới

const TZ = 'Asia/Ho_Chi_Minh';

const MAX_CELL = 49000;                 // Google Sheets: tối đa 50.000 ký tự / ô

const COLLECTIONS = ['students', 'admins', 'results', 'conversations', 'references', 'healthDaily', 'healthPeriods'];

const ACC = ['students', 'admins'];

const HEALTH = ['healthDaily', 'healthPeriods'];

// ---------- cấu hình hỗ trợ bảng / auto-fit ----------
const AUTO_FIT_KEY = 'HP_AUTO_FIT_ENABLED';
const AUTO_FIT_LAST_KEY = 'HP_AUTO_FIT_LAST_COLS';
const AUTO_FIT_COL_INTERVAL_MS = 15000;   // tránh co giãn cả bảng sau mọi request
const ROWS_TO_ADD = 100;                  // tự thêm 100 dòng khi gần hết
const MIN_FREE_ROWS = 30;                 // luôn giữ ít nhất 30 dòng trống
const MAX_NORMAL_COL_WIDTH = 320;         // cột thường: wrap + tối đa 320px
const MAX_JSON_COL_WIDTH = 420;           // cột JSON: rộng hơn nhưng vẫn wrap




/* ---------- tiện ích ---------- */

const isAcc = c => ACC.indexOf(c) !== -1;

const blank = v => v === undefined || v === null || v === '';

const roleOf = (d, c) => d.role || (c === 'admins' || c === 'references' ? 'admin' : 'student');

function ownerOf(d, c, id){ return isAcc(c) ? (d.username || id) : (d.username || d.addedBy || ''); }

function ymdToVn(s){ const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : (s || ''); }

function vnToYmd(v){

  if(v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');

  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : String(v || '').trim();

}

function toDate(ms){ const n = Number(ms); return ms && isFinite(n) && n > 0 ? new Date(n) : ''; }

function fromCellTime(v){

  if(blank(v)) return null;

  if(v instanceof Date) return v.getTime();

  if(typeof v === 'number') return v > 1e11 ? v : Math.round((v - 25569) * 86400000);   // số ms hoặc số ngày kiểu Sheets

  const m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);

  if(m){

    const s = m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T' + ('0' + (m[4] || 0)).slice(-2) + ':' + (m[5] || '00') + ':' + (m[6] || '00') + '+07:00';

    return new Date(s).getTime();

  }

  const t = Date.parse(v); return isFinite(t) ? t : null;

}

function toBool(v){

  if(typeof v === 'boolean') return v;

  const s = String(v).trim().toLowerCase();

  return ['true', 'có', 'co', 'x', '1', 'yes', 'đúng', 'dung', 'rồi', 'roi'].indexOf(s) !== -1;

}

function num(v){ if(blank(v)) return null; const n = Number(String(v).replace(',', '.')); return isFinite(n) ? n : null; }



/* ---------- định nghĩa 41 cột + 8 cột bổ sung ----------

   t: 'text' | 'time' | 'bool' | 'num' | 'date' (ngày dạng chữ dd/mm/yyyy)

   only: chỉ áp dụng cho các loại dữ liệu này (dòng khác để trống)

   set:  có → sửa trực tiếp được trên Sheet; không có → chỉ xem */

const COLS = [

  {h:'MÃ NGƯỜI DÙNG', t:'text', get:(d, c, id) => { const o = ownerOf(d, c, id); return o ? (roleOf(d, c) === 'admin' ? 'GV-' : 'HS-') + o : ''; }},

  {h:'TÊN ĐĂNG NHẬP', t:'text', get:(d, c, id) => isAcc(c) ? (d.username || id) : (d.username || '')},

  {h:'MÃ BĂM MẬT KHẨU', t:'text', only:ACC, get:d => d.passwordHash, set:(d, v) => { d.passwordHash = v; }},

  {h:'HỌ VÀ TÊN', t:'text', get:d => d.fullName || d.displayName, set:(d, v) => { d.fullName = v; d.displayName = v; }},

  {h:'VAI TRÒ', t:'text', get:(d, c) => (isAcc(c) || d.role) ? (roleOf(d, c) === 'admin' ? 'Giáo viên/BGH' : 'Học sinh') : ''},

  {h:'MÃ TRƯỜNG', t:'text', get:d => d.schoolId, set:(d, v) => { d.schoolId = v; }},

  {h:'TÊN TRƯỜNG', t:'text', get:d => d.schoolName, set:(d, v) => { d.schoolName = v; }},

  {h:'PHƯỜNG/XÃ', t:'text', get:d => d.wardName, set:(d, v) => { d.wardName = v; }},

  {h:'TỈNH/THÀNH PHỐ', t:'text', get:d => d.provinceName, set:(d, v) => { d.provinceName = v; }},

  {h:'KHỐI LỚP', t:'text', get:d => d.khoi, set:(d, v) => { d.khoi = String(v); }},

  {h:'TRẠNG THÁI', t:'text', get:d => d.status, set:(d, v) => { d.status = v; }},

  {h:'THỜI GIAN TẠO', t:'time', get:d => d.createdAt, set:(d, v) => { d.createdAt = v; }},

  {h:'LẦN ĐĂNG NHẬP CUỐI', t:'time', only:ACC, get:d => d.lastLoginAt},

  {h:'LOẠI DỮ LIỆU', t:'text', key:true, get:(d, c) => c},

  {h:'MÃ BẢN GHI', t:'text', key:true, get:(d, c, id) => id},

  {h:'TÊN HIỂN THỊ', t:'text', get:d => d.displayName, set:(d, v) => { d.displayName = v; }},

  {h:'CẤP HỌC', t:'text', get:d => d.schoolLevel, set:(d, v) => { d.schoolLevel = String(v).toUpperCase().replace('–', '-'); }},

  {h:'QUẬN/HUYỆN', t:'text', get:d => d.districtName, set:(d, v) => { d.districtName = v; }},

  {h:'MÃ TỈNH/THÀNH PHỐ', t:'text', get:d => d.provinceCode, set:(d, v) => { d.provinceCode = v; }},

  {h:'MÃ PHƯỜNG/XÃ', t:'text', get:d => d.wardCode, set:(d, v) => { d.wardCode = v; }},

  {h:'ĐỊA CHỈ', t:'text', get:d => d.address, set:(d, v) => { d.address = v; }},

  {h:'ĐANG HOẠT ĐỘNG', t:'bool', only:ACC, get:d => !(d.active === false || d.status === 'inactive'),

    set:(d, v) => { d.active = !!v; d.status = v ? 'active' : 'inactive'; }},

  {h:'TÀI KHOẢN MẪU', t:'bool', only:ACC, get:d => d.builtin === true, set:(d, v) => { d.builtin = !!v; }},

  {h:'KHÓA API GEMINI', t:'text', only:ACC, get:d => d.geminiApiKey, set:(d, v) => { d.geminiApiKey = v || null; }},

  {h:'THỜI GIAN CẬP NHẬT KHÓA API', t:'time', only:ACC, get:d => d.apiKeyUpdatedAt},

  {h:'THỜI GIAN CẬP NHẬT', t:'time', get:d => d.updatedAt},

  {h:'THỜI GIAN ĐỔI MẬT KHẨU', t:'time', only:ACC, get:d => d.passwordUpdatedAt},

  {h:'THỜI GIAN CẬP NHẬT TRƯỜNG', t:'time', only:ACC, get:d => d.schoolUpdatedAt},

  {h:'MỨC VẬN ĐỘNG', t:'text', only:['results', 'healthDaily', 'healthPeriods'], get:d => d.level || d.mainLevel,

    set:(d, v, c) => { if(c === 'healthPeriods') d.mainLevel = v; else d.level = v; }},

  {h:'SỐ PHÚT/TUẦN QUY ĐỔI', t:'num', only:['results', 'healthDaily', 'healthPeriods'], get:d => blank(d.quyDoi) ? d.avgQuyDoi : d.quyDoi,

    set:(d, v, c) => { if(c === 'healthPeriods') d.avgQuyDoi = v; else d.quyDoi = v; }},

  {h:'ĐÃ THỬ', t:'bool', only:['results'], get:d => d.committed === true || d.tried === true, set:(d, v) => { d.committed = !!v; }},

  {h:'THỜI GIAN ĐÃ THỬ', t:'time', only:['results'], get:d => d.committedAt || d.triedAt},

  {h:'MÃ TUẦN', t:'text', only:['results', 'healthPeriods'], get:d => d.weekKey || (d.type === 'week' ? d.code : ''),

    set:(d, v, c) => { if(c === 'results') d.weekKey = v; }},

  {h:'THỜI GIAN GHI KẾT QUẢ', t:'time', only:['results', 'healthDaily'], get:d => d.ts},

  {h:'TIÊU ĐỀ TƯ LIỆU', t:'text', only:['references'], get:d => d.title, set:(d, v) => { d.title = v; }},

  {h:'MÔ TẢ TƯ LIỆU', t:'text', only:['references'], get:d => d.desc, set:(d, v) => { d.desc = v; }},

  {h:'LIÊN KẾT TƯ LIỆU', t:'text', only:['references'], get:d => d.url, set:(d, v) => { d.url = v; }},

  {h:'THỜI GIAN THÊM', t:'time', only:['references'], get:d => d.addedAt},

  {h:'NGƯỜI THÊM', t:'text', only:['references'], get:d => d.addedBy},

  {h:'LỊCH SỬ TRÒ CHUYỆN (JSON)', t:'json', special:'conv'},

  {h:'DỮ LIỆU ĐẦY ĐỦ (JSON)', t:'json', special:'full'},

  /* ---- 8 cột BỔ SUNG cho Kho dữ liệu sức khỏe (tự thêm vào cuối nếu Sheet chưa có) ---- */

  {h:'NGÀY GHI NHẬN', t:'date', extra:true, only:['healthDaily'], get:d => d.date},

  {h:'PHÚT VẬN ĐỘNG VỪA', t:'num', extra:true, only:HEALTH, get:d => blank(d.phutVua) ? d.avgVua : d.phutVua},

  {h:'PHÚT VẬN ĐỘNG MẠNH', t:'num', extra:true, only:HEALTH, get:d => blank(d.phutManh) ? d.avgManh : d.phutManh},

  {h:'GIỜ NGỒI/NGÀY', t:'num', extra:true, only:HEALTH, get:d => blank(d.gioNgoi) ? d.avgGioNgoi : d.gioNgoi},

  {h:'KỲ THỐNG KÊ', t:'text', extra:true, only:['healthPeriods'], get:d => d.label},

  {h:'TỪ NGÀY', t:'date', extra:true, only:['healthPeriods'], get:d => d.start},

  {h:'ĐẾN NGÀY', t:'date', extra:true, only:['healthPeriods'], get:d => d.end},

  {h:'SỐ NGÀY CÓ DỮ LIỆU', t:'num', extra:true, only:['healthPeriods'], get:d => d.records}

];

const COL_BY_H = {}; COLS.forEach(c => { COL_BY_H[c.h] = c; });

const applies = (col, c) => !col.only || col.only.indexOf(c) !== -1;



/* giá trị hiển thị trên ô */

function cellOf(col, d, c, id){

  if(!applies(col, c)) return '';

  const v = col.get(d, c, id);

  if(blank(v)) return '';

  if(col.t === 'time') return toDate(v);

  if(col.t === 'bool') return !!v;

  if(col.t === 'num'){ const n = Number(v); return isFinite(n) ? n : ''; }

  if(col.t === 'date') return ymdToVn(v);

  return String(v);

}

/* ô có khác với giá trị lẽ ra phải có không (→ thầy cô đã sửa tay) */

function differs(col, cell, expected){

  if(blank(cell) && blank(expected)) return false;

  if(col.t === 'time'){

    const a = fromCellTime(cell), b = expected instanceof Date ? expected.getTime() : fromCellTime(expected);

    if(a === null && b === null) return false;

    if(a === null || b === null) return true;

    return Math.abs(a - b) > 1500;

  }

  if(col.t === 'bool') return toBool(cell) !== toBool(expected === '' ? false : expected);

  if(col.t === 'num') return num(cell) !== num(expected);

  return String(cell).trim() !== String(expected).trim();

}

function parseCell(col, cell){

  if(col.t === 'time') return fromCellTime(cell);

  if(col.t === 'bool') return toBool(cell);

  if(col.t === 'num') return num(cell);

  if(col.t === 'date') return blank(cell) ? '' : vnToYmd(cell);

  return blank(cell) ? '' : String(cell).trim();

}



/* ---------- hỗ trợ bảng: 1 tab, kẻ bảng, thêm dòng, auto-fit ---------- */
function headerKey_(v){
  return String(v || '').trim().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').toUpperCase();
}

function canonicalHeader_(v){
  const k = headerKey_(v);
  for(let i = 0; i < COLS.length; i++) if(headerKey_(COLS[i].h) === k) return COLS[i].h;
  return String(v || '').trim();
}

function isAutoFitEnabled_(){
  const v = PropertiesService.getScriptProperties().getProperty(AUTO_FIT_KEY);
  return v === null ? true : v !== '0';
}

function ensureSpareRows_(sh, needed){
  needed = Math.max(needed || 1, MIN_FREE_ROWS);
  const last = Math.max(sh.getLastRow(), 1);
  const free = sh.getMaxRows() - last;
  if(free >= needed) return 0;
  const add = Math.max(ROWS_TO_ADD, needed - free);
  sh.insertRowsAfter(sh.getMaxRows(), add);
  return add;
}

function styleRows_(sh, startRow, numRows){
  if(numRows <= 0) return;
  const H = headerMap_(sh);
  sh.getRange(startRow, 1, numRows, H.width)
    .setWrap(true)
    .setVerticalAlignment('top')
    .setBorder(true, true, true, true, true, true);
}

function capColumnWidths_(sh){
  const H = headerMap_(sh);
  for(let c = 1; c <= H.width; c++){
    const h = H.head[c - 1] || '';
    const maxW = (h === 'LỊCH SỬ TRÒ CHUYỆN (JSON)' || h === 'DỮ LIỆU ĐẦY ĐỦ (JSON)') ? MAX_JSON_COL_WIDTH : MAX_NORMAL_COL_WIDTH;
    if(sh.getColumnWidth(c) > maxW) sh.setColumnWidth(c, maxW);
  }
}

function autoFitColumns_(sh, force){
  if(!isAutoFitEnabled_() && !force) return;
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = Number(props.getProperty(AUTO_FIT_LAST_KEY) || 0);
  if(!force && now - last < AUTO_FIT_COL_INTERVAL_MS) return;
  const H = headerMap_(sh);
  sh.autoResizeColumns(1, H.width);
  capColumnWidths_(sh);
  props.setProperty(AUTO_FIT_LAST_KEY, String(now));
}

function autoFitRows_(sh, startRow, numRows, force){
  if((!isAutoFitEnabled_() && !force) || numRows <= 0) return;
  styleRows_(sh, startRow, numRows);
  sh.autoResizeRows(startRow, numRows);
}

function maybeAutoFit_(sh, startRow, numRows, forceColumns){
  if(!isAutoFitEnabled_()) return;
  autoFitRows_(sh, startRow, numRows || 1, false);
  autoFitColumns_(sh, !!forceColumns);
}

function ensureTableArea_(sh){
  ensureSpareRows_(sh, MIN_FREE_ROWS);
  const H = headerMap_(sh);
  const bottom = Math.min(sh.getMaxRows(), Math.max(sh.getLastRow() + ROWS_TO_ADD, 101));
  sh.getRange(1, 1, bottom, H.width).setBorder(true, true, true, true, true, true);
  if(bottom >= 2) sh.getRange(2, 1, bottom - 1, H.width).setWrap(true).setVerticalAlignment('top');
}

function cleanupEmptyExtraTabs_(silent){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const removed = [], kept = [];
  ss.getSheets().forEach(tab => {
    if(tab.getName() === SHEET_NAME) return;
    const vals = tab.getDataRange().getDisplayValues();
    let nonBlankRows = 0;
    for(let r = 0; r < vals.length; r++) if(vals[r].some(v => String(v).trim() !== '')) nonBlankRows++;
    if(nonBlankRows <= 1){ try{ ss.deleteSheet(tab); removed.push(tab.getName()); }catch(e){} }
    else kept.push(tab.getName());
  });
  if(!silent){
    SpreadsheetApp.getUi().alert(
      'Đã xóa tab phụ rỗng: ' + (removed.join(', ') || 'không có') +
      (kept.length ? '\n\nKhông xóa tab đang có dữ liệu: ' + kept.join(', ') + '. Hãy chuyển dữ liệu vào Trang tính1 trước.' : '')
    );
  }
  return {removed, kept};
}

/* ---------- nén / giải nén JSON dài ---------- */

function packJson(obj){

  const s = JSON.stringify(obj);

  if(s.length <= MAX_CELL) return s;

  const gz = 'gz:' + Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(s, 'application/json')).getBytes());

  return gz.length <= MAX_CELL ? gz : null;

}

function unpackJson(cell){

  if(blank(cell)) return null;

  let s = String(cell);

  try{

    if(s.indexOf('gz:') === 0){

      const blob = Utilities.newBlob(Utilities.base64Decode(s.slice(3)), 'application/x-gzip');

      s = Utilities.ungzip(blob).getDataAsString('UTF-8');

    }

    return JSON.parse(s);

  }catch(e){ return null; }

}

/* lịch sử trò chuyện quá dài → bỏ bớt cuộc cũ nhất cho vừa 1 ô */

function packConversations(list){

  let arr = (list || []).slice();

  let out = packJson(arr);

  while(out === null && arr.length > 1){

    arr.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

    arr = arr.slice(0, Math.max(1, Math.floor(arr.length * 0.8)));

    out = packJson(arr);

  }

  if(out === null && arr.length === 1){

    const one = JSON.parse(JSON.stringify(arr[0]));

    while(out === null && one.messages && one.messages.length > 4){ one.messages = one.messages.slice(Math.floor(one.messages.length / 4)); out = packJson([one]); }

  }

  return out === null ? '[]' : out;

}



/* ---------- tên trường dữ liệu cũ (ward, tinh, quan…) → tên chuẩn để điền đúng cột ---------- */

const ALIASES = {

  schoolName:['officialName', 'school_name', 'school', 'truongHoc', 'truong', 'tenTruong'],

  wardName:['ward_name', 'ward', 'phuongXa', 'phuong_xa', 'phuong', 'xa', 'commune', 'communeName', 'tenPhuong', 'tenXa'],

  districtName:['district_name', 'district', 'quanHuyen', 'quan_huyen', 'quan', 'huyen'],

  provinceName:['province_name', 'province', 'tinhThanh', 'tinh_thanh', 'tinhThanhPho', 'tinh', 'thanhPho', 'city', 'cityName'],

  provinceCode:['province_code', 'maTinh', 'ma_tinh'],

  wardCode:['ward_code', 'maPhuong', 'ma_phuong', 'maXa'],

  schoolId:['school_id', 'schoolCode', 'maTruong', 'ma_truong'],

  schoolLevel:['school_level', 'capHoc', 'cap_hoc'],

  address:['diaChi', 'dia_chi'],

  fullName:['hoTen', 'hoten', 'full_name', 'realName']

};

function normaliseDoc_(d){

  Object.keys(ALIASES).forEach(k => {

    if(!blank(d[k])) return;

    const a = ALIASES[k].find(x => !blank(d[x]) && typeof d[x] !== 'object');

    if(a) d[k] = String(d[a]).trim();

  });

  if(blank(d.displayName) && !blank(d.fullName)) d.displayName = d.fullName;

  return d;

}



/* ---------- LỊCH SỬ TRÒ CHUYỆN nằm NGAY TRÊN DÒNG TÀI KHOẢN ----------

   Web vẫn gọi collection "conversations" (id = tên đăng nhập, admin là "admin:<tên>"),

   script ghi vào ô LỊCH SỬ TRÒ CHUYỆN (JSON) của dòng students/admins tương ứng → không sinh dòng/tab riêng. */

function convAccount_(id){

  id = String(id || '');

  return id.indexOf('admin:') === 0 ? {c:'admins', id:id.slice(6)} : {c:'students', id};

}

function convCol_(H){ return H.idx['LỊCH SỬ TRÒ CHUYỆN (JSON)']; }

function getConv_(sh, H, id){

  const ak = convAccount_(id);

  const acc = getDoc_(sh, H, ak.c, ak.id);

  const legacy = getDoc_(sh, H, 'conversations', id);

  const cell = acc ? acc.row[convCol_(H)] : '';

  if(acc && (!blank(cell) || !legacy)){

    const a = acc.doc.data;

    const list = unpackJson(cell);

    if(blank(cell)) return null;

    return {username:a.username || ak.id, role:a.role || (ak.c === 'admins' ? 'admin' : 'student'),

      schoolId:a.schoolId || '', schoolName:a.schoolName || '', wardName:a.wardName || '', provinceName:a.provinceName || '',

      updatedAt:a.chatUpdatedAt || a.updatedAt || null, conversations:Array.isArray(list) ? list : []};

  }

  return legacy ? legacy.doc.data : null;

}

function setConv_(sh, H, id, data){

  const ak = convAccount_(id);

  const acc = getDoc_(sh, H, ak.c, ak.id);

  if(!acc) return writeDoc_('conversations', id, data, false);          // chưa có dòng tài khoản → để dòng riêng

  const list = Array.isArray(data && data.conversations) ? data.conversations : (unpackJson(acc.row[convCol_(H)]) || []);

  sh.getRange(acc.r, convCol_(H) + 1).setValue(packConversations(list));

  maybeAutoFit_(sh, acc.r, 1, false);

  const legacy = keyIndex_(sh, H)['conversations\u0001' + id];

  if(legacy) sh.deleteRow(legacy);                                    // dọn dòng trò chuyện riêng kiểu cũ

  return 0;

}

function deleteConv_(sh, H, id){

  const ak = convAccount_(id);

  const acc = getDoc_(sh, H, ak.c, ak.id);

  if(acc) sh.getRange(acc.r, convCol_(H) + 1).setValue('');

  const legacy = keyIndex_(sh, H)['conversations\u0001' + id];

  if(legacy) sh.deleteRow(legacy);

}

function listConv_(){

  const sh = sheet_(); const H = headerMap_(sh);

  const out = listDocs_('conversations');

  const seen = new Set(out.map(d => d.id));

  ['students', 'admins'].forEach(c => listDocs_(c).forEach(a => {

    const id = c === 'admins' ? 'admin:' + a.id : a.id;

    if(seen.has(id)) return;

    const d = getConv_(sh, H, id); if(d) out.push({id, data:d});

  }));

  return out;

}

/** Gộp các dòng "conversations" cũ vào dòng tài khoản rồi xóa dòng cũ */

function foldConversations_(){

  const sh = sheet_(); const H = headerMap_(sh);

  let n = 0;

  listDocs_('conversations').forEach(doc => {

    const ak = convAccount_(doc.id);

    if(!getDoc_(sh, H, ak.c, ak.id)) return;

    setConv_(sh, H, doc.id, doc.data); n++;

  });

  return n;

}



/* ---------- đọc / ghi Trang tính1 ---------- */

function sheet_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if(!sh){ sh = ss.insertSheet(SHEET_NAME, 0); }
  const fixed = ensureHeaders_(sh);
  if(fixed.added || fixed.renamed) applyFormats_(sh);
  ensureSpareRows_(sh, MIN_FREE_ROWS);
  return sh;
}

/** Bảo đảm đủ cột: giữ nguyên thứ tự cột thầy cô đã đặt, cột còn thiếu thêm vào cuối */

function ensureHeaders_(sh){
  const lastCol = Math.max(1, sh.getLastColumn());
  const raw = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());
  const empty = raw.every(h => !h);

  if(empty){
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS.map(c => c.h)]);
    return {added:COLS.length, renamed:0};
  }

  const canon = raw.map(canonicalHeader_);
  let renamed = 0;
  canon.forEach((h, i) => {
    if(raw[i] && h !== raw[i] && COL_BY_H[h]){
      sh.getRange(1, i + 1).setValue(h);
      renamed++;
    }
  });

  const haveKeys = new Set(canon.filter(Boolean).map(headerKey_));
  const missing = COLS.map(c => c.h).filter(h => !haveKeys.has(headerKey_(h)));
  if(!missing.length) return {added:0, renamed};

  let end = canon.length;
  while(end > 0 && !canon[end - 1]) end--;
  sh.getRange(1, end + 1, 1, missing.length).setValues([missing]);
  return {added:missing.length, renamed};
}

/** Định dạng cột: thời gian = ngày giờ; chữ = văn bản thuần (để "10", "0123", mã băm… không bị Sheets đổi thành số/ngày) */

function applyFormats_(sh){
  const H = headerMap_(sh);
  const rows = Math.max(sh.getMaxRows() - 1, 1);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, H.width).setFontWeight('bold').setWrap(true).setVerticalAlignment('middle');

  COLS.forEach(col => {
    const i = H.idx[col.h]; if(i === undefined) return;
    const head = sh.getRange(1, i + 1);
    const body = sh.getRange(2, i + 1, rows, 1);
    head.setBackground(col.key ? '#fde68a' : col.set ? '#ccfbf1' : col.extra ? '#e0e7ff' : '#e5e7eb');
    head.setNote(col.key ? 'Khóa của dòng — KHÔNG sửa.' :
      col.special ? 'Bản gốc dạng JSON — chỉ sửa khi thật cần.' :
      col.set ? 'Sửa trực tiếp được — web dùng giá trị ở ô này.' : 'Chỉ xem — tự tính từ dữ liệu.');
    if(col.t === 'time') body.setNumberFormat('dd/MM/yyyy HH:mm:ss');
    else if(col.t === 'num') body.setNumberFormat('0.##');
    else body.setNumberFormat('@');
    if(col.special) sh.setColumnWidth(i + 1, MAX_JSON_COL_WIDTH);
  });

  ensureTableArea_(sh);
  autoFitColumns_(sh, true);
}

function headerMap_(sh){
  const raw = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h || '').trim());
  const head = raw.map(canonicalHeader_);
  const idx = {};
  head.forEach((h, i) => { if(h && idx[h] === undefined) idx[h] = i; });
  return {head, idx, width:head.length};
}

/** Dựng lại bản ghi từ 1 dòng: JSON gốc + các ô thầy cô sửa tay */

function rowToDoc_(row, H){

  const c = String(row[H.idx['LOẠI DỮ LIỆU']] || '').trim();

  const id = String(row[H.idx['MÃ BẢN GHI']] || '').trim();

  const full = unpackJson(row[H.idx['DỮ LIỆU ĐẦY ĐỦ (JSON)']]);

  const d = normaliseDoc_(full && typeof full === 'object' ? full : {});

  const convCell = H.idx['LỊCH SỬ TRÒ CHUYỆN (JSON)'] === undefined ? '' : row[H.idx['LỊCH SỬ TRÒ CHUYỆN (JSON)']];

  if(c === 'conversations'){

    const conv = unpackJson(convCell);

    if(Array.isArray(conv)) d.conversations = conv;

    else if(c === 'conversations' && !Array.isArray(d.conversations)) d.conversations = [];

  }

  // so từng cột sửa được với giá trị lẽ ra phải có → khác thì lấy theo ô (thầy cô đã sửa)

  const base = JSON.parse(JSON.stringify(d));

  COLS.forEach(col => {

    if(!col.set || !applies(col, c)) return;

    const i = H.idx[col.h]; if(i === undefined) return;

    const cell = row[i];

    if(!full){ if(!blank(cell)) col.set(d, parseCell(col, cell), c); return; }   // dòng nhập tay chưa có JSON

    if(differs(col, cell, cellOf(col, base, c, id))) col.set(d, parseCell(col, cell), c);

  });

  if(isAcc(c) && !d.username) d.username = id;

  if(isAcc(c) && !d.role) d.role = c === 'admins' ? 'admin' : 'student';

  return {c, id, data:d};

}

function docToRow_(c, id, d, H, oldRow){

  const row = oldRow ? oldRow.slice() : new Array(H.width).fill('');

  while(row.length < H.width) row.push('');

  const lean = Object.assign({}, d);

  const conv = lean.conversations; delete lean.conversations;

  COLS.forEach(col => {

    const i = H.idx[col.h]; if(i === undefined) return;

    if(col.special === 'full') row[i] = packJson(lean) || JSON.stringify({error:'Bản ghi quá lớn'});

    else if(col.special === 'conv'){

      if(Array.isArray(conv)) row[i] = packConversations(conv);

      else if(!isAcc(c)) row[i] = '';            // dòng tài khoản: giữ nguyên lịch sử trò chuyện đang có

    }

    else row[i] = cellOf(col, d, c, id);

  });

  return row;

}

function keyIndex_(sh, H){

  const last = sh.getLastRow();

  const map = {};

  if(last < 2) return map;

  const ci = H.idx['LOẠI DỮ LIỆU'] + 1, ii = H.idx['MÃ BẢN GHI'] + 1;

  const cs = sh.getRange(2, ci, last - 1, 1).getValues(), is = sh.getRange(2, ii, last - 1, 1).getValues();

  for(let r = 0; r < cs.length; r++){

    const k = String(cs[r][0]).trim() + '\u0001' + String(is[r][0]).trim();

    if(String(is[r][0]).trim() && map[k] === undefined) map[k] = r + 2;

  }

  return map;

}

function getDoc_(sh, H, c, id){

  const r = keyIndex_(sh, H)[c + '\u0001' + id];

  if(!r) return null;

  const row = sh.getRange(r, 1, 1, H.width).getValues()[0];

  return {r, row, doc:rowToDoc_(row, H)};

}

function listDocs_(c){

  const sh = sheet_(); const H = headerMap_(sh);

  const last = sh.getLastRow(); if(last < 2) return [];

  const rows = sh.getRange(2, 1, last - 1, H.width).getValues();

  const ci = H.idx['LOẠI DỮ LIỆU'], ii = H.idx['MÃ BẢN GHI'];

  const out = [];

  rows.forEach(row => {

    if(String(row[ci]).trim() !== c || !String(row[ii]).trim()) return;

    const doc = rowToDoc_(row, H);

    out.push({id:doc.id, data:doc.data});

  });

  return out;

}

function writeDoc_(c, id, data, merge){
  const sh = sheet_(); const H = headerMap_(sh);
  const found = getDoc_(sh, H, c, id);
  const d = normaliseDoc_(merge && found ? Object.assign({}, found.doc.data, data) : Object.assign({}, data));
  if(isAcc(c) && !d.username) d.username = id;
  const row = docToRow_(c, id, d, H, found ? found.row : null);

  let writtenRow;
  if(found){
    writtenRow = found.r;
    sh.getRange(found.r, 1, 1, H.width).setValues([row]);
  }else{
    ensureSpareRows_(sh, MIN_FREE_ROWS);
    writtenRow = sh.getLastRow() + 1;
    sh.getRange(writtenRow, 1, 1, H.width).setValues([row]);
  }

  maybeAutoFit_(sh, writtenRow, 1, false);
  ensureSpareRows_(sh, MIN_FREE_ROWS);

  if(isAcc(c) && found) return cascadeAccount_(sh, H, c, id, found.doc.data, d);
  return 0;
}

/* ---------- ĐỔI THÔNG TIN TÀI KHOẢN → ĐỒNG BỘ CÁC DÒNG LIÊN QUAN ----------

   Họ tên và trường được chép sang các bản ghi khác của cùng tài khoản để Dashboard của

   trường mới thấy đủ dữ liệu cũ. Khối lớp KHÔNG chép (mỗi kết quả giữ khối lúc làm khảo sát). */

const CASCADE_NAME = ['displayName'];

const CASCADE_SCHOOL = ['schoolId', 'schoolName', 'schoolLevel', 'wardName', 'districtName', 'provinceName', 'provinceCode', 'wardCode', 'address'];

function cascadeAccount_(sh, H, c, id, before, after){

  const nameOf = d => String(d.displayName || d.fullName || '').trim();

  const nameChanged = nameOf(before) !== nameOf(after);

  const schoolChanged = CASCADE_SCHOOL.some(k => String(before[k] || '') !== String(after[k] || ''));

  if(!nameChanged && !schoolChanged) return 0;

  const role = c === 'admins' ? 'admin' : 'student';

  const last = sh.getLastRow(); if(last < 2) return 0;

  const range = sh.getRange(2, 1, last - 1, H.width);

  const rows = range.getValues();

  const ci = H.idx['LOẠI DỮ LIỆU'];

  let n = 0;

  rows.forEach((row, i) => {

    const rc = String(row[ci]).trim();

    if(isAcc(rc) || COLLECTIONS.indexOf(rc) === -1 || rc === 'references') return;

    const doc = rowToDoc_(row, H);

    if(String(doc.data.username || '') !== id || roleOf(doc.data, rc) !== role) return;

    const d = doc.data;

    if(nameChanged){ CASCADE_NAME.forEach(k => { d[k] = nameOf(after); }); }

    if(schoolChanged) CASCADE_SCHOOL.forEach(k => { if(k in after) d[k] = after[k]; });

    d.accountSyncedAt = Date.now();

    rows[i] = docToRow_(rc, doc.id, d, H, row);

    n++;

  });

  if(n) range.setValues(rows);

  return n;

}

function deleteDoc_(c, id){

  const sh = sheet_(); const H = headerMap_(sh);

  const r = keyIndex_(sh, H)[c + '\u0001' + id];

  if(r) sh.deleteRow(r);

}



/* ---------- Web API ---------- */

function json_(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

function checkCollection_(c){ if(!c || COLLECTIONS.indexOf(c) === -1) throw new Error('Loại dữ liệu không hợp lệ: ' + c); }



function doGet(e){

  try{

    const p = (e && e.parameter) || {};

    const action = p.action || 'ping';

    if(action === 'ping') return json_({ok:true, sheet:SHEET_NAME, version:VERSION, time:new Date().toISOString()});

    checkCollection_(p.collection);

    if(p.collection === 'conversations'){

      if(action === 'list') return json_({docs:listConv_()});

      const sh = sheet_(); const H = headerMap_(sh);

      const d = getConv_(sh, H, String(p.id || ''));

      return json_(d ? {exists:true, data:d} : {exists:false, data:null});

    }

    if(action === 'list') return json_({docs:listDocs_(p.collection)});

    if(action === 'get'){

      const sh = sheet_(); const H = headerMap_(sh);

      const f = getDoc_(sh, H, p.collection, String(p.id || ''));

      return json_(f ? {exists:true, data:f.doc.data} : {exists:false, data:null});

    }

    return json_({error:'Hành động không hỗ trợ: ' + action});

  }catch(err){ return json_({error:String(err && err.message || err)}); }

}



function doPost(e){

  const lock = LockService.getScriptLock();

  try{

    lock.waitLock(25000);

    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const c = body.collection; checkCollection_(c);

    const action = body.action;

    if(action === 'add'){

      const id = Date.now() + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);

      writeDoc_(c, id, body.data || {}, false);

      return json_({ok:true, id});

    }

    const id = String(body.id || '').trim();

    if(!id) throw new Error('Thiếu MÃ BẢN GHI (id)');

    if(c === 'conversations'){

      const sh = sheet_(); const H = headerMap_(sh);

      if(action === 'delete') deleteConv_(sh, H, id); else setConv_(sh, H, id, body.data || {});

      return json_({ok:true, id});

    }

    if(action === 'set'){ const cascaded = writeDoc_(c, id, body.data || {}, false); return json_({ok:true, id, cascaded}); }

    if(action === 'update'){ const cascaded = writeDoc_(c, id, body.data || {}, true); return json_({ok:true, id, cascaded}); }

    if(action === 'delete'){ deleteDoc_(c, id); return json_({ok:true, id}); }

    return json_({error:'Hành động không hỗ trợ: ' + action});

  }catch(err){

    return json_({error:String(err && err.message || err)});

  }finally{

    try{ lock.releaseLock(); }catch(e){}

  }

}



/* ---------- Menu trong Google Sheet ---------- */

function onOpen(){
  const ui = SpreadsheetApp.getUi();
  const support = ui.createMenu('Công cụ hỗ trợ')
    .addItem('Kẻ bảng + sửa định dạng thiếu', 'repairTableLayout')
    .addItem('Thêm 100 dòng trống', 'addRows100')
    .addItem('Auto-fit toàn bảng', 'autoFitAll')
    .addItem('Bật / tắt auto-fit tự động', 'toggleAutoFit')
    .addItem('Xóa tab phụ rỗng', 'deleteExtraEmptyTabs');

  ui.createMenu('AI HealthPulse')
    .addItem('1. Thiết lập Trang tính1', 'setupSheet')
    .addItem('2. Chuyển dữ liệu từ các tab cũ vào Trang tính1', 'migrateOldTabs')
    .addItem('3. Làm mới các cột hiển thị', 'refreshAllRows')
    .addItem('4. Đếm số dòng theo loại dữ liệu', 'countRows')
    .addItem('5. Đồng bộ họ tên/trường', 'cascadeAll')
    .addSeparator()
    .addSubMenu(support)
    .addSeparator()
    .addItem('Xóa các tab dữ liệu cũ', 'deleteOldTabs')
    .addToUi();
}

function setupSheet(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try{ ss.setSpreadsheetTimeZone(TZ); }catch(e){}
  const sh = sheet_();
  try{ foldConversations_(); }catch(e){}
  applyFormats_(sh);
  ensureSpareRows_(sh, MIN_FREE_ROWS);
  ensureTableArea_(sh);
  autoFitAll_(sh, true);
  const clean = cleanupEmptyExtraTabs_(true);
  const extra = ss.getSheets().filter(t => t.getName() !== SHEET_NAME).map(t => t.getName());
  SpreadsheetApp.getUi().alert(
    'Đã thiết lập "' + SHEET_NAME + '".\n' +
    '• Dữ liệu chỉ ghi vào Trang tính1.\n' +
    '• Tự thêm dòng khi gần hết.\n' +
    '• Kẻ bảng + wrap + auto-fit đang bật.\n' +
    '• Đã xóa tab phụ rỗng: ' + (clean.removed.join(', ') || 'không có') +
    (extra.length ? '\n\nCòn tab có dữ liệu: ' + extra.join(', ') + '. Chạy mục 2 để chuyển dữ liệu trước khi xóa.' : '')
  );
}

function repairTableLayout(){
  const sh = sheet_();
  ensureHeaders_(sh);
  applyFormats_(sh);
  ensureSpareRows_(sh, MIN_FREE_ROWS);
  ensureTableArea_(sh);
  autoFitAll_(sh, true);
  SpreadsheetApp.getActiveSpreadsheet().toast('Đã kẻ bảng, bổ sung định dạng và căn kích thước.', 'AI HealthPulse', 5);
}

function addRows100(){
  const sh = sheet_();
  sh.insertRowsAfter(sh.getMaxRows(), ROWS_TO_ADD);
  const H = headerMap_(sh);
  const start = sh.getMaxRows() - ROWS_TO_ADD + 1;
  sh.getRange(start, 1, ROWS_TO_ADD, H.width)
    .setWrap(true).setVerticalAlignment('top')
    .setBorder(true, true, true, true, true, true);
  SpreadsheetApp.getActiveSpreadsheet().toast('Đã thêm ' + ROWS_TO_ADD + ' dòng trống.', 'AI HealthPulse', 4);
}

function autoFitAll_(sh, force){
  const H = headerMap_(sh);
  const last = Math.max(sh.getLastRow(), 1);
  sh.getRange(1, 1, last, H.width).setWrap(true).setBorder(true, true, true, true, true, true);
  sh.autoResizeColumns(1, H.width);
  capColumnWidths_(sh);
  sh.autoResizeRows(1, last);
}

function autoFitAll(){
  const sh = sheet_();
  autoFitAll_(sh, true);
  SpreadsheetApp.getActiveSpreadsheet().toast('Đã auto-fit toàn bộ bảng.', 'AI HealthPulse', 4);
}

function toggleAutoFit(){
  const props = PropertiesService.getScriptProperties();
  const next = !isAutoFitEnabled_();
  props.setProperty(AUTO_FIT_KEY, next ? '1' : '0');
  SpreadsheetApp.getUi().alert('Auto-fit tự động: ' + (next ? 'ĐÃ BẬT' : 'ĐÃ TẮT'));
}

function deleteExtraEmptyTabs(){ cleanupEmptyExtraTabs_(false); }

/** Đọc mọi dòng → ghi lại: các cột hiển thị khớp lại với dữ liệu (đã nhận phần sửa tay) */

function refreshAllRows(){

  const lock = LockService.getScriptLock(); lock.waitLock(25000);

  try{

    const sh = sheet_(); const H = headerMap_(sh);

    const last = sh.getLastRow(); if(last < 2) return;

    const rows = sh.getRange(2, 1, last - 1, H.width).getValues();

    const out = rows.map(row => {

      const doc = rowToDoc_(row, H);

      return doc.c && doc.id ? docToRow_(doc.c, doc.id, doc.data, H, row) : row;

    });

    sh.getRange(2, 1, out.length, H.width).setValues(out);

    styleRows_(sh, 2, out.length);
    autoFitRows_(sh, 2, out.length, false);
    autoFitColumns_(sh, false);

  }finally{ lock.releaseLock(); }

  SpreadsheetApp.getActiveSpreadsheet().toast('Đã làm mới các cột hiển thị.', 'AI HealthPulse', 4);

}



function countRows(){

  const sh = sheet_(); const H = headerMap_(sh);

  const last = sh.getLastRow();

  const counts = {}; COLLECTIONS.forEach(c => counts[c] = 0);

  if(last >= 2) sh.getRange(2, H.idx['LOẠI DỮ LIỆU'] + 1, last - 1, 1).getValues().forEach(r => { const c = String(r[0]).trim(); counts[c] = (counts[c] || 0) + 1; });

  SpreadsheetApp.getUi().alert(Object.keys(counts).map(k => k + ': ' + counts[k]).join('\n'));

}



/** Chuyển dữ liệu từ các tab cũ (students, admins, results, conversations, references, healthDaily, healthPeriods)

 *  vào Trang tính1, rồi hỏi có xóa các tab cũ không. Bản ghi đã có thì chỉ bổ sung ô còn trống.

 *  Lịch sử trò chuyện được gộp vào ô LỊCH SỬ TRÒ CHUYỆN của dòng tài khoản. */

function readOldTab_(tab){

  const vals = tab.getDataRange().getValues(); if(!vals.length) return [];

  const head = vals[0].map(h => String(h || '').trim().toLowerCase());

  const idCol = head.findIndex(h => ['id', 'docid', 'doc_id', 'key', 'mã bản ghi', 'username'].indexOf(h) !== -1);

  const jsonCol = head.findIndex(h => /json|^data$|dữ liệu/.test(h));

  const startRow = (idCol !== -1 || jsonCol !== -1) ? 1 : 0;

  const out = [];

  for(let r = startRow; r < vals.length; r++){

    const row = vals[r];

    let data = null;

    if(jsonCol !== -1) data = unpackJson(row[jsonCol]);

    if(!data) for(let k = 0; k < row.length; k++){ const t = String(row[k] || '').trim(); if(t[0] === '{' || t.indexOf('gz:') === 0){ const o = unpackJson(t); if(o && typeof o === 'object' && !Array.isArray(o)){ data = o; break; } } }

    if(!data && startRow === 1){                         // tab dạng cột thường: tiêu đề = tên trường dữ liệu

      data = {}; vals[0].forEach((h, k) => { if(k !== idCol && String(h).trim() && !blank(row[k])) data[String(h).trim()] = row[k] instanceof Date ? row[k].getTime() : row[k]; });

    }

    if(!data) continue;

    const id = String((idCol !== -1 ? row[idCol] : '') || data.id || data.username || (row[0] && String(row[0])[0] !== '{' ? row[0] : '') || '').trim();

    if(!id) continue;

    delete data.id;

    out.push({id, data:normaliseDoc_(data)});

  }

  return out;

}

function migrateOldTabs(){

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const ui = SpreadsheetApp.getUi();

  const lock = LockService.getScriptLock(); lock.waitLock(25000);

  const report = [], oldTabs = [];

  try{

    const sh = sheet_(); const H = headerMap_(sh);

    COLLECTIONS.forEach(c => {                     // thứ tự: tài khoản trước, trò chuyện sau

      const tab = ss.getSheetByName(c);

      if(!tab || tab.getName() === SHEET_NAME) return;

      oldTabs.push(tab);

      let added = 0, filled = 0;

      readOldTab_(tab).forEach(({id, data}) => {

        if(c === 'conversations'){ setConv_(sh, H, id, data); added++; return; }

        const found = getDoc_(sh, H, c, id);

        if(!found){ writeDoc_(c, id, data, false); added++; return; }

        const patch = {};                          // đã có → chỉ bổ sung ô đang trống

        Object.keys(data).forEach(k => { if(blank(found.doc.data[k]) && !blank(data[k])) patch[k] = data[k]; });

        if(Object.keys(patch).length){ writeDoc_(c, id, patch, true); filled++; }

      });

      report.push(c + ': thêm ' + added + (filled ? ', bổ sung ' + filled : '') + ' dòng');

    });

    const folded = foldConversations_();

    if(folded) report.push('gộp ' + folded + ' lịch sử trò chuyện vào dòng tài khoản');

  }finally{ lock.releaseLock(); }

  const msg = 'Chuyển dữ liệu xong:\n' + (report.join('\n') || 'Không thấy tab cũ nào.');

  if(!oldTabs.length){ ui.alert(msg); return; }

  const ans = ui.alert(msg + '\n\nXóa các tab cũ (' + oldTabs.map(t => t.getName()).join(', ') + ') để chỉ còn "' + SHEET_NAME + '"?', ui.ButtonSet.YES_NO);

  if(ans === ui.Button.YES) oldTabs.forEach(t => { try{ ss.deleteSheet(t); }catch(e){} });

}



/** Xóa các tab cũ (chỉ giữ Trang tính1). Nhớ chạy mục 2 trước nếu tab cũ còn dữ liệu. */

function deleteOldTabs(){

  const ss = SpreadsheetApp.getActiveSpreadsheet(); const ui = SpreadsheetApp.getUi();

  const tabs = COLLECTIONS.map(c => ss.getSheetByName(c)).filter(t => t && t.getName() !== SHEET_NAME);

  if(!tabs.length){ ui.alert('Không còn tab cũ nào. Chỉ có "' + SHEET_NAME + '".'); return; }

  const ans = ui.alert('Xóa ' + tabs.map(t => t.getName()).join(', ') + '?\n(Chọn "Không" nếu chưa chạy mục 2 — dữ liệu trong tab cũ sẽ mất.)', ui.ButtonSet.YES_NO);

  if(ans === ui.Button.YES) tabs.forEach(t => { try{ ss.deleteSheet(t); }catch(e){} });

}



/** Thầy cô sửa tay họ tên / trường của tài khoản trên Sheet → chạy mục 5 để chép sang các dòng liên quan */

function cascadeAll(){

  const lock = LockService.getScriptLock(); lock.waitLock(25000);

  let total = 0;

  try{

    const sh = sheet_(); const H = headerMap_(sh);

    const last = sh.getLastRow(); if(last < 2) return;

    const accounts = sh.getRange(2, 1, last - 1, H.width).getValues()

      .map(row => rowToDoc_(row, H)).filter(d => isAcc(d.c) && d.id);

    accounts.forEach(a => { total += cascadeAccount_(sh, H, a.c, a.id, {displayName:'\u0000'}, a.data); });

  }finally{ lock.releaseLock(); }

  SpreadsheetApp.getActiveSpreadsheet().toast('Đã đồng bộ ' + total + ' dòng.', 'AI HealthPulse', 5);

}



/** Thầy cô sửa tay ô Họ và tên / Tên hiển thị / thông tin trường ở dòng tài khoản → tự chép sang các dòng liên quan */

const CASCADE_HEADERS = ['HỌ VÀ TÊN', 'TÊN HIỂN THỊ', 'MÃ TRƯỜNG', 'TÊN TRƯỜNG', 'CẤP HỌC', 'PHƯỜNG/XÃ', 'QUẬN/HUYỆN', 'TỈNH/THÀNH PHỐ', 'MÃ TỈNH/THÀNH PHỐ', 'MÃ PHƯỜNG/XÃ', 'ĐỊA CHỈ'];

function onEdit(e){
  try{
    const sh = e && e.range && e.range.getSheet();
    if(!sh || sh.getName() !== SHEET_NAME || e.range.getRow() < 2) return;
    const H = headerMap_(sh);
    const c0 = e.range.getColumn() - 1, c1 = c0 + e.range.getNumColumns() - 1;
    const affectsCascade = CASCADE_HEADERS.some(h => H.idx[h] !== undefined && H.idx[h] >= c0 && H.idx[h] <= c1);

    if(affectsCascade){
      const lock = LockService.getScriptLock();
      if(lock.tryLock(10000)){
        try{
          for(let r = e.range.getRow(); r < e.range.getRow() + e.range.getNumRows(); r++){
            const row = sh.getRange(r, 1, 1, H.width).getValues()[0];
            const doc = rowToDoc_(row, H);
            if(!isAcc(doc.c) || !doc.id) continue;
            sh.getRange(r, 1, 1, H.width).setValues([docToRow_(doc.c, doc.id, doc.data, H, row)]);
            cascadeAccount_(sh, H, doc.c, doc.id, {displayName:'\u0000'}, doc.data);
          }
        }finally{ lock.releaseLock(); }
      }
    }

    styleRows_(sh, e.range.getRow(), e.range.getNumRows());
    maybeAutoFit_(sh, e.range.getRow(), e.range.getNumRows(), false);
    ensureSpareRows_(sh, MIN_FREE_ROWS);
  }catch(err){}
}
