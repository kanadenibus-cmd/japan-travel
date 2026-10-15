/* =========================================================
   일본 여행 기록장
   - 기록 저장: 브라우저 localStorage에 먼저 저장 (백업은 JSON 파일)
   - 기기 간 동기화: 내 GitHub 계정의 비공개 Gist (켜 둔 경우만)
   - 지도: Leaflet + OpenStreetMap / 일본 국토지리원 타일
   - 장소 검색·주소 찾기: OpenStreetMap Nominatim
   ========================================================= */
'use strict';

const STORE_KEY = 'jp-travel-places-v1';
const DELETED_KEY = 'jp-travel-deleted-v1'; // 지운 장소 id → 지운 시각 (동기화 때 다른 기기에서도 지우기 위함)
const SETTINGS_KEY = 'jp-travel-settings-v1';
const SYNC_KEY = 'jp-travel-sync-v1';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const JAPAN_VIEW = { center: [36.4, 137.9], zoom: 5 };

const CATEGORIES = [
  { id: 'sight', label: '관광지', icon: '🏯' },
  { id: 'food', label: '맛집', icon: '🍜' },
  { id: 'cafe', label: '카페·디저트', icon: '☕' },
  { id: 'nature', label: '자연·풍경', icon: '🗻' },
  { id: 'onsen', label: '온천', icon: '♨️' },
  { id: 'shopping', label: '쇼핑', icon: '🛍️' },
  { id: 'activity', label: '체험·놀거리', icon: '🎡' },
  { id: 'stay', label: '숙소', icon: '🏨' },
  { id: 'etc', label: '기타', icon: '📍' },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
const catOf = p => CAT[p.category] || CAT.etc;

// [일본어, 한국어] — 도도부현 코드 순서(JP-01 … JP-47), 북쪽부터
const PREFECTURES = [
  ['北海道', '홋카이도'], ['青森県', '아오모리현'], ['岩手県', '이와테현'], ['宮城県', '미야기현'],
  ['秋田県', '아키타현'], ['山形県', '야마가타현'], ['福島県', '후쿠시마현'], ['茨城県', '이바라키현'],
  ['栃木県', '도치기현'], ['群馬県', '군마현'], ['埼玉県', '사이타마현'], ['千葉県', '지바현'],
  ['東京都', '도쿄도'], ['神奈川県', '가나가와현'], ['新潟県', '니가타현'], ['富山県', '도야마현'],
  ['石川県', '이시카와현'], ['福井県', '후쿠이현'], ['山梨県', '야마나시현'], ['長野県', '나가노현'],
  ['岐阜県', '기후현'], ['静岡県', '시즈오카현'], ['愛知県', '아이치현'], ['三重県', '미에현'],
  ['滋賀県', '시가현'], ['京都府', '교토부'], ['大阪府', '오사카부'], ['兵庫県', '효고현'],
  ['奈良県', '나라현'], ['和歌山県', '와카야마현'], ['鳥取県', '돗토리현'], ['島根県', '시마네현'],
  ['岡山県', '오카야마현'], ['広島県', '히로시마현'], ['山口県', '야마구치현'], ['徳島県', '도쿠시마현'],
  ['香川県', '가가와현'], ['愛媛県', '에히메현'], ['高知県', '고치현'], ['福岡県', '후쿠오카현'],
  ['佐賀県', '사가현'], ['長崎県', '나가사키현'], ['熊本県', '구마모토현'], ['大分県', '오이타현'],
  ['宮崎県', '미야자키현'], ['鹿児島県', '가고시마현'], ['沖縄県', '오키나와현'],
];
const REGION_ORDER = new Map(PREFECTURES.map(([, ko], i) => [ko, i]));

const REVISIT = { again: '꼭 다시 갈래요', maybe: '기회 되면 또', once: '한 번이면 충분' };
const PRIORITY_LABELS = ['', '조금 궁금', '가 보고 싶다', '꽤 기대돼', '정말 기대돼', '무조건 간다!'];
const RATING_LABELS = ['', '별로였어', '그저 그랬어', '괜찮았어', '좋았어', '최고였어!'];

const byRecent = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
const SORTS = {
  recent: { label: '최근 추가순', fn: byRecent },
  priority: { label: '기대도순', fn: (a, b) => (b.priority || 0) - (a.priority || 0) || byRecent(a, b) },
  visitedDate: { label: '최근 방문순', fn: (a, b) => (b.visitedDate || '').localeCompare(a.visitedDate || '') || byRecent(a, b) },
  rating: { label: '만족도순', fn: (a, b) => (b.rating || 0) - (a.rating || 0) || byRecent(a, b) },
  region: { label: '지역순', fn: (a, b) => regionRank(a.region) - regionRank(b.region) || a.name.localeCompare(b.name, 'ko') },
  name: { label: '이름순', fn: (a, b) => a.name.localeCompare(b.name, 'ko') },
};
const DEFAULT_SORT = { wish: 'recent', visited: 'visitedDate', all: 'recent' };

const TEXT_FIELDS = ['name', 'category', 'region', 'address', 'googleUrl', 'reason', 'cost', 'costNote',
  'access', 'notes', 'visitedDate', 'oneLine', 'review', 'actualCost', 'revisit', 'tips'];

/* ---------- 작은 도우미 ---------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hasLoc = p => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const regionRank = r => (REGION_ORDER.has(r) ? REGION_ORDER.get(r) : 99);
const firstLine = s => String(s || '').split('\n').find(l => l.trim()) || '';

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clampInt(v, min, max) {
  const n = Math.round(Number(v) || 0);
  return Math.min(max, Math.max(min, n));
}
function yen(n) { return n === 0 ? '무료' : '¥' + Math.round(n).toLocaleString('ja-JP'); }
function won(n) {
  const v = Math.round((n * state.settings.krwPer100) / 100 / 10) * 10;
  return `약 ${v.toLocaleString('ko-KR')}원`;
}
function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? `${+m[1]}. ${+m[2]}. ${+m[3]}.` : '';
}
function fmtIsoDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
function symbols(n, sym, cls) {
  if (!n) return '';
  return `<span class="${cls}" aria-label="5점 중 ${n}점">${sym.repeat(n)}<span class="off">${sym.repeat(5 - n)}</span></span>`;
}
const stars = n => symbols(n, '★', 'stars');
const hearts = n => symbols(n, '♥', 'hearts');

function regionFromText(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const hit = PREFECTURES.find(([ja, ko]) => s === ja || s === ko);
  return hit ? hit[1] : s;
}

/* ---------- 저장소 ---------- */
function normalizePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = k => (raw[k] === null || raw[k] === undefined ? '' : String(raw[k]).trim());
  const name = str('name');
  if (!name) return null;
  const lat = toNum(raw.lat);
  const lng = toNum(raw.lng);
  const locOk = lat !== null && lng !== null && validLatLng(lat, lng);
  const now = new Date().toISOString();
  return {
    id: str('id') || uid(),
    status: raw.status === 'visited' ? 'visited' : 'wish',
    name,
    category: CAT[raw.category] ? raw.category : 'etc',
    region: str('region'),
    address: str('address'),
    googleUrl: str('googleUrl'),
    lat: locOk ? lat : null,
    lng: locOk ? lng : null,
    // 가기 전 메모
    priority: clampInt(raw.priority, 0, 5),
    reason: str('reason'),
    cost: toNum(raw.cost),
    costNote: str('costNote'),
    access: str('access'),
    notes: str('notes'),
    // 다녀온 기록
    visitedDate: /^\d{4}-\d{2}-\d{2}$/.test(str('visitedDate')) ? str('visitedDate') : '',
    rating: clampInt(raw.rating, 0, 5),
    oneLine: str('oneLine'),
    review: str('review'),
    actualCost: toNum(raw.actualCost),
    revisit: REVISIT[raw.revisit] ? raw.revisit : '',
    tips: str('tips'),
    createdAt: str('createdAt') || now,
    updatedAt: str('updatedAt') || now,
  };
}

function cleanDeleted(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [id, at] of Object.entries(raw)) if (id && typeof at === 'string' && at) out[id] = at;
  }
  return out;
}

function loadPlaces() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(arr) ? arr.map(normalizePlace).filter(Boolean) : [];
  } catch {
    return [];
  }
}
function loadDeleted() {
  try {
    return cleanDeleted(JSON.parse(localStorage.getItem(DELETED_KEY) || '{}'));
  } catch {
    return {};
  }
}
function storeLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.places));
    localStorage.setItem(DELETED_KEY, JSON.stringify(state.deleted));
  } catch {
    toast('저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.');
  }
}
// 사용자가 바꾼 내용: 이 기기에 바로 저장하고, 동기화를 켜 두었으면 잠시 뒤 GitHub에도 올림
function savePlaces() {
  storeLocal();
  scheduleSync();
}
function loadSettings() {
  const defaults = { krwPer100: 900, baseLayer: '' };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const rate = toNum(s.krwPer100);
    return { ...defaults, ...s, krwPer100: rate && rate > 0 ? rate : defaults.krwPer100 };
  } catch {
    return defaults;
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch { /* 무시 */ }
}

