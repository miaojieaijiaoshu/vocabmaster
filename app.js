'use strict';

// ════════════════════════════════════════════
// 1. DATABASE  (IndexedDB)
// ════════════════════════════════════════════
const DB = {
  _db: null,

  init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('VocabMaster', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('words')) {
          db.createObjectStore('words', { keyPath: 'id' });
        }
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },

  _tx(mode) {
    return this._db.transaction('words', mode).objectStore('words');
  },

  getAll() {
    return new Promise((resolve, reject) => {
      const req = this._tx('readonly').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  save(word) {
    return new Promise((resolve, reject) => {
      const req = this._tx('readwrite').put(word);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },

  delete(id) {
    return new Promise((resolve, reject) => {
      const req = this._tx('readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
};

// ════════════════════════════════════════════
// 2. WORD MODEL & EBBINGHAUS
// ════════════════════════════════════════════
// 答对后各阶段的等待天数: stage 0→1 等1天, 1→2 等2天 …
const INTERVALS = [1, 2, 4, 7, 15, 30];

function createWord(english, chineseDefinition, phonetic = '') {
  return {
    id: crypto.randomUUID(),
    english: english.toLowerCase().trim(),
    chineseDefinition,
    phonetic,
    dateAdded: new Date().toISOString(),
    nextReviewDate: addDays(new Date(), 1).toISOString(),
    reviewStage: 0,
    totalReviews: 0,
  };
}

function recordReview(word, correct) {
  word.totalReviews++;
  if (correct) {
    word.reviewStage = Math.min(word.reviewStage + 1, 6);
    if (word.reviewStage < INTERVALS.length) {
      word.nextReviewDate = addDays(new Date(), INTERVALS[word.reviewStage]).toISOString();
    }
    // reviewStage === 6 → mastered, nextReviewDate no longer matters
  } else {
    word.reviewStage = 0;
    word.nextReviewDate = addDays(new Date(), 1).toISOString();
  }
}

function isMastered(word) { return word.reviewStage >= 6; }

function needsReview(word) {
  return !isMastered(word) && new Date(word.nextReviewDate) <= new Date();
}

function daysUntil(word) {
  const diff = new Date(word.nextReviewDate) - new Date();
  return Math.max(0, Math.ceil(diff / 86400000));
}

function stageLabel(word) {
  if (isMastered(word)) return '已掌握';
  return `第 ${word.reviewStage + 1} 阶段`;
}

function stageClass(word) {
  if (isMastered(word)) return 'stage-mastered';
  return `stage-${Math.min(word.reviewStage, 5)}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ════════════════════════════════════════════
// 3. DICTIONARY API
// Free Dictionary API (phonetics) + MyMemory (Chinese translation)
// ════════════════════════════════════════════
async function lookupWord(query) {
  const word = query.toLowerCase().trim();
  if (!word) throw new Error('请输入单词');

  const [dictRes, transRes] = await Promise.allSettled([
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`),
    fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(word)}&langpair=en|zh-CN`)
  ]);

  let phonetic = '';
  let chineseDefinition = '';

  if (dictRes.status === 'fulfilled' && dictRes.value.ok) {
    const data = await dictRes.value.json();
    if (Array.isArray(data) && data[0]) {
      const entry = data[0];
      phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '';
    }
  }

  if (transRes.status === 'fulfilled' && transRes.value.ok) {
    const data = await transRes.value.json();
    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      chineseDefinition = data.responseData.translatedText;
    }
  }

  if (!chineseDefinition) {
    throw new Error('找不到这个单词，请检查拼写是否正确');
  }

  return { word, phonetic, chineseDefinition };
}

// ════════════════════════════════════════════
// 4. SPEECH RECOGNITION
// ════════════════════════════════════════════
const SpeechSvc = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let active = false;

  function supported() { return !!SR; }

  function start(onResult, onEnd) {
    if (!SR || active) return;
    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = e => {
      const transcript = Array.from(e.results)
        .map(r => r[0].transcript).join('');
      onResult(transcript, e.results[e.results.length - 1].isFinal);
    };
    recognition.onend = () => { active = false; onEnd(); };
    recognition.onerror = () => { active = false; onEnd(); };
    recognition.start();
    active = true;
  }

  function stop() {
    recognition?.stop();
    active = false;
  }

  return { supported, start, stop, isActive: () => active };
})();

// ════════════════════════════════════════════
// 5. APP STATE
// ════════════════════════════════════════════
let words = [];   // in-memory cache, synced with DB

async function loadWords() {
  words = await DB.getAll();
}

async function addWord(word) {
  words.push(word);
  await DB.save(word);
  updateBadges();
}

async function updateWord(word) {
  const idx = words.findIndex(w => w.id === word.id);
  if (idx >= 0) words[idx] = word;
  await DB.save(word);
  updateBadges();
}

async function removeWord(id) {
  words = words.filter(w => w.id !== id);
  await DB.delete(id);
  updateBadges();
}

function findByEnglish(eng) {
  return words.find(w => w.english === eng.toLowerCase().trim());
}

function updateBadges() {
  const dueCount = words.filter(needsReview).length;
  const reviewBadge = document.getElementById('review-badge');
  const notebookBadge = document.getElementById('notebook-badge');
  reviewBadge.textContent = dueCount;
  reviewBadge.classList.toggle('hidden', dueCount === 0);
  notebookBadge.textContent = words.filter(w => !isMastered(w)).length;
  notebookBadge.classList.toggle('hidden', words.length === 0);
}

// ════════════════════════════════════════════
// 6. ROUTING
// ════════════════════════════════════════════
let currentTab = 'lookup';

function switchTab(name) {
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  currentTab = name;
  if (name === 'notebook') renderNotebook();
  if (name === 'review') renderReview();
}

// ════════════════════════════════════════════
// 7. LOOKUP VIEW
// ════════════════════════════════════════════
function initLookup() {
  const micBtn = document.getElementById('mic-btn');
  const hint = document.getElementById('voice-hint');
  const input = document.getElementById('word-input');
  const searchBtn = document.getElementById('search-btn');

  // Voice
  if (!SpeechSvc.supported()) {
    micBtn.style.opacity = '0.4';
    hint.textContent = '此设备不支持语音识别';
    micBtn.disabled = true;
  } else {
    micBtn.addEventListener('click', () => {
      if (SpeechSvc.isActive()) {
        SpeechSvc.stop();
        micBtn.classList.remove('listening');
        hint.textContent = '点击朗读单词';
      } else {
        SpeechSvc.start(
          (text, isFinal) => {
            input.value = text;
            hint.textContent = text || '正在听…';
            if (isFinal && text.trim()) {
              SpeechSvc.stop();
              micBtn.classList.remove('listening');
              hint.textContent = '点击朗读单词';
              doLookup(text.trim());
            }
          },
          () => {
            micBtn.classList.remove('listening');
            hint.textContent = '点击朗读单词';
          }
        );
        micBtn.classList.add('listening');
        hint.textContent = '正在听…（再按一次停止）';
      }
    });
  }

  // Text search
  searchBtn.addEventListener('click', () => {
    const q = input.value.trim();
    if (q) doLookup(q);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q) doLookup(q);
    }
  });

  setLookupResult(placeholderHTML());
}

async function doLookup(query) {
  setLookupResult(loadingHTML());
  try {
    const result = await lookupWord(query);
    const existing = findByEnglish(result.word);
    if (!existing) {
      const word = createWord(result.word, result.chineseDefinition, result.phonetic);
      await addWord(word);
      setLookupResult(resultHTML(result, true));
    } else {
      setLookupResult(resultHTML(result, false, true));
    }
  } catch (err) {
    setLookupResult(errorHTML(err.message));
  }
}

function setLookupResult(html) {
  document.getElementById('lookup-result').innerHTML = html;
}

function resultHTML(result, justAdded, alreadyIn = false) {
  const phonetic = result.phonetic ? `<p class="result-phonetic">/${result.phonetic}/</p>` : '';
  let status = '';
  if (justAdded) {
    status = `<div class="result-status">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>已加入生词本
    </div>`;
  } else if (alreadyIn) {
    status = `<div class="result-status">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>已在生词本中
    </div>`;
  }
  return `<div class="result-card">
    <p class="result-word">${esc(result.word)}</p>
    ${phonetic}
    <hr class="result-divider">
    <p class="result-definition">${esc(result.chineseDefinition)}</p>
    ${status}
  </div>`;
}

function loadingHTML() {
  return `<div class="loading-card"><div class="spinner"></div>查询中…</div>`;
}

function errorHTML(msg) {
  return `<div class="error-card">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
      <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>${esc(msg)}
  </div>`;
}

function placeholderHTML() {
  return `<div class="placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <p>朗读或输入英文单词<br>马上查到中文意思</p>
  </div>`;
}

// ════════════════════════════════════════════
// 8. NOTEBOOK VIEW
// ════════════════════════════════════════════
function initNotebook() {
  document.getElementById('add-btn').addEventListener('click', openAddModal);
  document.getElementById('notebook-search').addEventListener('input', renderNotebook);
}

function renderNotebook() {
  const q = document.getElementById('notebook-search').value.toLowerCase();
  const filtered = words.filter(w =>
    !q || w.english.includes(q) || w.chineseDefinition.toLowerCase().includes(q)
  );

  const active = filtered.filter(w => !isMastered(w));
  const mastered = filtered.filter(w => isMastered(w));
  const list = document.getElementById('notebook-list');

  if (words.length === 0) {
    list.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
      </svg>
      <h3>生词本还是空的</h3>
      <p>去查词页面查一个单词<br>它会自动保存到这里</p>
    </div>`;
    return;
  }

  let html = '';
  if (active.length) {
    html += `<p class="section-title">学习中 · ${active.length} 个</p>`;
    html += active.map(wordRowHTML).join('');
  }
  if (mastered.length) {
    html += `<p class="section-title" style="margin-top:12px">已掌握 · ${mastered.length} 个</p>`;
    html += mastered.map(wordRowHTML).join('');
  }
  if (!active.length && !mastered.length) {
    html = `<p style="color:var(--text-secondary);text-align:center;padding:40px 0">没有匹配的单词</p>`;
  }
  list.innerHTML = html;

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (confirm(`确定删除「${btn.dataset.word}」吗？`)) {
        await removeWord(btn.dataset.id);
        renderNotebook();
      }
    });
  });
}

function wordRowHTML(word) {
  const days = daysUntil(word);
  let meta = '';
  if (!isMastered(word)) {
    meta = days === 0
      ? `<p class="word-row-meta due">今天复习</p>`
      : `<p class="word-row-meta later">${days} 天后复习</p>`;
  }
  return `<div class="word-row">
    <div class="word-row-info">
      <p class="word-row-english">${esc(word.english)}</p>
      <p class="word-row-chinese">${esc(word.chineseDefinition)}</p>
      ${meta}
    </div>
    <span class="stage-chip ${stageClass(word)}">${stageLabel(word)}</span>
    <button class="delete-btn" data-id="${word.id}" data-word="${esc(word.english)}" aria-label="删除">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14H6L5 6"/>
        <path d="M10 11v6M14 11v6"/>
        <path d="M9 6V4h6v2"/>
      </svg>
    </button>
  </div>`;
}

// ── Manual add modal ──
function initModal() {
  document.getElementById('cancel-add').addEventListener('click', closeAddModal);
  document.getElementById('add-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('add-modal')) closeAddModal();
  });

  document.getElementById('auto-lookup-btn').addEventListener('click', async () => {
    const eng = document.getElementById('add-english').value.trim();
    if (!eng) return;
    document.getElementById('auto-lookup-btn').textContent = '查询中…';
    try {
      const result = await lookupWord(eng);
      document.getElementById('add-chinese').value = result.chineseDefinition;
      document.getElementById('add-error').classList.add('hidden');
    } catch (err) {
      document.getElementById('add-error').textContent = err.message;
      document.getElementById('add-error').classList.remove('hidden');
    }
    document.getElementById('auto-lookup-btn').textContent = '自动查询释义';
  });

  document.getElementById('confirm-add').addEventListener('click', async () => {
    const eng = document.getElementById('add-english').value.trim();
    const chi = document.getElementById('add-chinese').value.trim();
    if (!eng || !chi) return;
    if (findByEnglish(eng)) {
      document.getElementById('add-error').textContent = '这个单词已经在生词本里了';
      document.getElementById('add-error').classList.remove('hidden');
      return;
    }
    await addWord(createWord(eng, chi));
    closeAddModal();
    if (currentTab === 'notebook') renderNotebook();
  });
}

