(() => {
  'use strict';
  const STORAGE_KEY = 'my-fresh-bag-inventory-v1';
  const HISTORY_KEY = 'my-fresh-bag-history-v1';
  const FAVORITES_KEY = 'my-fresh-bag-favorites-v1';
  const $ = (selector) => document.querySelector(selector);
  const grid = $('#inventory-grid');
  const itemDialog = $('#item-dialog');
  const quantityDialog = $('#quantity-dialog');
  const backupDialog = $('#backup-dialog');
  const reviewDialog = $('#review-dialog');
  const barcodeDialog = $('#barcode-dialog');
  const form = $('#item-form');
  const InventoryData = globalThis.MyFreshBagData;
  let items = loadItems();
  let activeFilter = '냉장';
  let searchTerm = '';
  let toastTimer;
  let scanImageDataUrl = '';
  let scanImagePreviewUrl = '';
  let scanDraft = [];
  let scanNonFood = [];
  let barcodeStream = null;
  let barcodeDetector = null;
  let barcodeScanActive = false;
  let barcodeProductDraft = null;
  let historyDraft = null;
  let history = loadJson(HISTORY_KEY);
  let favorites = loadJson(FAVORITES_KEY);

  const icons = { 채소: '🥬', 과일: '🍎', 유제품: '🥛', 육류: '🥩', 해산물: '🐟', 간편식: '🍱', '곡류·면': '🍜', 간식: '🍪', 음료: '🧃', 조미료: '🧂', 기타: '🛍️' };
  const tones = { 채소: 'green', 과일: 'pink', 유제품: 'blue', 육류: 'pink', 해산물: 'blue', 간편식: 'yellow', '곡류·면': 'yellow', 간식: 'orange', 음료: 'purple', 조미료: 'green', 기타: 'green' };
  const locations = { 냉장: '❄️ 냉장', 냉동: '🧊 냉동', 상온: '🧺 상온' };

  function loadItems() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(isValidItem).map(InventoryData.normalizeItem) : [];
    } catch { return []; }
  }

  function isValidItem(item) {
    return InventoryData.isValidItem(item);
  }

  function saveItems() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); return true; }
    catch { showToast('저장 공간이 부족해요. 백업 후 항목을 정리해 주세요.'); return false; }
  }

  function loadJson(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
  }
  function saveJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
  function historyShape(item) { return { name: item.name, brand: item.brand || '', packageQuantity: item.packageQuantity || '', productType: item.productType || '', category: item.category, location: item.location, unit: item.unit, productImageUrl: item.productImageUrl || '', photo: item.photo || '', barcode: item.barcode || '', nutrition: item.nutrition || null, savedAt: new Date().toISOString() }; }
  function addHistory(item) { const record = historyShape(item); history = [record, ...history.filter((entry) => `${entry.name}|${entry.brand}|${entry.packageQuantity}` !== `${record.name}|${record.brand}|${record.packageQuantity}`)].slice(0, 10); saveJson(HISTORY_KEY, history); renderQuickAccess(); }
  function toggleFavorite(item) { const key = `${item.name}|${item.brand || ''}|${item.packageQuantity || ''}`; const exists = favorites.some((entry) => entry.key === key); favorites = exists ? favorites.filter((entry) => entry.key !== key) : [{ ...historyShape(item), key, savedAt: new Date().toISOString() }, ...favorites].slice(0, 30); saveJson(FAVORITES_KEY, favorites); renderItems(); renderQuickAccess(); }
  function isFavorite(item) { const key = `${item.name}|${item.brand || ''}|${item.packageQuantity || ''}`; return favorites.some((entry) => entry.key === key); }
  function quickImage(item) { return item.photo || item.productImageUrl || foodImage(item); }
  function renderQuickAccess() {
    const render = (entries, type) => entries.length ? entries.map((entry, index) => `<div class="quick-item"><img src="${escapeHtml(quickImage(entry))}" alt=""><div><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml([entry.brand, entry.packageQuantity].filter(Boolean).join(' · ') || entry.category || '식품')}</small></div><button type="button" data-quick-action="register" data-quick-type="${type}" data-quick-index="${index}">다시 등록</button>${type === 'history' ? `<button class="quick-delete" type="button" data-quick-action="delete-history" data-quick-index="${index}" aria-label="기록 삭제">×</button>` : ''}</div>`).join('') : '<p class="quick-empty">아직 기록이 없어요.</p>';
    $('#favorites-list').innerHTML = render(favorites, 'favorite'); $('#history-list').innerHTML = render(history, 'history');
  }
  function registerFromQuick(entry) { historyDraft = { ...entry }; openNewItem(); $('#item-name').value = entry.name || ''; $('#item-quantity').value = '1'; $('#item-unit').value = entry.unit || '개'; $('#item-category').value = entry.category || '기타'; $('#item-location').value = entry.location || '상온'; $('#item-expiry').value = ''; $('#item-check-date').value = ''; $('#item-opened').checked = false; $('#item-opened-date').value = ''; $('#storage-note').textContent = '새 구매 제품의 날짜는 비워 두었습니다. 포장 라벨을 확인해 주세요.'; }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function getDaysLeft(dateString) {
    if (!dateString) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
    const today = new Date();
    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - todayUtc) / 86400000);
  }

  function dateLabel(item) {
    const calculated = item.expiry && item.expirySource === 'manufacturer-calculated';
    const actual = item.expiry && ['user','label'].includes(item.expirySource);
    const date = actual || calculated ? item.expiry : item.checkDate;
    if (!date) return { text: '날짜 정보 없음', className: '', kind: '' };
    const days = getDaysLeft(date);
    const name = calculated ? '제조일 기준 제안' : actual ? '소비기한' : '재고 확인일';
    if (days === null) return { text: `${name} 확인`, className: '', kind: name };
    if (days < 0) return { text: `${name} ${Math.abs(days)}일 지남`, className: 'urgent', kind: name };
    if (days === 0) return { text: `${name} 오늘`, className: 'urgent', kind: name };
    if (days <= 3) return { text: `${name} D-${days}`, className: 'urgent', kind: name };
    return { text: `${name} D-${days}`, className: 'safe', kind: name };
  }

  function foodImage(item) {
    if (item.photo) return item.photo;
    if (item.productImageUrl && /^https:\/\/images\.openfoodfacts\.org\//.test(item.productImageUrl)) return item.productImageUrl;
    const name = `${item.name} ${item.brand || ''} ${item.productType || ''}`.toLowerCase();
    if (/햇반|즉석.?밥|흰밥|공깃밥|rice/.test(name)) return 'assets/foods/rice.svg';
    if (/참치|튜나|tuna/.test(name)) return 'assets/foods/tuna.svg';
    if (/라면|국수|파스타|면|ramen|noodle/.test(name)) return 'assets/foods/noodles.svg';
    if (/우유|milk/.test(name)) return 'assets/foods/milk.svg';
    if (/계란|달걀|egg/.test(name)) return 'assets/foods/eggs.svg';
    if (/만두|dumpling/.test(name)) return 'assets/foods/dumplings.svg';
    if (/김치|kimchi/.test(name)) return 'assets/foods/kimchi.svg';
    if (/사과|바나나|포도|딸기|오렌지|배|복숭아|과일|apple|banana|fruit/.test(name)) return 'assets/foods/fruit.svg';
    if (/양배추|상추|시금치|브로콜리|오이|당근|채소|야채|vegetable/.test(name)) return 'assets/foods/vegetables.svg';
    if (/닭|치킨|고기|돼지|소고기|육류|chicken/.test(name)) return 'assets/foods/chicken.svg';
    if (/생선|연어|고등어|새우|해산물|fish/.test(name)) return 'assets/foods/fish.svg';
    if (/과자|쿠키|스낵|간식|음료|주스|snack/.test(name)) return 'assets/foods/snack.svg';
    return ({ 채소: 'assets/foods/vegetables.svg', 과일: 'assets/foods/fruit.svg', 유제품: 'assets/foods/milk.svg', 육류: 'assets/foods/chicken.svg', 해산물: 'assets/foods/fish.svg', 간편식: 'assets/foods/rice.svg', '곡류·면': 'assets/foods/noodles.svg', 간식: 'assets/foods/snack.svg', 음료: 'assets/foods/fruit.svg', 조미료: 'assets/foods/vegetables.svg', 기타: 'assets/foods/snack.svg' })[item.category] || 'assets/foods/snack.svg';
  }

  function formatQuantity(quantity) {
    return Number.isInteger(Number(quantity)) ? String(Number(quantity)) : String(Number(Number(quantity).toFixed(2)));
  }

  function updateSummary() {
    const inStock = items.filter((item) => Number(item.quantity) > 0);
    $('#total-count').textContent = inStock.length;
    $('#fridge-count').textContent = inStock.filter((item) => item.location === '냉장').length;
    $('#freezer-count').textContent = inStock.filter((item) => item.location === '냉동').length;
    $('#pantry-count').textContent = inStock.filter((item) => item.location === '상온').length;
    $('#filter-fridge-count').textContent = inStock.filter((item) => item.location === '냉장').length;
    $('#filter-freezer-count').textContent = inStock.filter((item) => item.location === '냉동').length;
    $('#filter-pantry-count').textContent = inStock.filter((item) => item.location === '상온').length;
  }

  function renderItems() {
    updateSummary();
    const filtered = items.filter((item) => item.location === activeFilter && `${item.name} ${item.brand || ''} ${item.category} ${item.memo || ''}`.toLocaleLowerCase('ko').includes(searchTerm.toLocaleLowerCase('ko')));
    $('#visible-count').textContent = filtered.length;
    if (!filtered.length) {
      const searching = Boolean(searchTerm);
      grid.innerHTML = `<div class="empty-state"><div class="empty-art" aria-hidden="true">${searching ? '🔎' : '🥗'}</div><h3>${searching ? '찾는 식품이 없어요' : `${activeFilter} 보관 식품이 없어요`}</h3><p>${searching ? '검색어나 보관 장소를 바꿔서 찾아보세요.' : '이 보관 장소에 식품을 추가해 보세요.'}</p>${!searching ? '<button class="primary-button" type="button" data-action="add">＋ 식품 추가하기</button>' : ''}</div>`;
      return;
    }
    grid.innerHTML = filtered.map((item) => {
      const expiry = dateLabel(item);
      const memo = item.opened ? `<span class="opened-badge">개봉${item.openedAt ? ` · ${escapeHtml(item.openedAt)}` : ''}</span>` : '';
      const note = item.openedGuidance && item.opened ? `<p class="card-storage-note">개봉 후 안내: ${escapeHtml(item.openedGuidance)}</p>` : '';
      const productSource = (item.productSources || []).map((source) => `<p class="card-storage-note"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">정보 출처 · ${escapeHtml(source.name)}</a>${source.queriedAt ? ` · ${escapeHtml(source.queriedAt.slice(0,10))}` : ''}</p>`).join('') || (item.productSource?.url ? `<p class="card-storage-note"><a href="${escapeHtml(item.productSource.url)}" target="_blank" rel="noopener noreferrer">제품 정보 출처 · ${escapeHtml(item.productSource.name || 'Open Food Facts')}</a>${item.productSource.license ? ` · ${escapeHtml(item.productSource.license)}` : ''}</p>` : '');
      const nutrition = item.barcode || item.nutrition ? renderNutrition(item) : '';
      const storageDetails = [item.unopenedStorage && `미개봉: ${item.unopenedStorage}`, item.openedStorage && `개봉 후: ${item.openedStorage}`].filter(Boolean).join(' · ');
      const checkBasis = item.checkDate && item.checkDateBasis ? `<p class="card-storage-note">확인 기준: ${escapeHtml(item.checkDateBasis)}${item.checkDateSourceUrl ? ` · <a href="${escapeHtml(item.checkDateSourceUrl)}" target="_blank" rel="noopener noreferrer">출처</a>` : ''}</p>` : '';
      return `<article class="food-card ${Number(item.quantity) === 0 ? 'out-of-stock' : ''}" data-id="${escapeHtml(item.id)}"><div class="card-photo"><img src="${escapeHtml(foodImage(item))}" alt="${escapeHtml(item.name)} 식품 이미지" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="photo-fallback" hidden>${icons[item.category] || icons.기타}</span><button class="card-menu" type="button" data-action="menu" aria-label="${escapeHtml(item.name)} 관리 메뉴" aria-expanded="false">···</button></div><p class="food-name">${escapeHtml(item.name)}${item.brand ? `<small class="food-brand">${escapeHtml(item.brand)}</small>` : ''}</p>${item.packageQuantity ? `<p class="card-storage-note">${escapeHtml(item.packageQuantity)}</p>` : ''}<div class="food-meta"><span>${escapeHtml(item.category)}</span><span class="meta-dot"></span><span>${locations[item.location]}</span></div><div class="card-divider"></div><div class="card-bottom"><span class="expiry-label ${expiry.className}">${expiry.text}</span><div class="quantity-control" aria-label="${escapeHtml(item.name)} 수량 조절"><button type="button" data-action="decrease" aria-label="${escapeHtml(item.name)} 수량 감소" ${Number(item.quantity) <= 0 ? 'disabled' : ''}>−</button><strong>${formatQuantity(item.quantity)}<small>${escapeHtml(item.unit)}</small></strong><button type="button" data-action="increase" aria-label="${escapeHtml(item.name)} 수량 증가">＋</button></div></div>${Number(item.quantity) === 0 ? '<span class="stock-empty">재고 없음 · +로 다시 추가</span>' : ''}${nutrition}${storageDetails ? `<p class="card-storage-note">${escapeHtml(storageDetails)}</p>` : ''}${memo}${note}${checkBasis}${productSource}<div class="card-actions" hidden><button type="button" data-action="consume" ${Number(item.quantity) <= 0 ? 'disabled' : ''}>수량 차감</button><button type="button" data-action="edit">수정</button><button type="button" data-action="finish">소진 처리</button><button type="button" data-action="delete">삭제</button></div></article>`;
    }).join('');
    grid.querySelectorAll('.food-card').forEach((card) => { const item = byId(card.dataset.id); const photo = card.querySelector('.card-photo'); if (item && photo && !photo.querySelector('.favorite-toggle')) photo.insertAdjacentHTML('beforeend', `<button class="favorite-toggle ${isFavorite(item) ? 'active' : ''}" type="button" data-action="favorite" aria-label="${escapeHtml(item.name)} 즐겨찾기">${isFavorite(item) ? '★' : '☆'}</button>`); });
  }

  function renderNutrition(item) {
    const nutrition = item.nutrition || {};
    const calories = nutrition.caloriesKcal == null ? '열량 미확인' : `${escapeHtml(nutrition.caloriesKcal)} kcal · ${escapeHtml(nutrition.calorieBasis || nutrition.basis || '기준량 미확인')}`;
    const calorieEstimate = InventoryData.estimatePackageCalories(item);
    const packageCalories = calorieEstimate?.perPackage ?? null;
    const totalCalories = calorieEstimate ? Math.round(calorieEstimate.totalOnHand) : null;
    const rows = [['탄수화물', nutrition.carbohydratesG, 'g'], ['당류', nutrition.sugarsG, 'g'], ['단백질', nutrition.proteinG, 'g'], ['지방', nutrition.fatG, 'g'], ['나트륨', nutrition.sodiumMg, 'mg']];
    const sources = [...(item.productSources || []), ...(item.productSource ? [item.productSource] : [])];
    return `<details class="nutrition-details"><summary>${calories}<span>영양정보 상세</span></summary>${packageCalories == null ? '<p>제품 용량과 영양 기준 단위가 함께 확인되지 않아 총 열량은 계산하지 않았어요.</p>' : `<p class="nutrition-total">한 포장 약 ${Math.round(packageCalories)} kcal · 현재 재고 ${totalCalories} kcal</p>`}<div class="nutrition-grid">${rows.map(([label, value, unit]) => `<span>${label}</span><strong>${value == null ? '미확인' : `${escapeHtml(value)} ${unit}`}</strong>`).join('')}<span>열량 기준량</span><strong>${escapeHtml(nutrition.calorieBasis || '미확인')}</strong><span>영양소 기준량</span><strong>${escapeHtml(nutrition.basis || '미확인')}</strong></div>${nutrition.servingSize ? `<p>1회 제공량: ${escapeHtml(nutrition.servingSize)}</p>` : ''}${sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name || '제품 정보 출처')} ↗</a>`).join('')}${item.productSource?.license ? `<small>${escapeHtml(item.productSource.license)}</small>` : ''}<p class="nutrition-note">조회된 제품 정보를 표시합니다. 포장 영양표시를 확인해 주세요.</p></details>`;
  }

  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
  }

  function openNewItem() {
    locationTouched = false;
    const pendingBarcode = barcodeProductDraft?.barcode || '';
    form.reset(); $('#item-id').value = ''; $('#item-quantity').value = '1'; $('#form-title').textContent = '식품 추가하기'; $('#save-item-button').textContent = '식품 추가'; $('#form-error').textContent = '';
    $('#item-expiry').value = ''; $('#item-check-date').value = ''; $('#item-opened').checked = false; $('#opened-date-wrap').hidden = true; $('#storage-note').textContent = '보관은 제품 라벨의 표시사항을 먼저 확인해 주세요.';
    if (pendingBarcode) $('#item-memo').value = `바코드 ${pendingBarcode} · 제품 정보를 찾지 못해 직접 등록`;
    itemDialog.showModal(); $('#item-name').focus();
  }

  function openEditItem(item) {
    locationTouched = true;
    form.reset(); $('#item-id').value = item.id; $('#item-name').value = item.name; $('#item-quantity').value = item.quantity; $('#item-unit').value = item.unit; $('#item-location').value = item.location; $('#item-category').value = item.category; $('#item-expiry').value = item.expiry || ''; $('#item-check-date').value = item.checkDate || ''; $('#item-opened').checked = Boolean(item.opened); $('#item-opened-date').value = item.openedAt || ''; $('#opened-date-wrap').hidden = !item.opened; $('#item-memo').value = item.memo || ''; $('#storage-note').textContent = item.storageEvidence || '보관은 제품 라벨의 표시사항을 먼저 확인해 주세요.';
    $('#form-title').textContent = '식품 수정하기'; $('#save-item-button').textContent = '변경 내용 저장'; $('#form-error').textContent = ''; itemDialog.showModal(); $('#item-name').focus();
  }

  function byId(id) { return items.find((item) => item.id === id); }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const id = $('#item-id').value;
    const name = $('#item-name').value.trim();
    const quantity = Number($('#item-quantity').value);
    if (!name || !Number.isFinite(quantity) || quantity <= 0) { $('#form-error').textContent = '식품 이름과 0보다 큰 수량을 입력해 주세요.'; return; }
    const existing = id ? byId(id) : null;
    const expiry = $('#item-expiry').value;
    const identifiedProduct = barcodeProductDraft?.product ? barcodeProductDraft : null;
    const entry = { ...existing, id: id || (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`), name, brand: identifiedProduct?.product.brand || existing?.brand || '', productType: identifiedProduct?.product.productType || existing?.productType || '', packageQuantity: identifiedProduct?.product.packageQuantity || existing?.packageQuantity || '', barcode: identifiedProduct?.barcode || (barcodeProductDraft?.manual ? barcodeProductDraft.barcode : existing?.barcode || ''), productImageUrl: identifiedProduct?.product.imageUrl || existing?.productImageUrl || '', productSource: identifiedProduct?.source || existing?.productSource || null, nutrition: identifiedProduct?.product.nutrition || existing?.nutrition || null, quantity, unit: $('#item-unit').value, location: $('#item-location').value, category: $('#item-category').value, expiry, expirySource: expiry ? (existing?.expiry === expiry ? existing.expirySource : 'user') : 'none', checkDate: $('#item-check-date').value, checkDateSource: $('#item-check-date').value ? 'user' : '', opened: $('#item-opened').checked, openedAt: $('#item-opened').checked ? $('#item-opened-date').value : '', memo: $('#item-memo').value.trim(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (existing) items = items.map((item) => item.id === id ? entry : item); else mergeOrInsert(entry);
    if (!existing) addHistory(entry);
    saveItems(); itemDialog.close(); renderItems(); barcodeProductDraft = null; historyDraft = null; showToast(existing ? '식품 정보를 수정했어요.' : '식품을 추가했어요.');
  });

  function mergeOrInsert(entry) {
    items = InventoryData.mergeItems(items, entry);
  }

  function suggestStorage(name) {
    const value = name.toLocaleLowerCase('ko');
    if (/멸균|uht|상온.?보관/.test(value)) return { location: null, message: '멸균/UHT 제품은 포장 라벨의 보관방법을 확인해 주세요. 제품에 따라 상온 또는 냉장 보관이 달라요.' };
    if (/냉동|냉동만두|냉동피자|아이스크림/.test(value)) return { location: '냉동', message: '이름에서 냉동 제품으로 확인되어 냉동 보관을 추천해요. 제품 라벨을 우선해 주세요.' };
    if (/햇반|즉석.?밥|참치캔|참치 통조림|통조림|라면|건면|파스타|시리얼/.test(value)) return { location: '상온', message: '제품 종류를 바탕으로 상온 보관을 추천해요. 포장에 냉장 표시가 있으면 라벨을 따라 주세요.' };
    if (/일반.?냉장.?우유|냉장.?우유|우유|계란|달걀|신선.?식품|생고기|생선|김치|요구르트|요거트/.test(value)) return { location: '냉장', message: '일반 냉장 우유·달걀·신선식품을 기준으로 냉장을 추천해요. 멸균/UHT 제품은 라벨을 확인하고, 포장에 표시된 온도 조건이 우선입니다.' };
    return { location: null, message: '제품 라벨의 보관방법을 확인해 보관 장소를 선택해 주세요.' };
  }

  function updateStorageSuggestion() {
    if (locationTouched || $('#item-id').value) return;
    const suggestion = suggestStorage($('#item-name').value);
    if (suggestion.location) $('#item-location').value = suggestion.location;
    $('#storage-note').textContent = suggestion.message;
  }

  function selectPhoto() { $('#photo-input').value = ''; $('#photo-input').click(); }

  function openBarcodeRegistration() {
    barcodeProductDraft = null; $('#barcode-number').value = ''; $('#barcode-error').textContent = ''; $('#barcode-hint').textContent = '카메라를 지원하지 않는 브라우저에서는 숫자를 직접 입력해 주세요.'; $('#barcode-manual-button').hidden = true; $('#barcode-video').hidden = true; barcodeDialog.showModal(); $('#barcode-number').focus();
  }

  function stopBarcodeCamera() {
    barcodeScanActive = false;
    if (barcodeStream) { barcodeStream.getTracks().forEach((track) => track.stop()); barcodeStream = null; }
    const video = $('#barcode-video'); video.pause(); video.srcObject = null; video.hidden = true;
  }

  async function supportedBarcodeDetector() {
    if (!('BarcodeDetector' in globalThis)) return null;
    try {
      const supported = await BarcodeDetector.getSupportedFormats();
      const formats = ['ean_13','ean_8','upc_a','upc_e','upc_ean','itf_14'].filter((format) => supported.includes(format));
      return formats.length ? new BarcodeDetector({ formats }) : null;
    } catch { return null; }
  }

  function acceptScannedBarcode(rawValue) {
    const code = String(rawValue || '').replace(/\D/g, '');
    if (![8, 12, 13, 14].includes(code.length)) return false;
    $('#barcode-number').value = code; $('#barcode-error').textContent = ''; stopBarcodeCamera();
    $('#barcode-hint').textContent = `바코드 ${code}를 읽었어요. 제품 조회를 눌러 정보를 확인해 주세요.`;
    return true;
  }

  async function startBarcodeCamera() {
    $('#barcode-error').textContent = '';
    barcodeDetector = await supportedBarcodeDetector();
    if (!barcodeDetector) { $('#barcode-hint').textContent = '이 브라우저에서는 바코드 카메라 인식을 지원하지 않아요. 숫자 입력 또는 바코드 이미지 파일을 사용해 주세요.'; return; }
    if (!navigator.mediaDevices?.getUserMedia) { $('#barcode-hint').textContent = '카메라를 사용할 수 없는 환경이에요. 바코드 이미지나 숫자를 입력해 주세요.'; return; }
    try {
      barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const video = $('#barcode-video'); video.srcObject = barcodeStream; video.hidden = false; await video.play(); barcodeScanActive = true;
      $('#barcode-hint').textContent = '바코드를 화면 안에 맞춰 주세요. 인식되면 자동으로 멈춥니다.';
      while (barcodeScanActive && barcodeDialog.open) {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          try { const codes = await barcodeDetector.detect(video); const value = codes.find((code) => code.rawValue)?.rawValue; if (value && acceptScannedBarcode(value)) break; }
          catch { /* wait for the next camera frame */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
    } catch {
      stopBarcodeCamera(); $('#barcode-hint').textContent = '카메라 접근이 거부되었거나 실패했어요. 바코드 숫자를 직접 입력해 주세요.';
    }
  }

  async function scanBarcodeImage(file) {
    if (!file) return;
    const detector = await supportedBarcodeDetector();
    if (!detector || !globalThis.createImageBitmap) { $('#barcode-error').textContent = '이 브라우저는 이미지 바코드 인식을 지원하지 않아요. 숫자를 직접 입력해 주세요.'; return; }
    try {
      const bitmap = await createImageBitmap(file);
      try { const codes = await detector.detect(bitmap); const value = codes.find((code) => code.rawValue)?.rawValue; if (!value || !acceptScannedBarcode(value)) throw new Error('바코드를 찾지 못했어요. 선명한 이미지나 숫자 입력을 사용해 주세요.'); }
      finally { bitmap.close?.(); }
    } catch (error) { $('#barcode-error').textContent = error.message || '이미지에서 바코드를 읽지 못했어요.'; }
  }

  function categoryForProduct(product) {
    const text = `${product.productType || ''} ${product.name || ''}`.toLowerCase();
    if (/milk|dairy|유제품|우유|치즈|요거트/.test(text)) return '유제품';
    if (/beverage|drink|음료|주스|탄산/.test(text)) return '음료';
    if (/snack|chocolate|cookie|과자|스낵/.test(text)) return '간식';
    if (/meat|fish|seafood|육류|고기|생선|해산물/.test(text)) return '육류';
    if (/rice|cereal|noodle|pasta|쌀|밥|라면|면류/.test(text)) return '곡류·면';
    return '기타';
  }

  async function lookupScannedBarcode() {
    const code = $('#barcode-number').value.replace(/\D/g, '');
    if (![8, 12, 13, 14].includes(code.length)) { $('#barcode-error').textContent = 'EAN-8, UPC-A, EAN-13 또는 GTIN-14 숫자를 입력해 주세요.'; return; }
    const button = $('#barcode-lookup-button'); button.disabled = true; button.textContent = '조회 중…'; $('#barcode-error').textContent = ''; $('#barcode-manual-button').hidden = true;
    try {
      const response = await fetch('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ barcode: code }] }) });
      const body = await response.json();
      const result = body.results?.[0];
      if (!response.ok) throw new Error(body.error || '제품 정보를 조회하지 못했어요.');
      if (!result?.exact || !result.product?.name) {
        barcodeProductDraft = { barcode: code, manual: true };
        $('#barcode-error').textContent = result?.status === 'unavailable' ? 'Open Food Facts에 연결하지 못했어요. 바코드를 보관해 수동 등록할 수 있어요.' : '일치하는 제품을 찾지 못했어요. 식품 정보를 직접 입력해 주세요.';
        $('#barcode-manual-button').hidden = false; return;
      }
      barcodeProductDraft = { barcode: code, product: result.product, source: result.source };
      barcodeDialog.close(); stopBarcodeCamera();
      openNewItem();
      $('#item-name').value = result.product.name;
      $('#item-quantity').value = '1'; $('#item-unit').value = '개';
      $('#item-category').value = categoryForProduct(result.product);
      const storageText = `${result.product.storageText || ''} ${result.product.unopenedStorage || ''}`;
      const suggested = suggestStorage(`${result.product.name} ${result.product.productType || ''}`);
      const explicitCold = /냉장|refrigerat|keep cool/i.test(storageText);
      const explicitFrozen = /냉동|frozen/i.test(storageText);
      const explicitRoom = /상온|실온|room temperature/i.test(storageText);
      $('#item-location').value = explicitCold ? '냉장' : explicitFrozen ? '냉동' : explicitRoom ? '상온' : (suggested.location || '상온');
      locationTouched = false;
      $('#storage-note').textContent = storageText || suggested.message;
      $('#item-name').focus();
      showToast('바코드 상품을 찾았어요. 정보를 확인하고 등록해 주세요.');
    } catch (error) {
      $('#barcode-error').textContent = error.message || '제품 조회에 실패했어요. 수동 등록을 이용해 주세요.';
      barcodeProductDraft = { barcode: code, manual: true }; $('#barcode-manual-button').hidden = false;
    } finally { button.disabled = false; button.textContent = '제품 조회'; }
  }

  async function optimizeImage(file, maxEdge = 1600, maxBytes = 2_850_000) {
    if (!globalThis.createImageBitmap) throw new Error('이 브라우저는 사진 최적화를 지원하지 않습니다. 최신 브라우저에서 다시 시도해 주세요.');
    const bitmap = await createImageBitmap(file);
    try {
      let scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d', { alpha: false }); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', Math.max(.58, .88 - attempt * .08)));
        if (blob && blob.size <= maxBytes) return { dataUrl: await blobToDataUrl(blob), blob, width: canvas.width, height: canvas.height };
        scale *= .78;
      }
      throw new Error('사진 용량을 줄이지 못했어요. 해상도가 더 낮은 사진을 선택해 주세요.');
    } finally { bitmap.close?.(); }
  }

  function blobToDataUrl(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('사진을 읽지 못했어요.')); reader.readAsDataURL(blob); }); }

  async function startPhotoAnalysis(file) {
    if (!file) return;
    $('#review-error').textContent = ''; $('#review-list').replaceChildren(); $('#non-food-note').hidden = true; $('#scan-status').hidden = false; $('#scan-status').textContent = '사진을 확인하고 분석을 준비하고 있어요…'; $('#add-selected-button').disabled = true; $('#review-dialog').showModal();
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { $('#review-error').textContent = 'JPG, PNG, WEBP 사진만 사용할 수 있어요.'; $('#scan-status').hidden = true; return; }
    if (file.size > 10 * 1024 * 1024) { $('#review-error').textContent = '업로드 원본은 10MB 이하로 제한돼요.'; $('#scan-status').hidden = true; return; }
    try {
      const image = await optimizeImage(file);
      const digest = await imageDigest(image.blob);
      let seen;
      try { seen = new Set(JSON.parse(sessionStorage.getItem('mfb-analysis-hashes') || '[]')); } catch { seen = new Set(); }
      if (seen.has(digest)) throw new Error('이번 브라우저 세션에서 이미 분석한 사진이에요. 새 사진을 선택해 주세요.');
      scanImageDataUrl = image.dataUrl;
      const tiny = await optimizeImage(file, 500, 120_000); scanImagePreviewUrl = tiny.dataUrl;
      $('#scan-status').textContent = '사진을 AI로 분석하고 있어요. 잠시만 기다려 주세요…';
      const response = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl: scanImageDataUrl }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '사진 분석 요청을 완료하지 못했어요.');
      seen.add(digest); try { sessionStorage.setItem('mfb-analysis-hashes', JSON.stringify([...seen].slice(-20))); } catch { /* session storage can be disabled */ }
      scanDraft = result.items.filter((item) => item.isFood).map((item) => {
        const labelStorageEvidence = item.storageConfidence === 'high' && /라벨|포장|표시/.test(item.storageEvidence || '') && /냉장|냉동|실온|상온|서늘|직사광선/.test(item.storageEvidence || '');
        return { ...item, needsConfirmation: item.needsConfirmation || result.documentType === 'unclear', selected: true, identityConfirmed: item.confidence === 'high' && result.documentType !== 'unclear', storageSuggestion: item.storage, storageConfirmed: labelStorageEvidence && item.storage !== '확인 필요', storage: labelStorageEvidence ? item.storage : '확인 필요', barcode: item.barcode || '', manufacturingDate: isDate(item.manufacturingDate) ? item.manufacturingDate : '', manufacturingDateEvidence: item.manufacturingDateEvidence || '', purchaseDate: isDate(item.purchaseDate) ? item.purchaseDate : '', purchaseDateEvidence: item.purchaseDateEvidence || '', productInfo: null, actualExpiry: isDate(item.actualExpiry) ? item.actualExpiry : '', originalExpiry: isDate(item.actualExpiry) ? item.actualExpiry : '', expiryEdited: false, opened: false, openedAt: '', usePhoto: result.documentType === 'product_photo' && result.items.filter((entry) => entry.isFood).length === 1 };
      });
      scanNonFood = result.nonFoodItems || [];
      $('#scan-status').textContent = '제품 정보를 확인하고 있어요…';
      await enrichDraftsWithProductLookup();
      renderReview(result.notes, result.documentType);
      $('#scan-status').hidden = true; $('#add-selected-button').disabled = !scanDraft.length;
    } catch (error) {
      $('#scan-status').hidden = true;
      $('#review-error').textContent = error.message.includes('Failed to fetch') ? 'API 서버에 연결할 수 없어요. 서버 실행과 OPENAI_API_KEY 설정을 확인해 주세요.' : error.message;
    }
  }

  function applyProductLookup(item, result) {
    item.productInfo = result;
    if (!result?.exact || !result.product) return;
    item.identityConfirmed = true;
    item.name = result.product.name || item.name;
    item.brand = result.product.brand || item.brand || '';
    item.variant = result.product.variant || item.variant || '';
    item.productType = result.product.productType || item.productType || '';
    item.packageQuantity = result.product.packageQuantity || item.packageQuantity || '';
    item.unopenedStorage = result.product.unopenedStorage || result.product.storageText || '';
    item.openedStorage = result.product.openedStorage || '';
    item.nutrition = result.product.nutrition || null;
    item.shelfLifeDays = result.product.shelfLifeDays || null;
    item.shelfLifeBasis = result.product.shelfLifeBasis || '';
    if (['냉장','냉동','상온'].includes(result.product.storage)) { item.storageSuggestion = result.product.storage; item.storage = result.product.storage; item.storageConfirmed = result.sources?.some((source) => /(^|\.)(donga\.co\.kr|cj\.co\.kr|nongshim\.com)$/.test(new URL(source.url).hostname)) || false; item.storageEvidence = `제품 정보 검색 제안: ${result.product.storageText || result.product.storage} · 제품 라벨을 우선하세요.`; }
    else if (result.product.storageText && item.storage === '확인 필요') item.storageEvidence = `제품 DB 보관 정보: ${result.product.storageText} · 포장 라벨 확인 필요`;
  }

  function clearSourcedProductInfo(item) {
    if (item.productInfo?.exact) {
      item.storage = '확인 필요'; item.storageSuggestion = '확인 필요'; item.storageConfirmed = false;
      item.storageEvidence = '제품이 바뀌었습니다. 새 제품 라벨의 보관방법을 확인해 주세요.';
    }
    item.productInfo = null; item.nutrition = null; item.unopenedStorage = ''; item.openedStorage = ''; item.shelfLifeDays = null; item.shelfLifeBasis = '';
  }

  async function enrichDraftsWithProductLookup() {
    const cacheKey = (item) => item.barcode ? `barcode:${item.barcode.replace(/\D/g, '')}` : `name:${(item.name || '').trim().toLocaleLowerCase('ko')}|${(item.brand || '').trim().toLocaleLowerCase('ko')}|${(item.variant || '').trim().toLocaleLowerCase('ko')}|${(item.packageQuantity || '').trim().toLocaleLowerCase('ko')}`;
    let cache = {}; try { cache = JSON.parse(localStorage.getItem('mfb-product-lookup-cache-v1') || '{}'); } catch { cache = {}; }
    const now = Date.now();
    for (const key of Object.keys(cache)) if (!cache[key]?.expiresAt || cache[key].expiresAt < now) delete cache[key];
    const pending = scanDraft.filter((item) => item.name).filter((item) => !cache[cacheKey(item)]).slice(0, 8);
    let fetched = [];
    if (pending.length) {
      try {
        const response = await fetch('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: pending.map(({ name, brand, barcode, variant, packageQuantity }) => ({ name, brand, barcode, variant, packageQuantity })) }) });
        if (response.ok) fetched = (await response.json()).results || [];
      } catch { /* 제품 조회는 인벤토리 등록을 막지 않습니다 */ }
      pending.forEach((item, index) => {
        const result = fetched[index];
        if (result) item.productInfo = result;
        if (result && !['unavailable', 'rate_limited', 'needs_api_key'].includes(result.status)) cache[cacheKey(item)] = { result, expiresAt: now + 24 * 60 * 60 * 1000 };
      });
      try { localStorage.setItem('mfb-product-lookup-cache-v1', JSON.stringify(cache)); } catch { /* cache is optional */ }
    }
    for (const item of scanDraft) {
      const result = cache[cacheKey(item)]?.result || item.productInfo;
      if (result) applyProductLookup(item, result);
    }
  }

  function isDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && getDaysLeft(value) !== null; }

  async function imageDigest(blob) {
    const buffer = await blob.arrayBuffer();
    if (globalThis.crypto?.subtle) return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((value) => value.toString(16).padStart(2, '0')).join('');
    let hash = 2166136261;
    for (const byte of new Uint8Array(buffer)) hash = Math.imul(hash ^ byte, 16777619);
    return `${blob.size}-${(hash >>> 0).toString(16)}`;
  }

  function checkDateRecommendation(item) {
    return InventoryData.recommendCheckDate(item);
  }

  function manufacturerExpirySuggestion(item) {
    if (!isDate(item.manufacturingDate) || !Number.isInteger(item.shelfLifeDays) || item.shelfLifeDays <= 0 || !item.productInfo?.exact || !item.productInfo.sources?.some((source) => /(^|\.)(donga\.co\.kr|cj\.co\.kr|nongshim\.com)$/.test(new URL(source.url).hostname))) return null;
    return { date: addDays(item.manufacturingDate, item.shelfLifeDays), days: item.shelfLifeDays, basis: item.shelfLifeBasis };
  }

  function renderReview(notes = '', documentType = '') {
    $('#review-list').innerHTML = scanDraft.map((item, index) => `<section class="review-item ${item.needsConfirmation ? 'needs-review' : ''}" data-index="${index}"><label class="review-select"><input type="checkbox" data-field="selected" ${item.selected ? 'checked' : ''}><span>등록 선택</span></label><div class="review-item-heading"><strong>${item.confidence === 'low' ? '식품명 확인 필요' : '인식 상품'} ${index + 1}</strong><span class="confidence ${item.needsConfirmation ? 'warn' : ''}">${item.needsConfirmation ? '확인 필요' : '높은 인식 신뢰도'}</span></div><div class="review-fields"><label class="field"><span>상품명</span><input data-field="name" value="${escapeHtml(item.name)}" maxlength="60"></label>${!item.identityConfirmed ? '<label class="checkline"><input type="checkbox" data-field="identityConfirmed"> 상품명을 확인했어요</label>' : ''}<label class="field"><span>브랜드</span><input data-field="brand" value="${escapeHtml(item.brand || '')}" maxlength="60"></label><div class="field-pair"><label class="field"><span>수량</span><input data-field="quantity" type="number" min="0.01" step="any" value="${escapeHtml(item.quantity)}"></label><label class="field"><span>단위</span><input data-field="unit" value="${escapeHtml(item.unit)}" maxlength="12"></label></div><label class="field"><span>제품 종류</span><input data-field="productType" value="${escapeHtml(item.productType)}" maxlength="60"></label><div class="field-pair"><label class="field"><span>맛·제품 버전</span><input data-field="variant" value="${escapeHtml(item.variant || '')}" maxlength="60"></label><label class="field"><span>제품 용량</span><input data-field="packageQuantity" value="${escapeHtml(item.packageQuantity || '')}" maxlength="40"></label></div>${item.nutrition ? `<div class="field-pair"><label class="field"><span>열량 kcal</span><input data-field="nutritionCaloriesKcal" type="number" min="0" step="any" value="${item.nutrition.caloriesKcal ?? ''}"></label><label class="field"><span>열량 기준량</span><input data-field="nutritionCalorieBasis" value="${escapeHtml(item.nutrition.calorieBasis || item.nutrition.basis || '')}" maxlength="40"></label></div><div class="field-pair nutrition-fields"><label class="field"><span>탄수화물 g</span><input data-field="nutritionCarbohydratesG" type="number" min="0" step="any" value="${item.nutrition.carbohydratesG ?? ''}"></label><label class="field"><span>당류 g</span><input data-field="nutritionSugarsG" type="number" min="0" step="any" value="${item.nutrition.sugarsG ?? ''}"></label><label class="field"><span>단백질 g</span><input data-field="nutritionProteinG" type="number" min="0" step="any" value="${item.nutrition.proteinG ?? ''}"></label><label class="field"><span>지방 g</span><input data-field="nutritionFatG" type="number" min="0" step="any" value="${item.nutrition.fatG ?? ''}"></label><label class="field"><span>나트륨 mg</span><input data-field="nutritionSodiumMg" type="number" min="0" step="any" value="${item.nutrition.sodiumMg ?? ''}"></label></div>` : ''}<div class="field-pair"><label class="field"><span>카테고리</span><select data-field="category">${Object.keys(icons).map((key) => `<option ${item.category === key ? 'selected' : ''}>${key}</option>`).join('')}</select></label><label class="field"><span>보관 장소 추천</span><select data-field="storage"><option value="확인 필요" ${item.storage === '확인 필요' ? 'selected' : ''}>확인 필요</option>${['냉장','냉동','상온'].map((location) => `<option ${item.storage === location ? 'selected' : ''}>${location}</option>`).join('')}</select></label></div><p class="review-evidence">${escapeHtml(item.storageEvidence || '보관 근거를 읽지 못했어요. 제품 라벨을 확인해 주세요.')}${item.storageConfidence !== 'high' ? ' · 사용자가 확인해야 합니다.' : ''}</p>${item.productInfo?.exact ? `<label class="field"><span>미개봉 보관방법</span><input data-field="unopenedStorage" value="${escapeHtml(item.unopenedStorage || '')}" maxlength="200"></label><label class="field"><span>개봉 후 보관방법</span><input data-field="openedStorage" value="${escapeHtml(item.openedStorage || '')}" maxlength="200"></label>` : ''}<label class="field"><span>바코드 <small>명확히 읽힌 경우</small></span><input data-field="barcode" value="${escapeHtml(item.barcode || '')}" inputmode="numeric" maxlength="14"></label><div class="field-pair"><label class="field"><span>제조일 <small>라벨에서 확인</small></span><input data-field="manufacturingDate" type="date" value="${escapeHtml(item.manufacturingDate || '')}"></label><label class="field"><span>구매일 <small>영수증에서 확인</small></span><input data-field="purchaseDate" type="date" value="${escapeHtml(item.purchaseDate || '')}"></label></div>${item.manufacturingDateEvidence || item.purchaseDateEvidence ? `<p class="review-evidence">${escapeHtml([item.manufacturingDateEvidence, item.purchaseDateEvidence].filter(Boolean).join(' · '))}</p>` : ''}<label class="field"><span>실제 소비기한 <small>포장에 명확하게 표시된 날짜만</small></span><input data-field="actualExpiry" type="date" value="${escapeHtml(item.actualExpiry || '')}"></label>${manufacturerExpirySuggestion(item) ? `<label class="field"><span>제조일 기준 소비기한 제안 <small>제품 제조사 기준 ${manufacturerExpirySuggestion(item).days}일 · 실제 날짜와 구분</small></span><input data-field="manufacturerExpiryDate" type="date" value="${manufacturerExpirySuggestion(item).date}"></label><label class="checkline"><input data-field="useManufacturerExpiry" type="checkbox" ${item.useManufacturerExpiry ? 'checked' : ''}> 이 제조일 기준 계산 날짜를 확인하고 저장</label><p class="review-evidence">${escapeHtml(manufacturerExpirySuggestion(item).basis)} · 제조일 ${escapeHtml(item.manufacturingDate)} 기준</p>` : ''}${item.expiryEvidence ? `<p class="review-evidence">라벨에서 읽은 날짜 표시: ${escapeHtml(item.expiryEvidence)}</p>` : '<p class="review-evidence">날짜를 읽지 못했어요. 임의로 추정하지 않았습니다.</p>'}${checkDateRecommendation(item) ? `<label class="field"><span>추천 재고 확인일 <small>소비기한이 아닙니다 · 구매일 ${escapeHtml(item.purchaseDate)}</small></span><input data-field="recommendedCheckDate" type="date" value="${checkDateRecommendation(item).date}"></label><label class="checkline"><input type="checkbox" data-field="useRecommendedCheckDate" checked> 이 추천 확인일 저장</label><p class="review-evidence">${escapeHtml(checkDateRecommendation(item).basis)} · <a href="${checkDateRecommendation(item).sourceUrl}" target="_blank" rel="noopener noreferrer">FoodSafety.gov 출처</a></p>` : ''}${item.visualEvidence ? `<p class="review-evidence">시각적 특징: ${escapeHtml(item.visualEvidence)}</p>` : ''}${item.candidateNames?.length && item.confidence !== 'high' ? `<div class="product-match"><strong>사진에서 가능한 상품 후보</strong>${item.candidateNames.slice(0,3).map((candidate) => `<button type="button" data-action="choose-ai-candidate" data-candidate="${escapeHtml(candidate)}">${escapeHtml(candidate)}</button>`).join('')}</div>` : ''}${item.productInfo?.exact ? `<div class="product-match"><strong>정확히 일치한 제품 정보</strong><p>${escapeHtml(item.productInfo.product.name || item.name)} · ${escapeHtml(item.productInfo.product.packageQuantity || item.packageQuantity || '용량 미확인')}</p>${[...(item.productInfo.sources || []), ...(item.productInfo.source ? [item.productInfo.source] : [])].map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)} · ${escapeHtml((source.queriedAt || '').slice(0,10))}</a>`).join('')}<small>${escapeHtml(item.productInfo.matchReason || item.productInfo.warning || '제품 라벨과 다르면 라벨을 우선하세요.')}</small></div>` : (item.productInfo?.candidates?.length ? `<div class="product-match"><strong>정확한 매칭이 없어 후보를 확인해 주세요</strong>${item.productInfo.candidates.map((candidate) => `<button type="button" data-action="choose-web-candidate" data-candidate="${escapeHtml(candidate)}">${escapeHtml(candidate)}</button>`).join('')}</div>` : (item.productInfo?.sources?.length ? `<div class="product-match"><strong>검색 출처(정보 자동입력 보류)</strong>${item.productInfo.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.name)} · ${escapeHtml(source.queriedAt.slice(0,10))}</a>`).join('')}<small>${escapeHtml(item.productInfo.matchReason || '정확한 제품 매칭이 확인되지 않았습니다.')}</small></div>` : '<p class="review-evidence">정확한 제품 정보를 찾지 못해 다른 상품 정보를 적용하지 않았습니다.</p>'))}${item.productInfo?.status === 'needs_api_key' ? '<p class="review-evidence">웹 제품 검색에는 서버 OPENAI_API_KEY가 필요합니다. 라벨에서 확인한 정보는 직접 수정할 수 있습니다.</p>' : ''}<button type="button" class="secondary-button" data-action="refresh-product-info">제품 정보 다시 검색</button><label class="checkline review-photo-choice" ${item.usePhoto ? '' : 'hidden'}><input type="checkbox" data-field="usePhoto" ${item.usePhoto ? 'checked' : ''}> 제품 사진을 이 식품 카드에 사용</label><label class="checkline"><input type="checkbox" data-field="opened" ${item.opened ? 'checked' : ''}> 이미 개봉했어요</label><label class="field opened-date-field" ${item.opened ? '' : 'hidden'}><span>개봉일</span><input data-field="openedAt" type="date" value="${escapeHtml(item.openedAt || '')}"></label>${item.openedGuidance ? `<p class="review-safety">포장 개봉 안내(확인 필요): ${escapeHtml(item.openedGuidance)}${Number.isInteger(item.openedGuidanceDays) ? ` · 개봉 후 ${item.openedGuidanceDays}일 이내 사용 안내에 따라 확인일을 추천합니다.` : ''}</p>` : ''}</div></section>`).join('');
    const warningNotes = [notes, documentType === 'unclear' ? '사진이 영수증이나 식품 포장인지 명확하지 않습니다.' : ''].filter(Boolean);
    if (scanNonFood.length) { $('#non-food-note').hidden = false; $('#non-food-note').textContent = `식품이 아닌 것으로 분류되어 등록에서 제외한 항목: ${scanNonFood.join(', ')}`; }
    if (warningNotes.length) { $('#non-food-note').hidden = false; $('#non-food-note').textContent = [$('#non-food-note').textContent, ...warningNotes].filter(Boolean).join(' · '); }
    if (!scanDraft.length) { $('#review-list').innerHTML = '<div class="empty-review">식품 항목을 확실히 인식하지 못했어요. 사진을 다시 찍거나 식품을 직접 등록해 주세요.</div>'; $('#add-selected-button').disabled = true; }
  }

  $('#review-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="choose-ai-candidate"], [data-action="choose-web-candidate"], [data-action="refresh-product-info"]');
    if (!button) return;
    const index = Number(button.closest('[data-index]')?.dataset.index);
    const item = scanDraft[index]; if (!item) return;
    if (button.dataset.candidate) {
      clearSourcedProductInfo(item); item.name = button.dataset.candidate; item.brand = ''; item.variant = ''; item.packageQuantity = ''; item.barcode = '';
      item.identityConfirmed = true; item.needsConfirmation = false;
    } else clearSourcedProductInfo(item);
    $('#scan-status').hidden = false; $('#scan-status').textContent = '선택한 후보의 제품 정보를 다시 확인하고 있어요…';
    try {
      const response = await fetch('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ name: item.name, brand: '', variant: '', packageQuantity: '', barcode: '' }] }) });
      if (response.ok) applyProductLookup(item, (await response.json()).results?.[0]);
    } catch { item.productInfo = { status: 'unavailable' }; }
    $('#scan-status').hidden = true;
    renderReview('후보를 선택해 제품 정보를 다시 검색했습니다.');
  });

  $('#review-list').addEventListener('input', updateReviewDraft);
  $('#review-list').addEventListener('change', updateReviewDraft);
  function updateReviewDraft(event) {
    const control = event.target.closest('[data-field]'); if (!control) return;
    const section = control.closest('[data-index]'); if (!section) return;
    const index = Number(section.dataset.index); const key = control.dataset.field;
    if (key.startsWith('nutrition')) {
      const field = key.replace('nutrition',''); const prop = field.charAt(0).toLowerCase() + field.slice(1);
      scanDraft[index].nutrition = scanDraft[index].nutrition || {}; scanDraft[index].nutrition[prop] = prop === 'calorieBasis' ? control.value : (control.value === '' ? null : Number(control.value));
    }
    else if (key === 'quantity') scanDraft[index][key] = Number(control.value);
    else if (control.type === 'checkbox') scanDraft[index][key] = control.checked;
    else scanDraft[index][key] = control.value;
    if (key === 'actualExpiry') scanDraft[index].expiryEdited = control.value !== scanDraft[index].originalExpiry;
    if (['name', 'brand', 'variant', 'packageQuantity', 'barcode'].includes(key)) {
      clearSourcedProductInfo(scanDraft[index]);
      const matchedInfo = section.querySelector('.product-match');
      if (matchedInfo) matchedInfo.hidden = true;
    }
    if (key === 'useRecommendedCheckDate') scanDraft[index].useRecommendedCheckDate = control.checked;
    if (key === 'manufacturingDate') { const suggestion = manufacturerExpirySuggestion(scanDraft[index]); const input = section.querySelector('[data-field="manufacturerExpiryDate"]'); if (suggestion && input) input.value = suggestion.date; }
    if (key === 'purchaseDate') {
      const recommendation = checkDateRecommendation(scanDraft[index]);
      const recommendedDate = section.querySelector('[data-field="recommendedCheckDate"]');
      if (recommendation && recommendedDate) { scanDraft[index].recommendedCheckDate = recommendation.date; recommendedDate.value = recommendation.date; }
    }
    if (key === 'opened') section.querySelector('.opened-date-field').hidden = !control.checked;
    if (key === 'storage') scanDraft[index].storageConfirmed = control.value !== '확인 필요';
    if (key === 'identityConfirmed') scanDraft[index].identityConfirmed = control.checked;
    if (key === 'storage' && control.value === '확인 필요') scanDraft[index].needsConfirmation = true;
  }

  $('#add-selected-button').addEventListener('click', () => {
    const selected = scanDraft.filter((item) => item.selected);
    if (!selected.length) { $('#review-error').textContent = '등록할 식품을 하나 이상 선택해 주세요.'; return; }
    const unresolved = selected.find((item) => !item.name.trim() || !Number.isFinite(item.quantity) || item.quantity <= 0 || !item.unit.trim() || !['냉장','냉동','상온'].includes(item.storage) || !item.storageConfirmed || !item.identityConfirmed);
    if (unresolved) { $('#review-error').textContent = '확인이 필요한 식품명·수량·보관 장소를 확인한 뒤 등록해 주세요.'; return; }
    const now = new Date();
    for (const draft of selected) {
      const openedAt = draft.opened ? draft.openedAt || '' : '';
      const recommendation = checkDateRecommendation(draft);
      const labelCheckDate = openedAt && Number.isInteger(draft.openedGuidanceDays) ? addDays(openedAt, draft.openedGuidanceDays) : '';
      const checkDate = labelCheckDate || (draft.useRecommendedCheckDate && recommendation ? (draft.recommendedCheckDate || recommendation.date) : '');
      const checkDateSourceUrl = labelCheckDate ? '' : recommendation?.sourceUrl || '';
      const checkDateBasis = labelCheckDate ? `포장 개봉 후 안내 ${draft.openedGuidanceDays}일` : (checkDate && recommendation ? recommendation.basis : '');
      const calculatedExpiry = manufacturerExpirySuggestion(draft);
      const savedExpiry = draft.actualExpiry || (draft.useManufacturerExpiry && calculatedExpiry ? (draft.manufacturerExpiryDate || calculatedExpiry.date) : '');
      const expirySource = draft.actualExpiry ? (draft.expiryEdited ? 'user' : 'label') : (savedExpiry ? 'manufacturer-calculated' : 'none');
      const entry = { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: draft.name.trim(), brand: (draft.brand || '').trim(), productType: draft.productType || '', variant: draft.variant || '', packageQuantity: draft.packageQuantity || '', nutrition: draft.nutrition || null, unopenedStorage: draft.unopenedStorage || '', openedStorage: draft.openedStorage || '', shelfLifeDays: draft.shelfLifeDays || null, shelfLifeBasis: draft.shelfLifeBasis || '', productSources: [...(draft.productInfo?.sources || []), ...(draft.productInfo?.source ? [draft.productInfo.source] : [])], quantity: draft.quantity, unit: draft.unit.trim(), location: draft.storage, category: draft.category, expiry: savedExpiry, expirySource, expiryEvidence: draft.actualExpiry ? (draft.expiryEdited ? '사용자가 확인 또는 수정' : draft.expiryEvidence || '') : (savedExpiry ? `${draft.manufacturingDate} + ${draft.shelfLifeDays}일 · 제조사 정보` : ''), barcode: (draft.barcode || '').replace(/\D/g, '').slice(0,14), manufacturingDate: draft.manufacturingDate || '', manufacturingDateEvidence: draft.manufacturingDateEvidence || '', purchaseDate: draft.purchaseDate || '', productImageUrl: draft.productInfo?.exact ? draft.productInfo.product.imageUrl || '' : '', productSource: draft.productInfo?.exact ? draft.productInfo.source : null, checkDate, checkDateSource: labelCheckDate ? 'label-opened-guidance' : (checkDate ? 'official-storage-guideline' : ''), checkDateBasis, checkDateSourceUrl, opened: Boolean(draft.opened), openedAt, openedGuidance: draft.openedGuidance || '', openedGuidanceDays: Number.isInteger(draft.openedGuidanceDays) ? draft.openedGuidanceDays : null, storageEvidence: draft.storageEvidence || '', photo: draft.usePhoto ? scanImagePreviewUrl : '', memo: '', createdAt: now.toISOString(), updatedAt: now.toISOString() };
      mergeOrInsert(entry);
      addHistory(entry);
    }
    saveItems(); reviewDialog.close(); renderItems(); showToast(`${selected.length}개 식품을 등록했어요.`);
  });

  function addDays(dateString, days) { const date = new Date(`${dateString}T12:00:00`); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; }

  grid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'add') return openNewItem();
    const card = button.closest('.food-card'); if (!card) return;
    const item = byId(card.dataset.id); if (!item) return;
    const action = button.dataset.action;
    if (action === 'favorite') { toggleFavorite(item); showToast(isFavorite(item) ? '즐겨찾기에 추가했어요.' : '즐겨찾기에서 뺐어요.'); return; }
    if (action === 'menu') {
      const menu = card.querySelector('.card-actions'); const open = menu.hidden;
      grid.querySelectorAll('.card-actions').forEach((element) => { element.hidden = true; element.closest('.food-card').querySelector('.card-menu').setAttribute('aria-expanded', 'false'); });
      menu.hidden = !open; button.setAttribute('aria-expanded', String(open)); return;
    }
    if (action === 'increase' || action === 'decrease') {
      const next = action === 'increase' ? Number(item.quantity) + 1 : Math.max(0, Number(item.quantity) - 1);
      items = items.map((entry) => entry.id === item.id ? { ...entry, quantity: Number(next.toFixed(2)), updatedAt: new Date().toISOString() } : entry);
      saveItems(); renderItems(); if (action === 'decrease' && next === 0) showToast('재고가 0개가 되었어요.'); return;
    }
    if (action === 'consume') {
      $('#quantity-item-id').value = item.id; $('#quantity-item-name').textContent = `현재 ${formatQuantity(item.quantity)}${item.unit} 보유`; $('#consume-amount').value = '1'; $('#consume-amount').max = item.quantity; $('#quantity-error').textContent = ''; quantityDialog.showModal(); $('#consume-amount').focus(); return;
    }
    if (action === 'edit') return openEditItem(item);
    if (action === 'finish' || action === 'delete') {
      const message = action === 'finish' ? `${item.name}을(를) 소진 처리할까요?` : `${item.name}을(를) 인벤토리에서 삭제할까요?`;
      if (!window.confirm(message)) return;
      items = items.filter((entry) => entry.id !== item.id); saveItems(); renderItems(); showToast(action === 'finish' ? '소진한 식품을 정리했어요.' : '식품을 삭제했어요.');
    }
  });

  $('#quantity-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const item = byId($('#quantity-item-id').value); const amount = Number($('#consume-amount').value);
    if (!item || !Number.isFinite(amount) || amount <= 0) { $('#quantity-error').textContent = '0보다 큰 차감 수량을 입력해 주세요.'; return; }
    if (amount > Number(item.quantity)) { $('#quantity-error').textContent = `현재 보유 수량(${formatQuantity(item.quantity)}${item.unit})보다 많이 차감할 수 없어요.`; return; }
    const left = Number((Number(item.quantity) - amount).toFixed(2));
    items = items.map((entry) => entry.id === item.id ? { ...entry, quantity: left, updatedAt: new Date().toISOString() } : entry);
    saveItems(); quantityDialog.close(); renderItems(); showToast(left === 0 ? '재고가 0개예요. +를 눌러 다시 추가할 수 있어요.' : `${formatQuantity(amount)}${item.unit} 사용했어요.`);
  });

  let locationTouched = false;
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.addEventListener('click', () => {
    activeFilter = chip.dataset.filter; document.querySelectorAll('.filter-chip').forEach((entry) => { entry.classList.toggle('active', entry === chip); entry.setAttribute('aria-selected', String(entry === chip)); }); renderItems();
  }));
  $('#search-input').addEventListener('input', (event) => { searchTerm = event.target.value.trim(); renderItems(); });
  document.querySelector('.utility-section').addEventListener('click', (event) => { const button = event.target.closest('[data-quick-action]'); if (!button) return; const type = button.dataset.quickType; const index = Number(button.dataset.quickIndex); if (button.dataset.quickAction === 'delete-history') { history.splice(index, 1); saveJson(HISTORY_KEY, history); renderQuickAccess(); return; } const entry = (type === 'favorite' ? favorites : history)[index]; if (entry) registerFromQuick(entry); });
  $('#add-button').addEventListener('click', openNewItem);
  $('#scan-button').addEventListener('click', selectPhoto);
  $('#barcode-button').addEventListener('click', openBarcodeRegistration);
  $('#barcode-camera-button').addEventListener('click', startBarcodeCamera);
  $('#barcode-image-button').addEventListener('click', () => { $('#barcode-image-input').value = ''; $('#barcode-image-input').click(); });
  $('#barcode-image-input').addEventListener('change', (event) => scanBarcodeImage(event.target.files?.[0]));
  $('#barcode-lookup-button').addEventListener('click', lookupScannedBarcode);
  $('#barcode-manual-button').addEventListener('click', () => { barcodeDialog.close(); stopBarcodeCamera(); openNewItem(); });
  barcodeDialog.addEventListener('close', stopBarcodeCamera);
  $('#photo-input').addEventListener('change', (event) => startPhotoAnalysis(event.target.files?.[0]));
  $('#item-name').addEventListener('change', updateStorageSuggestion);
  $('#item-location').addEventListener('change', () => { locationTouched = true; });
  $('#item-opened').addEventListener('change', () => { $('#opened-date-wrap').hidden = !$('#item-opened').checked; });
  $('#backup-button').addEventListener('click', () => { $('#backup-error').textContent = ''; backupDialog.showModal(); });
  $('#export-button').addEventListener('click', () => {
    const data = { app: 'My Fresh Bag', version: 1, exportedAt: new Date().toISOString(), items };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `my-fresh-bag-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url); backupDialog.close(); showToast('JSON 백업 파일을 저장했어요.');
  });
  $('#import-button').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()); const imported = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(imported) || !imported.every(isValidItem)) throw new Error('식품 목록 또는 항목 형식이 올바르지 않습니다.');
      if (!window.confirm(`${imported.length}개 식품으로 현재 인벤토리를 바꿀까요?`)) return;
      const unique = new Set(imported.map((item) => item.id)); if (unique.size !== imported.length) throw new Error('중복된 식품 ID가 있어요.');
      items = imported.map(InventoryData.normalizeItem);
      saveItems(); renderItems(); backupDialog.close(); showToast('백업 데이터를 복원했어요.');
    } catch (error) { $('#backup-error').textContent = `복원하지 못했어요: ${error.message}`; }
    finally { event.target.value = ''; }
  });

  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); }
    if (event.key === 'Escape') grid.querySelectorAll('.card-actions').forEach((menu) => { menu.hidden = true; });
  });

  const today = new Date();
  $('#today-label').textContent = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(today);
  $('#date-label').textContent = String(today.getDate());
  renderItems();
  renderQuickAccess();
})();