/* ---------- 상태 ---------- */
const state = {
  places: loadPlaces(),
  deleted: loadDeleted(),
  settings: loadSettings(),
  tab: 'wish',
  query: '',
  region: '',
  category: '',
  sort: DEFAULT_SORT.wish,
  selectedId: null,
  pending: null,   // 지도에서 새로 찍은(아직 저장 안 한) 위치
  formLoc: null,   // 입력 폼에서 고른 위치
  picking: false,  // 폼에서 '지도에서 찍기' 중
  needsFit: false, // 지도가 숨겨져 있는 동안 미뤄 둔 화면 맞춤
};
const getPlace = id => state.places.find(p => p.id === id) || null;

const els = {
  stats: $('#stats'),
  layout: $('#layout'),
  panel: $('#panel'),
  listView: $('#list-view'),
  detailView: $('#detail-view'),
  tabs: [...document.querySelectorAll('.tab')],
  counts: { wish: $('#count-wish'), visited: $('#count-visited'), all: $('#count-all') },
  filterText: $('#filter-text'),
  filterRegion: $('#filter-region'),
  sort: $('#sort'),
  cats: $('#filter-cats'),
  list: $('#place-list'),
  empty: $('#empty'),
  mapWrap: $('#map-wrap'),
  quickAdd: $('#quick-add'),
  quickForm: $('#quick-form'),
  quickInput: $('#quick-input'),
  quickBtn: $('#quick-btn'),
  results: $('#search-results'),
  pickBanner: $('#pick-banner'),
  dialog: $('#place-dialog'),
  form: $('#place-form'),
  formTitle: $('#form-title'),
  locText: $('#loc-text'),
  btnPick: $('#btn-pick'),
  btnGeocode: $('#btn-geocode'),
  btnClearLoc: $('#btn-clear-loc'),
  geoResults: $('#geo-results'),
  gurlHint: $('#gurl-hint'),
  visitedSection: $('#visited-section'),
  wishDetails: $('#wish-details'),
  settingsDialog: $('#settings-dialog'),
  helpDialog: $('#help-dialog'),
  rateInput: $('#rate-input'),
  importFile: $('#import-file'),
  btnSettings: $('#btn-settings'),
  syncPill: $('#sync-pill'),
  syncText: $('#sync-text'),
  syncDots: [...document.querySelectorAll('.sync-dot')],
  syncOff: $('#sync-off'),
  syncOn: $('#sync-on'),
  syncForm: $('#sync-form'),
  syncToken: $('#sync-token'),
  syncConnect: $('#btn-sync-connect'),
  syncHint: $('#sync-hint'),
  syncTitle: $('#sync-title'),
  syncDetail: $('#sync-detail'),
  syncNowBtn: $('#btn-sync-now'),
  syncGistLink: $('#sync-gist-link'),
  toast: $('#toast'),
  mobileButtons: [...document.querySelectorAll('.mobile-switch button')],
};

/* ---------- 지도 ---------- */
const map = L.map('map', { zoomControl: false, worldCopyJump: true })
  .setView(JAPAN_VIEW.center, JAPAN_VIEW.zoom);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
L.control.zoom({ position: 'bottomright', zoomInTitle: '확대', zoomOutTitle: '축소' }).addTo(map);

// 모두 API 키 없이 쓸 수 있는 지도 (오른쪽 위 버튼으로 바꿀 수 있음)
const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const BASE_LAYERS = {
  '연한 지도 (일본 지리원)': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    maxZoom: 19, maxNativeZoom: 18, attribution: GSI_ATTR,
  }),
  '표준 지도 (일본 지리원)': L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
    maxZoom: 19, maxNativeZoom: 18, attribution: GSI_ATTR,
  }),
};
// OpenStreetMap 타일은 웹 주소(http)로 열었을 때만 쓸 수 있음 — 파일을 바로 열면 차단됨
if (location.protocol.startsWith('http')) {
  BASE_LAYERS['상세 지도 (OpenStreetMap)'] = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  });
}
(BASE_LAYERS[state.settings.baseLayer] || Object.values(BASE_LAYERS)[0]).addTo(map);
L.control.layers(BASE_LAYERS, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', e => { state.settings.baseLayer = e.name; saveSettings(); });

const markerLayer = L.layerGroup().addTo(map);
const markers = new Map();
let tempMarker = null;

function pinIcon(p, selected) {
  const size = selected ? 42 : 34;
  const tip = Math.round(size / 2 + size / Math.SQRT2); // 45° 돌린 물방울 모양의 꼭짓점
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin ${p.status}${selected ? ' selected' : ''}"><span>${catOf(p).icon}</span></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, tip],
    popupAnchor: [0, -tip],
  });
}
const tempIcon = L.divIcon({
  className: 'pin-wrap',
  html: '<div class="pin temp"><span>+</span></div>',
  iconSize: [36, 36], iconAnchor: [18, 43], popupAnchor: [0, -43],
});

const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
const isMapVisible = () => els.mapWrap.offsetWidth > 0;

function renderMarkers() {
  markerLayer.clearLayers();
  markers.clear();
  for (const p of visiblePlaces()) {
    if (!hasLoc(p)) continue;
    const selected = p.id === state.selectedId;
    const m = L.marker([p.lat, p.lng], {
      icon: pinIcon(p, selected), title: p.name, riseOnHover: true, zIndexOffset: selected ? 500 : 0,
    });
    // 팝업보다 먼저 등록해야 선택 표시(큰 핀)가 반영된 위치에 팝업이 뜸
    m.on('click', () => selectPlace(p.id, { from: 'map' }));
    m.bindPopup(() => placePopup(p.id), { minWidth: 210, maxWidth: 270, autoPanPadding: [30, 90] });
    m.addTo(markerLayer);
    markers.set(p.id, m);
  }
}

function refreshMarkerIcon(id) {
  const m = markers.get(id);
  const p = getPlace(id);
  if (!m || !p) return;
  const selected = id === state.selectedId;
  m.setIcon(pinIcon(p, selected));
  m.setZIndexOffset(selected ? 500 : 0);
}

function fitToVisible({ animate = true } = {}) {
  const pts = visiblePlaces().filter(hasLoc).map(p => [p.lat, p.lng]);
  if (!pts.length) return;
  if (!isMapVisible()) { state.needsFit = true; return; }
  state.needsFit = false;
  if (pts.length === 1) map.setView(pts[0], 14, { animate });
  else map.fitBounds(pts, { padding: [70, 70], maxZoom: 14, animate });
}

function focusPlace(p, { popup = true } = {}) {
  if (!hasLoc(p)) return;
  const zoom = Math.max(map.getZoom(), 15);
  if (!isMapVisible()) {
    map.setView([p.lat, p.lng], zoom, { animate: false });
    state.needsFit = false;
    return;
  }
  if (popup) {
    map.once('moveend', () => {
      if (state.selectedId === p.id) markers.get(p.id)?.openPopup();
    });
  }
  map.flyTo([p.lat, p.lng], zoom, { duration: 0.6 });
}