function openAddModal() {
  document.getElementById('add-english').value = '';
  document.getElementById('add-chinese').value = '';
  document.getElementById('add-error').classList.add('hidden');
  document.getElementById('add-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('add-english').focus(), 100);
}

function closeAddModal() {
  document.getElementById('add-modal').classList.add('hidden');
}

// ════════════════════════════════════════════
// 9. REVIEW VIEW
// ════════════════════════════════════════════
let reviewQueue = [];
let reviewIndex = 0;
let reviewCorrect = 0;
let reviewFlipped = false;

function initReview() {}

function renderReview() {
  reviewQueue = words.filter(needsReview).sort(() => Math.random() - 0.5);
  reviewIndex = 0;
  reviewCorrect = 0;
  reviewFlipped = false;

  const body = document.getElementById('review-body');

  if (reviewQueue.length === 0) {
    const activeCount = words.filter(w => !isMastered(w)).length;
    body.innerHTML = `<div class="review-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      <h2>今天没有要复习的单词</h2>
      <p>${activeCount > 0
        ? `生词本里有 ${activeCount} 个单词学习中<br>根据艾宾浩斯计划，明天再来复习吧！`
        : '快去查词页面添加新单词吧'}</p>
    </div>`;
    return;
  }

  showReviewCard();
}

function showReviewCard() {
  if (reviewIndex >= reviewQueue.length) {
    showSessionDone();
    return;
  }

  reviewFlipped = false;
  const word = reviewQueue[reviewIndex];
  const body = document.getElementById('review-body');

  body.innerHTML = `
    <div class="progress-bar-wrap">
      <p class="progress-label">${reviewIndex + 1} / ${reviewQueue.length}</p>
      <div class="progress-track">
        <div class="progress-fill" style="width:${(reviewIndex + 1) / reviewQueue.length * 100}%"></div>
      </div>
    </div>

    <div class="flip-scene" id="flip-scene">
      <div class="flip-card" id="flip-card">
        <div class="flip-face flip-front">
          <p class="flip-word">${esc(word.english)}</p>
          ${word.phonetic ? `<p class="flip-phonetic">/${esc(word.phonetic)}/</p>` : ''}
          <span class="flip-stage">${stageLabel(word)}</span>
        </div>
        <div class="flip-face flip-back">
          <p class="flip-english-small">${esc(word.english)}</p>
          <p class="flip-chinese">${esc(word.chineseDefinition)}</p>
        </div>
      </div>
    </div>

    <p class="flip-tap-hint" id="flip-hint">点击卡片查看释义</p>

    <div class="answer-row hidden" id="answer-row">
      <button class="answer-btn btn-wrong" id="btn-wrong">✗ &nbsp;不认识</button>
      <button class="answer-btn btn-right" id="btn-right">✓ &nbsp;认识！</button>
    </div>
  `;

  document.getElementById('flip-scene').addEventListener('click', () => {
    if (!reviewFlipped) {
      reviewFlipped = true;
      document.getElementById('flip-card').classList.add('flipped');
      document.getElementById('flip-hint').textContent = '你认识这个单词吗？';
      document.getElementById('answer-row').classList.remove('hidden');
    }
  });

  document.getElementById('btn-wrong').addEventListener('click', () => answer(false));
  document.getElementById('btn-right').addEventListener('click', () => answer(true));
}

async function answer(correct) {
  const word = reviewQueue[reviewIndex];
  recordReview(word, correct);
  await updateWord(word);
  if (correct) reviewCorrect++;
  reviewIndex++;
  showReviewCard();
}

function showSessionDone() {
  const total = reviewQueue.length;
  const correct = reviewCorrect;
  const emoji = correct / total >= 0.9 ? '🎉' : correct / total >= 0.6 ? '👍' : '💪';

  document.getElementById('review-body').innerHTML = `
    <div class="session-done">
      <div class="session-emoji">${emoji}</div>
      <h2>本轮复习完成！</h2>
      <p>答对 ${correct} / ${total} 个</p>
      <button class="btn-primary-lg" id="restart-btn">再练一轮</button>
    </div>`;

  document.getElementById('restart-btn').addEventListener('click', renderReview);
}

// ════════════════════════════════════════════
// 10. UTILS
// ════════════════════════════════════════════
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ════════════════════════════════════════════
// 11. BOOT
// ════════════════════════════════════════════
async function boot() {
  await DB.init();
  await loadWords();

  initLookup();
  initNotebook();
  initModal();
  initReview();
  updateBadges();

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

boot();