function gmapsUrl(p) {
  const saved = safeUrl(p.googleUrl);
  if (saved) return saved;
  const q = hasLoc(p) ? `${p.lat},${p.lng}` : [p.name, p.region].filter(Boolean).join(' ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
function directionsUrl(p) {
  const dest = hasLoc(p) ? `${p.lat},${p.lng}` : [p.name, p.region].filter(Boolean).join(' ');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

function placePopup(id) {
  const p = getPlace(id);
  const el = document.createElement('div');
  el.className = 'pop';
  if (!p) return el;
  const visited = p.status === 'visited';
  const line = visited ? (p.oneLine || firstLine(p.review)) : firstLine(p.reason);
  el.innerHTML = `
    <div class="pop-title">${esc(p.name)}</div>
    <div class="pop-sub">${visited ? '다녀온 곳' : '가고 싶은 곳'} · ${esc(catOf(p).label)}${p.region ? ' · ' + esc(p.region) : ''}</div>
    ${visited && p.rating ? `<div class="pop-line">${stars(p.rating)}</div>` : ''}
    ${!visited && p.priority ? `<div class="pop-line">${hearts(p.priority)}</div>` : ''}
    ${line ? `<div class="pop-line">${esc(line)}</div>` : ''}
    <div class="pop-actions">
      <button type="button" class="btn small" data-act="detail">자세히 보기</button>
      <a class="btn small" href="${esc(gmapsUrl(p))}" target="_blank" rel="noopener">구글 지도 ↗</a>
    </div>`;
  el.querySelector('[data-act="detail"]').addEventListener('click', () => {
    setView('list');
    selectPlace(p.id, { from: 'popup' });
  });
  return el;
}

/* ---------- 새 위치(임시 핀) ---------- */
function setPending(info, { reverse = false, fly = false } = {}) {
  clearPending();
  const pd = {
    lat: info.lat, lng: info.lng,
    name: info.name || '', address: info.address || '', region: info.region || '',
    googleUrl: info.googleUrl || '',
    loading: reverse,
  };
  state.pending = pd;
  tempMarker = L.marker([pd.lat, pd.lng], { icon: tempIcon, zIndexOffset: 1000 }).addTo(map);
  tempMarker.bindPopup(() => pendingPopup(pd), { minWidth: 230, maxWidth: 290, autoPanPadding: [30, 90] });
  tempMarker.on('popupclose', () => { if (state.pending === pd) clearPending(); });

  if (fly && isMapVisible()) {
    map.once('moveend', () => { if (state.pending === pd) tempMarker.openPopup(); });
    map.flyTo([pd.lat, pd.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
  } else {
    if (fly) map.setView([pd.lat, pd.lng], Math.max(map.getZoom(), 16), { animate: false });
    tempMarker.openPopup();
  }

  if (reverse) {
    reverseGeocode(pd.lat, pd.lng)
      .then(r => {
        if (!pd.name) pd.name = r.name;
        if (!pd.address) pd.address = r.address;
        if (!pd.region) pd.region = r.region;
        // 주소를 찾기 전에 폼을 열었다면 빈 칸만 채워 줌
        if (formSource === pd && els.dialog.open) fillEmptyFields({ name: pd.name, address: pd.address, region: pd.region });
      })
      .catch(() => {})
      .finally(() => {
        pd.loading = false;
        if (state.pending === pd && tempMarker) tempMarker.setPopupContent(pendingPopup(pd));
      });
  }
}

function clearPending() {
  const m = tempMarker;
  state.pending = null;
  tempMarker = null;
  if (m) { m.off(); map.removeLayer(m); }
}

function pendingPopup(pd) {
  const el = document.createElement('div');
  el.className = 'pop';
  const sub = pd.loading ? '주소 확인 중…' : (pd.address || `${pd.lat.toFixed(5)}, ${pd.lng.toFixed(5)}`);
  el.innerHTML = `
    <div class="pop-kicker">새 장소</div>
    <div class="pop-title">${esc(pd.name || (pd.loading ? '…' : '선택한 위치'))}</div>
    <div class="pop-sub">${esc(sub)}</div>
    <div class="pop-actions">
      <button type="button" class="btn small wish" data-status="wish">♡ 가고 싶은 곳</button>
      <button type="button" class="btn small visited" data-status="visited">✓ 다녀온 곳</button>
    </div>`;
  el.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => {
    openForm(null, {
      status: b.dataset.status,
      name: pd.name, address: pd.address, region: pd.region, googleUrl: pd.googleUrl,
      lat: pd.lat, lng: pd.lng,
    }, { source: pd });
  }));
  return el;
}

// 지도 클릭: 팝업을 닫으려는 클릭과 더블클릭(확대)은 새 위치로 치지 않음
let popupOpen = false;
let suppressClick = false;
let clickTimer = null;
map.on('popupopen', () => { popupOpen = true; });
map.on('popupclose', () => { popupOpen = false; });
map.on('preclick', () => { suppressClick = popupOpen; });
map.on('click', e => {
  if (state.picking) { endPick(e.latlng); return; }
  if (suppressClick) { suppressClick = false; return; }
  hideResults();
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => setPending({ lat: e.latlng.lat, lng: e.latlng.lng }, { reverse: true }), 250);
});
map.on('dblclick', () => clearTimeout(clickTimer));

/* ---------- 구글 지도 링크 · 좌표 해석 ---------- */
function parseCoords(text) {
  const m = String(text || '').trim()
    .match(/^\(?\s*(-?\d{1,3}\.\d+)\s*[,，\s]\s*(-?\d{1,3}\.\d+)\s*\)?$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return validLatLng(lat, lng) ? { lat, lng } : null;
}

function parseGoogleMaps(text) {
  const src = String(text || '');
  // 핀을 찍은 링크에는 34°58'01" 처럼 작은따옴표가 그대로 들어 있어서 허용함
  const found = src.match(/https?:\/\/[^\s<>"]+/i);
  if (!found) return null;
  const raw = found[0].replace(/[').,\]]+$/, '');
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const isShort = host === 'maps.app.goo.gl' || (host === 'goo.gl' && u.pathname.startsWith('/maps'));
  const isGoogleMaps = /(^|\.)google\.[a-z.]{2,6}$/.test(host) && (host.startsWith('maps.') || u.pathname.startsWith('/maps'));
  if (!isShort && !isGoogleMaps) return null;

  // 링크 앞에 붙어 오는 장소 이름(휴대폰 '공유' 문구)
  const nameHint = src.slice(0, found.index).split('\n').map(s => s.trim()).find(s => /\p{L}/u.test(s)) || '';
  const out = { url: raw, lat: null, lng: null, name: '', nameHint, short: isShort };
  if (isShort) return out;

  // 위치: !3d!4d(장소의 정확한 좌표) → @위도,경도(화면 중심) → q/ll 등 파라미터
  const full = safeDecode(raw);
  let c = full.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || full.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  let lat = c ? Number(c[1]) : NaN;
  let lng = c ? Number(c[2]) : NaN;
  if (!validLatLng(lat, lng)) {
    for (const key of ['q', 'query', 'll', 'center', 'destination', 'daddr', 'sll']) {
      const cc = parseCoords(u.searchParams.get(key) || '');
      if (cc) { ({ lat, lng } = cc); break; }
    }
  }
  if (validLatLng(lat, lng)) { out.lat = lat; out.lng = lng; }

  // 이름: /maps/place/이름/ → /maps/search/이름/ → q= 파라미터
  let name = '';
  const seg = u.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/);
  if (seg) name = safeDecode(seg[1].replace(/\+/g, ' '));
  if (!name) {
    const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
    if (q && !parseCoords(q)) name = q;
  }
  if (/[°′″]/.test(name) || parseCoords(name)) name = ''; // 이름 대신 좌표가 들어간 경우
  out.name = name.trim();
  return out;
}

/* ---------- 장소 검색 (OpenStreetMap Nominatim) ---------- */
async function nominatim(path, params) {
  const url = new URL(NOMINATIM + path);
  const all = { format: 'jsonv2', addressdetails: 1, 'accept-language': 'ko,ja', ...params };
  Object.entries(all).forEach(([k, v]) => url.searchParams.set(k, v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function regionFromAddress(a = {}) {
  const m = /^JP-(\d{2})$/.exec(a['ISO3166-2-lvl4'] || '');
  if (m && PREFECTURES[+m[1] - 1]) return PREFECTURES[+m[1] - 1][1];
  return regionFromText(a.province || a.state || '');
}

function shortAddress(d) {
  const parts = String(d.display_name || '').split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1 && d.name && parts[0] === d.name) parts.shift();
  return parts
    .filter(s => !/^\d{3}-?\d{4}$/.test(s) && !['일본', '日本', 'Japan'].includes(s))
    .reverse()
    .join(' ');
}

// 지도를 찍었을 때 도로·행정구역 이름이 장소 이름으로 들어가지 않도록
const NOT_A_PLACE = ['highway', 'boundary', 'landuse', 'place'];

function fromNominatim(d, { reverse = false } = {}) {
  return {
    lat: Number(d.lat),
    lng: Number(d.lon),
    name: reverse && NOT_A_PLACE.includes(d.category) ? '' : (d.name || ''),
    address: shortAddress(d),
    region: regionFromAddress(d.address),
  };
}

async function searchPlaces(q) {
  const data = await nominatim('/search', { q, countrycodes: 'jp', limit: 8 });
  const out = [];
  for (const r of (Array.isArray(data) ? data : []).map(d => fromNominatim(d))) {
    if (!validLatLng(r.lat, r.lng)) continue;
    // 같은 이름으로 바로 옆에 겹쳐 나오는 결과(건물·부지 등)는 하나만
    const dup = out.some(o => o.name === r.name && Math.abs(o.lat - r.lat) < 0.003 && Math.abs(o.lng - r.lng) < 0.003);
    if (!dup) out.push(r);
  }
  return out;
}

async function reverseGeocode(lat, lng) {
  const d = await nominatim('/reverse', { lat, lon: lng, zoom: 18 });
  if (!d || d.error) throw new Error(d?.error || 'not found');
  return fromNominatim(d, { reverse: true });
}

/* ---------- 지도 위 검색창 ---------- */
function setQuickBusy(busy) {
  els.quickBtn.disabled = busy;
  els.quickBtn.textContent = busy ? '찾는 중…' : '찾기';
}
function hideResults() {
  els.results.hidden = true;
  els.results.innerHTML = '';
}
function showNote(html, action) {
  els.results.innerHTML = '';
  appendNote(html, action);
  els.results.hidden = false;
}
function appendNote(html, action) {
  const li = document.createElement('li');
  li.className = 'result-note';
  li.innerHTML = html;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = action.label;
    b.addEventListener('click', () => { hideResults(); action.run(); });
    li.append(document.createElement('br'), b);
  }
  els.results.append(li);
}
function showResults(list, { googleUrl = '', note = '' } = {}) {
  els.results.innerHTML = '';
  if (note) appendNote(esc(note));
  if (!list.length) {
    appendNote('검색 결과가 없어요. 일본어나 영어 이름으로 다시 찾아보거나, 지도를 직접 클릭해 보세요.');
  }
  for (const r of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'result';
    b.innerHTML = `<strong>${esc(r.name || r.address || '이름 없는 장소')}</strong><span>${esc(r.address)}</span>`;
    b.addEventListener('click', () => {
      hideResults();
      els.quickInput.value = '';
      setPending({ ...r, googleUrl }, { fly: true });
    });
    li.append(b);
    els.results.append(li);
  }
  els.results.hidden = false;
}

async function runSearch(q, opts = {}) {
  setQuickBusy(true);
  try {
    showResults(await searchPlaces(q), opts);
  } catch {
    showNote('검색 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.');
  } finally {
    setQuickBusy(false);
  }
}

const tabStatus = () => (state.tab === 'visited' ? 'visited' : 'wish');

async function handleQuick(text) {
  hideResults();
  const t = text.trim();
  if (!t) return;

  const g = parseGoogleMaps(t);
  if (g) {
    if (hasLoc(g)) {
      els.quickInput.value = '';
      setPending({ lat: g.lat, lng: g.lng, name: g.name || g.nameHint, googleUrl: g.url }, { reverse: true, fly: true });
      return;
    }
    const hint = g.name || g.nameHint;
    if (hint) {
      await runSearch(hint, {
        googleUrl: g.url,
        note: g.short
          ? '짧은 링크는 위치를 바로 읽을 수 없어서 이름으로 찾아봤어요. 맞는 장소를 골라 주세요. (링크도 함께 저장돼요)'
          : '링크에 위치 정보가 없어서 이름으로 찾아봤어요.',
      });
      return;
    }
    showNote(
      g.short
        ? '짧은 링크(maps.app.goo.gl)는 위치를 바로 읽을 수 없어요.<br>링크를 브라우저에서 열어 <b>주소창의 긴 주소</b>를 붙여넣거나, <b>장소 이름</b>으로 검색해 주세요.'
        : '이 링크에서는 위치를 찾지 못했어요. 장소 이름으로 검색해 주세요.',
      { label: '링크만 저장하고 직접 입력하기', run: () => openForm(null, { status: tabStatus(), googleUrl: g.url }) },
    );
    return;
  }

  const c = parseCoords(t);
  if (c) {
    els.quickInput.value = '';
    setPending(c, { reverse: true, fly: true });
    return;
  }
  await runSearch(t);
}

els.quickForm.addEventListener('submit', e => {
  e.preventDefault();
  handleQuick(els.quickInput.value);
});
// 링크나 좌표를 붙여넣으면 바로 찾기
els.quickInput.addEventListener('paste', () => {
  setTimeout(() => {
    const t = els.quickInput.value.trim();
    if (parseGoogleMaps(t) || parseCoords(t)) handleQuick(t);
  }, 0);
});
els.quickInput.addEventListener('keydown', e => { if (e.key === 'Escape') hideResults(); });
document.addEventListener('pointerdown', e => {
  if (!els.results.hidden && !els.quickAdd.contains(e.target)) hideResults();
});

/* ---------- 목록 ---------- */
function visiblePlaces() {
  const q = state.query.trim().toLowerCase();
  const sort = (SORTS[state.sort] || SORTS.recent).fn;
  return state.places
    .filter(p => state.tab === 'all' || p.status === state.tab)
    .filter(p => !state.region || p.region === state.region)
    .filter(p => !state.category || p.category === state.category)
    .filter(p => !q || [p.name, p.region, p.address, p.reason, p.access, p.notes, p.costNote, p.oneLine, p.review, p.tips]
      .some(s => (s || '').toLowerCase().includes(q)))
    .sort(sort);
}

function renderStats() {
  const wish = state.places.filter(p => p.status === 'wish');
  const visited = state.places.filter(p => p.status === 'visited');
  const cost = wish.reduce((s, p) => s + (p.cost || 0), 0);
  const rated = visited.filter(p => p.rating);
  const avg = rated.length ? rated.reduce((s, p) => s + p.rating, 0) / rated.length : 0;
  els.stats.innerHTML = `
    <div class="stat"><i class="dot wish"></i><span>가고 싶은 곳</span><strong>${wish.length}</strong>${cost ? `<small>예상 ${yen(cost)} · ${won(cost)}</small>` : ''}</div>
    <div class="stat"><i class="dot visited"></i><span>다녀온 곳</span><strong>${visited.length}</strong>${avg ? `<small>평균 ★${avg.toFixed(1)}</small>` : ''}</div>`;
  els.counts.wish.textContent = wish.length;
  els.counts.visited.textContent = visited.length;
  els.counts.all.textContent = state.places.length;
}

function renderRegionFilter() {
  const regions = [...new Set(state.places
    .filter(p => state.tab === 'all' || p.status === state.tab)
    .map(p => p.region).filter(Boolean))]
    .sort((a, b) => regionRank(a) - regionRank(b) || a.localeCompare(b, 'ko'));
  if (state.region && !regions.includes(state.region)) state.region = '';
  els.filterRegion.innerHTML = '<option value="">모든 지역</option>' +
    regions.map(r => `<option value="${esc(r)}"${r === state.region ? ' selected' : ''}>${esc(r)}</option>`).join('');
}

function itemHtml(p) {
  const cat = catOf(p);
  const visited = p.status === 'visited';
  const meta = [p.region, cat.label].filter(Boolean).map(esc).join(' · ') +
    (hasLoc(p) ? '' : ' · <span class="no-loc">위치 없음</span>');
  const snippet = visited ? (p.oneLine || p.review) : p.reason;
  let side = '';
  if (visited) {
    if (p.rating) side += `<span class="stars">${'★'.repeat(p.rating)}</span>`;
    if (p.visitedDate) side += `<span>${fmtDate(p.visitedDate)}</span>`;
  } else {
    if (p.cost !== null) side += `<span class="price">${yen(p.cost)}</span>`;
    if (p.priority) side += `<span class="hearts">${'♥'.repeat(p.priority)}</span>`;
  }
  const pill = state.tab === 'all'
    ? `<span class="mini-pill ${p.status}">${visited ? '다녀옴' : '가고 싶음'}</span>` : '';
  return `<li><button type="button" class="place-btn" data-id="${esc(p.id)}">
      <span class="cat-badge ${p.status}" aria-hidden="true">${cat.icon}</span>
      <span class="pi-main">
        <span class="pi-title"><span>${esc(p.name)}</span>${pill}</span>
        <span class="pi-meta">${meta}</span>
        ${snippet ? `<span class="pi-snippet">${esc(snippet)}</span>` : ''}
      </span>
      <span class="pi-side">${side}</span>
    </button></li>`;
}

function emptyHtml() {
  const filtered = state.query || state.region || state.category;
  if (filtered) {
    return `<p class="empty-title">조건에 맞는 장소가 없어요</p>
      <button type="button" class="btn small" data-act="reset-filters">필터 초기화</button>`;
  }
  if (state.tab === 'visited') {
    return `<div class="empty-art">✓</div>
      <p class="empty-title">아직 다녀온 곳이 없어요</p>
      <p>‘가고 싶은 곳’에서 <b>✓ 다녀왔어요!</b>를 누르면 이쪽으로 옮겨져요. 이미 다녀온 곳은 지도에서 바로 추가해도 돼요.</p>`;
  }
  return `<div class="empty-art">♡</div>
    <p class="empty-title">가고 싶은 곳을 모아 보세요</p>
    <ol class="steps">
      <li>지도 위 검색창에 <b>구글 지도 링크</b>나 <b>장소 이름</b>을 넣거나,</li>
      <li><b>지도를 클릭</b>해서 위치를 찍은 다음,</li>
      <li><b>♡ 가고 싶은 곳</b>을 누르면 끝!</li>
    </ol>`;
}

function renderList() {
  const items = visiblePlaces();
  els.list.innerHTML = items.map(itemHtml).join('');
  els.empty.hidden = items.length > 0;
  if (!items.length) els.empty.innerHTML = emptyHtml();
}

function renderAll() {
  renderStats();
  renderRegionFilter();
  renderList();
  renderMarkers();
  if (state.selectedId) {
    const p = getPlace(state.selectedId);
    if (p) showDetail(p); else closeDetail();
  }
}

function setTab(tab, { fit = true } = {}) {
  state.tab = tab;
  state.sort = DEFAULT_SORT[tab];
  els.sort.value = state.sort;
  els.panel.dataset.tab = tab;
  els.tabs.forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  closeDetail();
  renderAll();
  if (fit) fitToVisible();
}

function resetFilters() {
  state.query = '';
  state.region = '';
  state.category = '';
  els.filterText.value = '';
  renderCategoryChips();
  renderAll();
}

function renderCategoryChips() {
  els.cats.innerHTML = [{ id: '', label: '전체', icon: '' }, ...CATEGORIES]
    .map(c => `<button type="button" class="chip${state.category === c.id ? ' active' : ''}" data-cat="${c.id}" aria-pressed="${state.category === c.id}">${c.icon ? c.icon + ' ' : ''}${esc(c.label)}</button>`)
    .join('');
}

/* ---------- 상세 보기 ---------- */
let listScroll = 0;

function selectPlace(id, { from = 'list' } = {}) {
  const p = getPlace(id);
  if (!p) return;
  const prev = state.selectedId;
  state.selectedId = id;
  if (prev && prev !== id) refreshMarkerIcon(prev);
  refreshMarkerIcon(id);
  showDetail(p);
  if (from === 'list' || from === 'form') focusPlace(p);
}

function showDetail(p) {
  if (els.detailView.hidden) listScroll = els.panel.scrollTop;
  els.detailView.innerHTML = detailHtml(p);
  els.listView.hidden = true;
  els.detailView.hidden = false;
  els.panel.scrollTop = 0;
}

function closeDetail() {
  const prev = state.selectedId;
  state.selectedId = null;
  if (prev) refreshMarkerIcon(prev);
  if (!els.detailView.hidden) {
    els.detailView.hidden = true;
    els.detailView.innerHTML = '';
    els.listView.hidden = false;
    els.panel.scrollTop = listScroll;
  }
}

function costHtml(amount, note) {
  const parts = [];
  if (amount !== null) parts.push(amount === 0 ? '<strong>무료</strong>' : `<strong>${yen(amount)}</strong> <span class="dim">${won(amount)}</span>`);
  if (note) parts.push(esc(note));
  return parts.join('<br>');
}

function detailHtml(p) {
  const cat = catOf(p);
  const visited = p.status === 'visited';

  const wishRows = [];
  if (p.priority) wishRows.push(['기대도', `${hearts(p.priority)} <span class="dim">${PRIORITY_LABELS[p.priority]}</span>`]);
  if (p.reason) wishRows.push([visited ? '기대했던 이유' : '가고 싶은 이유', esc(p.reason)]);
  if (p.cost !== null || p.costNote) wishRows.push(['예상 비용', costHtml(p.cost, p.costNote)]);
  if (p.access) wishRows.push(['가는 방법', esc(p.access)]);
  if (p.notes) wishRows.push(['메모', esc(p.notes)]);
  const kv = rows => `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  let visitedCard = '';
  if (visited) {
    const rows = [];
    if (p.actualCost !== null) rows.push(['실제 비용', costHtml(p.actualCost, '')]);
    if (p.revisit) rows.push(['재방문', esc(REVISIT[p.revisit])]);
    if (p.tips) rows.push(['다음 팁', esc(p.tips)]);
    const hasAny = p.rating || p.visitedDate || p.oneLine || p.review || rows.length;
    visitedCard = `<section class="card visited-card">
      <h3>다녀온 기록</h3>
      ${hasAny ? `
        ${p.rating || p.visitedDate ? `<div class="review-head">${stars(p.rating)}${p.rating ? `<span>${RATING_LABELS[p.rating]}</span>` : ''}${p.visitedDate ? `<span>${fmtDate(p.visitedDate)} 방문</span>` : ''}</div>` : ''}
        ${p.oneLine ? `<p class="quote">${esc(p.oneLine)}</p>` : ''}
        ${p.review ? `<p class="prose">${esc(p.review)}</p>` : ''}
        ${rows.length ? kv(rows) : ''}`
        : '<p class="nudge">아직 후기가 없어요. ‘수정’을 눌러 어땠는지 남겨 보세요.</p>'}
    </section>`;
  }

  let wishCard = '';
  if (wishRows.length) {
    wishCard = `<section class="card"><h3>${visited ? '가기 전에 기대했던 것' : '가기 전 메모'}</h3>${kv(wishRows)}</section>`;
  } else if (!visited) {
    wishCard = '<section class="card"><h3>가기 전 메모</h3><p class="nudge">‘수정’을 눌러 왜 가고 싶은지, 비용은 얼마인지, 어떻게 가는지 적어 보세요.</p></section>';
  }

  const placeRows = [];
  if (p.address) placeRows.push(['주소', esc(p.address)]);
  placeRows.push(['좌표', hasLoc(p) ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '<span class="no-loc">위치 없음 — ‘수정’에서 정할 수 있어요</span>']);

  return `<div class="detail">
    <button type="button" class="back" data-act="back">← 목록으로</button>
    <div class="detail-hero">
      <div class="cat-badge lg ${p.status}" aria-hidden="true">${cat.icon}</div>
      <div>
        <div class="detail-tags">
          <span class="status-pill ${p.status}">${visited ? '다녀온 곳' : '가고 싶은 곳'}</span>
          <span class="tag">${esc(cat.label)}</span>
          ${p.region ? `<span class="tag">${esc(p.region)}</span>` : ''}
        </div>
        <h2>${esc(p.name)}</h2>
      </div>
    </div>
    <div class="detail-links">
      <a class="btn small" href="${esc(gmapsUrl(p))}" target="_blank" rel="noopener">구글 지도에서 열기 ↗</a>
      <a class="btn small" href="${esc(directionsUrl(p))}" target="_blank" rel="noopener">길찾기 ↗</a>
      ${hasLoc(p) ? '<button type="button" class="btn small" data-act="map">지도에서 보기</button>' : ''}
    </div>
    ${visitedCard}
    ${wishCard}
    <section class="card"><h3>위치</h3>${kv(placeRows)}</section>
    <div class="detail-actions">
      ${visited ? '' : '<button type="button" class="btn visited" data-act="visit">✓ 다녀왔어요!</button>'}
      <button type="button" class="btn" data-act="edit">수정</button>
      <button type="button" class="btn ghost danger" data-act="delete">삭제</button>
    </div>
    <p class="detail-foot">추가 ${fmtIsoDate(p.createdAt)}${p.updatedAt && p.updatedAt !== p.createdAt ? ` · 마지막 수정 ${fmtIsoDate(p.updatedAt)}` : ''}</p>
  </div>`;
}

function deletePlace(id) {
  state.places = state.places.filter(p => p.id !== id);
  state.deleted[id] = new Date().toISOString();
  savePlaces();
  map.closePopup();
  closeDetail();
  renderAll();
  toast('삭제했어요');
}

/* ---------- 추가·수정 폼 ---------- */
let formDirty = false;
let formSource = null; // 폼을 연 임시 핀(주소를 늦게 찾으면 빈 칸을 채우기 위함)

function buildRating(container) {
  const name = container.dataset.name;
  const sym = container.dataset.symbol;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = name;
  input.value = '0';
  container.append(input);
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = sym;
    b.dataset.value = String(i);
    b.setAttribute('aria-label', `${i}점`);
    b.addEventListener('click', () => {
      setRating(name, Number(input.value) === i ? 0 : i);
      formDirty = true;
    });
    container.append(b);
  }
  const label = document.createElement('span');
  label.className = 'rating-label';
  container.append(label);
}

function setRating(name, value) {
  const c = els.form.querySelector(`.rating[data-name="${name}"]`);
  c.querySelector('input').value = String(value);
  c.querySelectorAll('button').forEach(b => {
    const on = Number(b.dataset.value) <= value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const labels = name === 'priority' ? PRIORITY_LABELS : RATING_LABELS;
  c.querySelector('.rating-label').textContent = labels[value] || '';
}

function setGurlHint(text = '구글 지도 주소창의 링크를 붙여넣으면 위치가 자동으로 잡혀요', kind = '') {
  els.gurlHint.textContent = text;
  els.gurlHint.className = 'hint' + (kind ? ' ' + kind : '');
}

function updateLocText() {
  const l = state.formLoc;
  els.locText.innerHTML = l
    ? `<span class="loc-on">📍 ${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</span>`
    : '<span class="loc-off">아직 위치가 없어요</span>';
  els.btnClearLoc.hidden = !l;
}

function updateFormSections() {
  const visited = els.form.elements.status.value === 'visited';
  els.form.dataset.status = visited ? 'visited' : 'wish';
  els.visitedSection.hidden = !visited;
  els.wishDetails.open = !visited;
}

function fillEmptyFields(values) {
  const f = els.form.elements;
  for (const [k, v] of Object.entries(values)) {
    if (v && f[k] && !f[k].value.trim()) f[k].value = v;
  }
}

function openForm(place, overrides = {}, { source = null } = {}) {
  const f = els.form;
  if (state.picking) stopPicking();
  if (els.dialog.open) els.dialog.close();
  f.reset();
  const d = { ...(place || { status: tabStatus(), category: 'sight' }), ...overrides };
  f.dataset.id = place ? place.id : '';
  els.formTitle.textContent = !place ? '새 장소 추가'
    : (place.status === 'wish' && d.status === 'visited' ? '다녀온 기록 남기기' : '장소 수정');

  for (const name of TEXT_FIELDS) {
    const el = f.elements[name];
    if (el) el.value = d[name] ?? '';
  }
  if (!CAT[f.elements.category.value]) f.elements.category.value = 'sight';
  f.elements.status.value = d.status === 'visited' ? 'visited' : 'wish';
  f.elements.name.classList.remove('invalid');
  setRating('priority', d.priority || 0);
  setRating('rating', d.rating || 0);
  state.formLoc = hasLoc(d) ? { lat: d.lat, lng: d.lng } : null;
  updateLocText();
  setGurlHint();
  els.geoResults.hidden = true;
  updateFormSections();
  formDirty = false;
  formSource = source;

  els.dialog.showModal();
  els.dialog.querySelector('.sheet-body').scrollTop = 0;
  if (!d.name) f.elements.name.focus();
  else if (place && place.status === 'wish' && d.status === 'visited') f.elements.oneLine.focus();
  else f.elements.name.focus();
}

function requestClose(dlg) {
  if (dlg === els.dialog && formDirty && !confirm('작성 중인 내용이 저장되지 않았어요. 닫을까요?')) return;
  dlg.close();
}

// 위치를 새로 정하면 주소·지역은 새 위치 기준으로 바꾸고, 이름은 비어 있을 때만 채움
function applyLocInfo({ name, address, region }) {
  const f = els.form.elements;
  if (address) f.address.value = address;
  if (region) f.region.value = region;
  fillEmptyFields({ name });
}

async function fillAddressFromLoc() {
  const loc = state.formLoc;
  if (!loc) return;
  try {
    const r = await reverseGeocode(loc.lat, loc.lng);
    if (state.formLoc === loc) applyLocInfo(r);
  } catch { /* 주소는 직접 입력해도 됨 */ }
}

function setFormLoc(lat, lng, info) {
  state.formLoc = { lat, lng };
  formDirty = true;
  updateLocText();
  if (info) applyLocInfo(info);
  else fillAddressFromLoc();
}

function handleFormGoogleUrl() {
  const input = els.form.elements.googleUrl;
  const v = input.value.trim();
  if (!v) { setGurlHint(); return; }
  const g = parseGoogleMaps(v);
  if (!g) { setGurlHint('구글 지도 링크가 아닌 것 같아요. 그래도 저장은 돼요.', 'warn'); return; }
  if (g.url !== v) input.value = g.url;
  fillEmptyFields({ name: g.name || g.nameHint });
  if (hasLoc(g)) {
    setFormLoc(g.lat, g.lng);
    setGurlHint('링크에서 위치를 가져왔어요 ✓', 'ok');
  } else if (g.short) {
    setGurlHint('짧은 링크는 위치를 바로 읽을 수 없어요. 링크는 저장되니 ‘이름으로 찾기’나 ‘지도에서 찍기’로 위치를 정해 주세요.', 'warn');
  } else {
    setGurlHint('링크에 위치 정보가 없어요. ‘이름으로 찾기’로 위치를 정해 주세요.', 'warn');
  }
}

async function formGeocode() {
  const q = els.form.elements.name.value.trim();
  if (!q) { els.form.elements.name.focus(); setGurlHint(); toast('먼저 장소 이름을 입력해 주세요'); return; }
  const btn = els.btnGeocode;
  btn.disabled = true;
  btn.textContent = '찾는 중…';
  const ul = els.geoResults;
  ul.innerHTML = '';
  try {
    const list = await searchPlaces(q);
    if (!list.length) {
      ul.innerHTML = '<li class="result-note">찾지 못했어요. 일본어나 영어 이름으로 바꿔 보거나 ‘지도에서 찍기’를 써 보세요.</li>';
    }
    for (const r of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'result';
      b.innerHTML = `<strong>${esc(r.name || '이름 없는 장소')}</strong><span>${esc(r.address)}</span>`;
      b.addEventListener('click', () => {
        setFormLoc(r.lat, r.lng, { address: r.address, region: r.region });
        ul.hidden = true;
      });
      li.append(b);
      ul.append(li);
    }
  } catch {
    ul.innerHTML = '<li class="result-note">검색 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.</li>';
  } finally {
    ul.hidden = false;
    btn.disabled = false;
    btn.textContent = '이름으로 찾기';
  }
}

function startPick() {
  state.picking = true;
  els.dialog.close();
  map.closePopup();
  hideResults();
  els.pickBanner.hidden = false;
  els.mapWrap.classList.add('picking');
  setView('map');
}

function stopPicking() {
  state.picking = false;
  els.pickBanner.hidden = true;
  els.mapWrap.classList.remove('picking');
}

function endPick(latlng) {
  if (!state.picking) return;
  stopPicking();
  if (latlng) setFormLoc(latlng.lat, latlng.lng);
  if (!els.dialog.open) els.dialog.showModal();
}

function submitForm(e) {
  e.preventDefault();
  const f = els.form;
  const name = f.elements.name.value.trim();
  if (!name) {
    f.elements.name.classList.add('invalid');
    f.elements.name.focus();
    toast('장소 이름을 입력해 주세요');
    return;
  }
  const fields = Object.fromEntries(new FormData(f).entries());
  const existing = f.dataset.id ? getPlace(f.dataset.id) : null;
  const now = new Date().toISOString();
  const place = normalizePlace({
    ...(existing || {}),
    ...fields,
    id: existing ? existing.id : uid(),
    name,
    region: regionFromText(fields.region),
    lat: state.formLoc ? state.formLoc.lat : null,
    lng: state.formLoc ? state.formLoc.lng : null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  });

  if (existing) state.places[state.places.indexOf(existing)] = place;
  else state.places.push(place);
  savePlaces();

  formDirty = false;
  formSource = null;
  els.dialog.close();
  clearPending();

  if (state.tab !== 'all' && state.tab !== place.status) setTab(place.status, { fit: false });
  else renderAll();
  selectPlace(place.id, { from: 'form' });

  if (!existing) toast(place.status === 'visited' ? '다녀온 곳에 저장했어요' : '가고 싶은 곳에 저장했어요');
  else if (existing.status === 'wish' && place.status === 'visited') toast('다녀온 곳으로 옮겼어요 🎉');
  else toast('수정했어요');
}

/* ---------- 모바일 화면 전환 ---------- */
function setView(view) {
  els.layout.dataset.view = view;
  els.mobileButtons.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'map') {
    map.invalidateSize();
    if (state.needsFit) fitToVisible({ animate: false });
  }
}

/* ---------- 토스트 ---------- */
let toastTimer = null;
function toast(msg) {
  const t = els.toast;
  t.textContent = msg;
  t.classList.add('show');
  try {
    if (t.showPopover) {
      if (t.matches(':popover-open')) t.hidePopover();
      t.showPopover(); // 열린 대화상자 위에도 보이도록
    }
  } catch { /* popover 미지원 브라우저 */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    try { if (t.hidePopover && t.matches(':popover-open')) t.hidePopover(); } catch { /* 무시 */ }
  }, 2800);
}

/* ---------- 백업 ---------- */
function exportData() {
  const payload = { app: 'japan-travel-notes', version: 1, exportedAt: new Date().toISOString(), places: state.places };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `일본여행기록-${today()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${state.places.length}곳을 파일로 내보냈어요`);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data && data.places;
    if (!Array.isArray(list)) throw new Error('format');
    const incoming = list.map(normalizePlace).filter(Boolean);
    const byId = new Map(state.places.map(p => [p.id, p]));
    const now = new Date().toISOString();
    const sameContent = (a, b) => placeKey({ ...a, createdAt: '', updatedAt: '' }) === placeKey({ ...b, createdAt: '', updatedAt: '' });
    let added = 0;
    let updated = 0;
    for (const p of incoming) {
      const cur = byId.get(p.id);
      if (cur && sameContent(cur, p)) continue;
      if (cur) updated++; else added++;
      // 가져온 내용이 동기화 때도 이기도록 지금 수정한 것으로 표시 (지웠던 장소도 다시 살림)
      byId.set(p.id, { ...p, updatedAt: now });
      delete state.deleted[p.id];
    }
    state.places = [...byId.values()];
    savePlaces();
    closeDetail();
    renderAll();
    fitToVisible();
    els.settingsDialog.close();
    const same = incoming.length - added - updated;
    toast(`${added}곳 추가, ${updated}곳 업데이트했어요${same ? ` · ${same}곳은 이미 같아요` : ''}`);
  } catch {
    toast('파일을 읽지 못했어요. 이 사이트에서 내보낸 .json 파일인지 확인해 주세요.');
  }
}

/* ---------- 기기 간 동기화 (GitHub Gist) ---------- */
// 기록 전체를 내 GitHub 계정의 비공개 Gist 파일 하나에 보관함.
// 동기화할 때마다 받아와서 장소별로 더 나중에 고친 쪽을 남기고(지운 기록 포함) 바뀐 게 있으면 다시 올림.
const GITHUB_API = 'https://api.github.com';
const GIST_FILE = 'japan-travel-places.json';
const GIST_DESC = '일본 여행 기록장 — 자동 동기화 데이터 (지우지 마세요)';
const SYNC_DELAY = 1500;           // 고친 뒤 올리기까지 기다리는 시간
const SYNC_INTERVAL = 3 * 60000;   // 화면을 켜 둔 동안 다른 기기 변경을 확인하는 간격

const SYNC_MESSAGES = {
  auth: '토큰이 만료됐거나 취소됐어요. 새 토큰을 만들어 다시 연결해 주세요.',
  scope: '이 토큰에는 gist 권한이 없어요. 토큰을 만들 때 gist에 체크해 주세요.',
  limit: 'GitHub이 잠시 요청을 막았어요. 몇 분 뒤 자동으로 다시 시도해요.',
  badfile: 'GitHub에 저장된 기록 파일을 읽지 못했어요. Gist의 파일 내용을 확인해 주세요.',
  server: 'GitHub에 연결하지 못했어요. 잠시 뒤 자동으로 다시 시도해요.',
  offline: '인터넷에 연결되면 자동으로 맞춰요. 그동안 기록은 이 기기에 저장돼요.',
};

class SyncError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function loadSyncConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    return c && typeof c.token === 'string' && c.token && typeof c.gistId === 'string' && c.gistId ? c : null;
  } catch {
    return null;
  }
}

const sync = {
  cfg: loadSyncConfig(), // { token, gistId, login, lastSyncAt }
  state: 'off',          // off · syncing · ok · offline · error
  message: '',
  running: false,
  again: false,
  timer: null,
  lastTry: 0,
  lastToast: '',
};

function saveSyncConfig() {
  try {
    if (sync.cfg) localStorage.setItem(SYNC_KEY, JSON.stringify(sync.cfg));
    else localStorage.removeItem(SYNC_KEY);
  } catch { /* 무시 */ }
}

async function github(path, token, { method = 'GET', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    let res;
    try {
      res = await fetch(GITHUB_API + path, {
        method,
        cache: 'no-store',
        signal: ctrl.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('offline');
    }
    if (res.status === 401) throw new SyncError('auth', 401);
    if (res.status === 403 || res.status === 429) throw new SyncError('limit', res.status);
    if (res.status === 404) throw new SyncError('notfound', 404);
    if (!res.ok) throw new SyncError('server', res.status);
    return { data: await res.json(), headers: res.headers };
  } catch (e) {
    throw e instanceof SyncError ? e : new SyncError('offline');
  } finally {
    clearTimeout(timer);
  }
}

function gistFiles(data) {
  const payload = { app: 'japan-travel-notes', version: 1, updatedAt: new Date().toISOString(), places: data.places, deleted: data.deleted };
  return { [GIST_FILE]: { content: JSON.stringify(payload, null, 2) } };
}

async function findGist(token) {
  let best = null;
  for (let page = 1; page <= 10; page++) {
    const { data } = await github(`/gists?per_page=100&page=${page}`, token);
    if (!Array.isArray(data)) break;
    for (const g of data) {
      if (g.files && g.files[GIST_FILE] && (!best || g.updated_at > best.updated_at)) best = g;
    }
    if (data.length < 100) break;
  }
  return best ? best.id : null;
}

async function createGist(token, data) {
  const { data: g } = await github('/gists', token, {
    method: 'POST',
    body: { description: GIST_DESC, public: false, files: gistFiles(data) },
  });
  return g.id;
}

async function readGist(token, id) {
  const { data } = await github('/gists/' + id, token);
  const file = data.files && data.files[GIST_FILE];
  if (!file) return { places: [], deleted: {} };
  let text = file.content || '';
  if (file.truncated && file.raw_url) {
    try {
      const res = await fetch(file.raw_url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      text = await res.text();
    } catch {
      throw new SyncError('offline');
    }
  }
  let raw;
  try { raw = JSON.parse(text); } catch { throw new SyncError('badfile'); }
  const list = Array.isArray(raw) ? raw : raw && raw.places;
  if (!Array.isArray(list)) throw new SyncError('badfile');
  return { places: list.map(normalizePlace).filter(Boolean), deleted: cleanDeleted(raw.deleted) };
}

function writeGist(token, id, data) {
  return github('/gists/' + id, token, { method: 'PATCH', body: { files: gistFiles(data) } });
}

/* 합치기: 장소마다 더 나중에 고친 쪽, 지운 시각이 더 나중이면 지운 쪽 */
const placeKey = p => JSON.stringify(p);
function newerOf(a, b) {
  const ta = a.updatedAt || '';
  const tb = b.updatedAt || '';
  if (ta !== tb) return ta > tb ? a : b;
  return placeKey(a) >= placeKey(b) ? a : b; // 시각이 같으면 어느 기기에서나 같은 쪽을 고름
}
function mergeData(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, at] of Object.entries(b.deleted)) if (!deleted[id] || at > deleted[id]) deleted[id] = at;
  const byId = new Map();
  for (const p of [...a.places, ...b.places]) {
    const cur = byId.get(p.id);
    byId.set(p.id, cur ? newerOf(cur, p) : p);
  }
  const places = [];
  for (const p of byId.values()) {
    if (deleted[p.id] && deleted[p.id] >= (p.updatedAt || '')) continue;
    delete deleted[p.id]; // 지운 뒤 다시 가져온 장소
    places.push(p);
  }
  return { places, deleted };
}
function dataKey(d) {
  const places = [...d.places].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return JSON.stringify([places, Object.keys(d.deleted).sort().map(k => [k, d.deleted[k]])]);
}

function applyMerged(before, merged) {
  const old = new Map(before.places.map(p => [p.id, p]));
  let changed = 0;
  for (const p of merged.places) {
    const o = old.get(p.id);
    if (!o || o.updatedAt !== p.updatedAt) changed++;
    old.delete(p.id);
  }
  changed += old.size; // 다른 기기에서 지운 장소
  state.places = merged.places;
  state.deleted = merged.deleted;
  storeLocal();
  if (changed) {
    renderAll();
    if (!before.places.length) fitToVisible(); // 새 기기에서 처음 받아왔을 때
    toast(`다른 기기에서 바뀐 ${changed}곳을 받아왔어요`);
  }
}

function setSyncState(s, message = '') {
  sync.state = s;
  sync.message = message;
  renderSyncStatus();
}

function scheduleSync() {
  if (!sync.cfg) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow(), SYNC_DELAY);
  if (sync.state !== 'offline') setSyncState('syncing');
}

async function syncNow() {
  const cfg = sync.cfg;
  if (!cfg) return;
  clearTimeout(sync.timer);
  sync.timer = null;
  if (sync.running) { sync.again = true; return; }
  sync.lastTry = Date.now();
  if (navigator.onLine === false) { setSyncState('offline', SYNC_MESSAGES.offline); return; }
  sync.running = true;
  setSyncState('syncing');
  try {
    let remote;
    try {
      remote = await readGist(cfg.token, cfg.gistId);
    } catch (e) {
      if (e.code !== 'notfound') throw e;
      // GitHub에서 Gist를 지웠으면 다른 동기화 Gist를 찾고, 없으면 이 기기 기록으로 새로 만듦
      const found = await findGist(cfg.token);
      if (found) {
        cfg.gistId = found;
        remote = await readGist(cfg.token, found);
      } else {
        cfg.gistId = await createGist(cfg.token, state);
        remote = { places: state.places, deleted: state.deleted };
      }
    }
    if (sync.cfg !== cfg) return; // 그사이 연결을 끊음
    // 받아온 직후의 기록으로 합쳐야 기다리는 동안 고친 내용이 사라지지 않음
    const local = { places: state.places, deleted: state.deleted };
    const merged = mergeData(local, remote);
    const key = dataKey(merged);
    if (key !== dataKey(local)) applyMerged(local, merged);
    if (key !== dataKey(remote)) await writeGist(cfg.token, cfg.gistId, merged);
    if (sync.cfg !== cfg) return;
    cfg.lastSyncAt = new Date().toISOString();
    saveSyncConfig();
    sync.lastToast = '';
    setSyncState('ok');
  } catch (e) {
    if (sync.cfg !== cfg) return;
    const code = SYNC_MESSAGES[e.code] ? e.code : 'server';
    setSyncState(code === 'offline' ? 'offline' : 'error', SYNC_MESSAGES[code]);
    if (code !== 'offline' && sync.lastToast !== code) {
      sync.lastToast = code;
      toast('동기화하지 못했어요. 백업·설정에서 확인해 주세요.');
    }
  } finally {
    sync.running = false;
    if (sync.again) {
      sync.again = false;
      if (sync.cfg) syncNow();
    }
  }
}

async function connectSync(rawToken) {
  const token = rawToken.trim();
  const hint = msg => { els.syncHint.textContent = msg; els.syncHint.hidden = !msg; };
  hint('');
  if (!token) { hint('GitHub에서 만든 토큰을 붙여넣어 주세요.'); els.syncToken.focus(); return; }
  els.syncConnect.disabled = true;
  els.syncConnect.textContent = '연결 중…';
  try {
    const { data: user, headers } = await github('/user', token);
    const scopes = headers.get('X-OAuth-Scopes');
    if (scopes !== null && !scopes.split(',').map(s => s.trim()).includes('gist')) throw new SyncError('scope');
    let gistId = await findGist(token);
    const created = !gistId;
    if (created) gistId = await createGist(token, state);
    sync.cfg = { token, gistId, login: user.login || '', lastSyncAt: created ? new Date().toISOString() : '' };
    saveSyncConfig();
    els.syncToken.value = '';
    if (created) setSyncState('ok'); else await syncNow();
    if (sync.state === 'ok') {
      toast(created
        ? `동기화를 켰어요 · 이 기기의 ${state.places.length}곳을 GitHub에 올렸어요`
        : `동기화를 켰어요 · 지금 기록 ${state.places.length}곳`);
    }
  } catch (e) {
    hint(e.code === 'auth' ? '토큰이 맞지 않아요. 복사한 토큰 전체를 다시 붙여넣어 주세요.'
      : e.code === 'offline' ? '인터넷 연결을 확인하고 다시 눌러 주세요.'
        : SYNC_MESSAGES[e.code] || SYNC_MESSAGES.server);
  } finally {
    els.syncConnect.disabled = false;
    els.syncConnect.textContent = '연결';
  }
}

function disconnectSync() {
  if (!confirm('이 기기에서 동기화를 끌까요?\n기록은 이 기기와 GitHub에 그대로 남아요.')) return;
  clearTimeout(sync.timer);
  sync.cfg = null;
  saveSyncConfig();
  setSyncState('off');
  toast('이 기기의 동기화를 껐어요');
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function renderSyncStatus() {
  const s = sync.cfg ? sync.state : 'off';
  const last = sync.cfg && sync.cfg.lastSyncAt;
  const label = {
    off: '이 기기에만 저장',
    syncing: '동기화 중…',
    ok: last ? `동기화됨 · ${relTime(last)}` : '동기화됨',
    offline: '오프라인 · 기기에 저장됨',
    error: '동기화 오류',
  }[s];
  els.syncText.textContent = label;
  els.syncPill.title = s === 'off' ? '백업·설정에서 기기 간 동기화를 켤 수 있어요' : (sync.message || label);
  els.btnSettings.setAttribute('aria-label', `백업·설정 (${label})`);
  els.syncDots.forEach(d => { d.dataset.state = s; });

  els.syncOff.hidden = !!sync.cfg;
  els.syncOn.hidden = !sync.cfg;
  if (!sync.cfg) return;
  els.syncTitle.textContent = sync.cfg.login ? `@${sync.cfg.login} 계정과 동기화 중` : 'GitHub와 동기화 중';
  els.syncDetail.textContent = s === 'syncing' ? '맞추는 중…'
    : (s === 'offline' || s === 'error') ? sync.message
      : last ? `마지막 동기화 ${relTime(last)} · 기록 ${state.places.length}곳` : '';
  els.syncDetail.className = s === 'error' ? 'warn' : '';
  els.syncGistLink.href = `https://gist.github.com/${sync.cfg.login ? sync.cfg.login + '/' : ''}${sync.cfg.gistId}`;
  els.syncNowBtn.disabled = s === 'syncing';
}

/* ---------- 이벤트 연결 ---------- */
function init() {
  // 고정 UI 채우기
  els.sort.innerHTML = Object.entries(SORTS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('');
  els.sort.value = state.sort;
  els.form.elements.category.innerHTML = CATEGORIES.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');
  els.form.elements.revisit.innerHTML = '<option value="">선택 안 함</option>' +
    Object.entries(REVISIT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('#region-list').innerHTML = PREFECTURES.map(([, ko]) => `<option value="${ko}"></option>`).join('');
  document.querySelectorAll('.rating').forEach(buildRating);
  renderCategoryChips();

  // 목록 탭·필터
  els.tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  els.filterText.addEventListener('input', () => { state.query = els.filterText.value; renderList(); renderMarkers(); });
  els.filterRegion.addEventListener('change', () => { state.region = els.filterRegion.value; renderList(); renderMarkers(); fitToVisible(); });
  els.sort.addEventListener('change', () => { state.sort = els.sort.value; renderList(); });
  els.cats.addEventListener('click', e => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = state.category === chip.dataset.cat ? '' : chip.dataset.cat;
    renderCategoryChips();
    renderList();
    renderMarkers();
  });
  els.list.addEventListener('click', e => {
    const b = e.target.closest('[data-id]');
    if (b) selectPlace(b.dataset.id, { from: 'list' });
  });
  els.empty.addEventListener('click', e => { if (e.target.closest('[data-act="reset-filters"]')) resetFilters(); });
  $('#btn-add-manual').addEventListener('click', () => openForm(null, { status: tabStatus() }));

  // 상세 보기 버튼
  els.detailView.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    const p = getPlace(state.selectedId);
    if (!btn || !p) return;
    switch (btn.dataset.act) {
      case 'back': closeDetail(); map.closePopup(); break;
      case 'edit': openForm(p); break;
      case 'visit': openForm(p, { status: 'visited', visitedDate: p.visitedDate || today() }); break;
      case 'map': setView('map'); focusPlace(p); break;
      case 'delete':
        if (confirm(`‘${p.name}’ 장소를 삭제할까요?\n삭제하면 되돌릴 수 없어요.`)) deletePlace(p.id);
        break;
    }
  });

  // 폼
  els.form.addEventListener('submit', submitForm);
  els.form.addEventListener('input', e => {
    formDirty = true;
    if (e.target.name === 'name') e.target.classList.remove('invalid');
  });
  els.form.addEventListener('change', e => { if (e.target.name === 'status') updateFormSections(); });
  els.form.elements.googleUrl.addEventListener('change', handleFormGoogleUrl);
  els.form.elements.googleUrl.addEventListener('paste', () => setTimeout(handleFormGoogleUrl, 0));
  els.btnPick.addEventListener('click', startPick);
  els.btnGeocode.addEventListener('click', formGeocode);
  els.btnClearLoc.addEventListener('click', () => { state.formLoc = null; formDirty = true; updateLocText(); });
  $('#btn-pick-cancel').addEventListener('click', () => endPick(null));

  // 대화상자 공통: 닫기 버튼, Esc, 바깥 클릭
  document.addEventListener('click', e => {
    const c = e.target.closest('[data-close]');
    if (c) requestClose(c.closest('dialog'));
  });
  for (const dlg of [els.dialog, els.settingsDialog, els.helpDialog]) {
    dlg.addEventListener('cancel', e => { e.preventDefault(); requestClose(dlg); });
    if (dlg === els.dialog) continue; // 입력 폼은 바깥 클릭으로 닫지 않음
    let downOnBackdrop = false;
    dlg.addEventListener('pointerdown', e => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', e => { if (downOnBackdrop && e.target === dlg) dlg.close(); });
  }

  // 사용법·설정
  $('#btn-help').addEventListener('click', () => els.helpDialog.showModal());
  document.querySelectorAll('[data-open-help]').forEach(b => b.addEventListener('click', () => els.helpDialog.showModal()));
  const openSettings = () => {
    els.rateInput.value = state.settings.krwPer100;
    renderSyncStatus();
    els.settingsDialog.showModal();
  };
  els.btnSettings.addEventListener('click', openSettings);
  els.rateInput.addEventListener('change', () => {
    const v = toNum(els.rateInput.value);
    if (!v || v <= 0) { els.rateInput.value = state.settings.krwPer100; return; }
    state.settings.krwPer100 = v;
    saveSettings();
    renderAll();
    toast(`100엔 = ${v.toLocaleString('ko-KR')}원으로 바꿨어요`);
  });
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', () => {
    const file = els.importFile.files[0];
    if (file) importData(file);
    els.importFile.value = '';
  });

  // 기기 간 동기화
  els.syncPill.addEventListener('click', openSettings);
  els.syncForm.addEventListener('submit', e => { e.preventDefault(); connectSync(els.syncToken.value); });
  els.syncNowBtn.addEventListener('click', () => syncNow());
  $('#btn-sync-off').addEventListener('click', disconnectSync);
  document.addEventListener('visibilitychange', () => {
    if (!sync.cfg) return;
    if (document.visibilityState === 'hidden') { if (sync.timer) syncNow(); } // 앱을 떠나기 전에 바로 올림
    else if (Date.now() - sync.lastTry > 20000) syncNow();
  });
  window.addEventListener('online', () => syncNow());
  window.addEventListener('offline', () => { if (sync.cfg) setSyncState('offline', SYNC_MESSAGES.offline); });
  setInterval(() => {
    renderSyncStatus(); // '3분 전' 같은 표시 갱신
    if (sync.cfg && document.visibilityState === 'visible' && Date.now() - sync.lastTry > SYNC_INTERVAL) syncNow();
  }, 30000);
  // 같은 기기의 다른 탭에서 바꾼 내용 반영
  window.addEventListener('storage', e => {
    if (e.key === STORE_KEY || e.key === DELETED_KEY) {
      state.places = loadPlaces();
      state.deleted = loadDeleted();
      renderAll();
    } else if (e.key === SYNC_KEY) {
      const c = loadSyncConfig();
      if (c && sync.cfg && c.token === sync.cfg.token && c.gistId === sync.cfg.gistId) {
        sync.cfg.lastSyncAt = c.lastSyncAt;
        renderSyncStatus();
      } else {
        sync.cfg = c;
        setSyncState(c ? 'ok' : 'off');
      }
    }
  });

  // 모바일 목록/지도 전환
  els.mobileButtons.forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  // Esc로 위치 찍기 취소
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.picking) endPick(null); });

  renderAll();
  fitToVisible({ animate: false });
  renderSyncStatus();
  if (sync.cfg) syncNow();
}

init();
