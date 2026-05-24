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

function starsHTML(word) {
  if (isMastered(word)) return `<span class="trophy-chip">🏆</span>`;
  const total = 6;
  const filled = word.reviewStage;
  let html = '<span class="stars">';
  for (let i = 0; i < total; i++) {
    html += i < filled
      ? `<span class="star-on">⭐</span>`
      : `<span class="star-off">⭐</span>`;
  }
  html += '</span>';
  return html;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ════════════════════════════════════════════
// 3. DICTIONARY API
// Google Translate（中文释义）+ Free Dictionary（音标 + 词性）
// 两个都是 CORS-enabled，直接浏览器调用，无需后端
// ════════════════════════════════════════════
const POS_MAP = {
  noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.',
  pronoun: 'pron.', preposition: 'prep.', conjunction: 'conj.',
  interjection: 'int.', determiner: 'det.',
};

async function lookupWord(query) {
  const word = query.toLowerCase().trim();
  if (!word) throw new Error('请输入单词');

  const [googleRes, dictRes] = await Promise.allSettled([
    fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(word)}`),
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`),
  ]);

  let translation = '';
  let phonetic = '';
  let posTags = [];

  // Google Translate → 中文释义
  if (googleRes.status === 'fulfilled' && googleRes.value.ok) {
    const data = await googleRes.value.json();
    translation = data?.[0]?.[0]?.[0] || '';
  }

  // Free Dictionary → 音标 + 词性
  if (dictRes.status === 'fulfilled' && dictRes.value.ok) {
    const data = await dictRes.value.json();
    if (Array.isArray(data) && data[0]) {
      phonetic = data[0].phonetic || data[0].phonetics?.find(p => p.text)?.text || '';
      const meanings = data[0].meanings || [];
      posTags = [...new Set(
        meanings.slice(0, 2).map(m => POS_MAP[m.partOfSpeech] || m.partOfSpeech + '.').filter(Boolean)
      )];
    }
  }

  if (!translation) throw new Error('找不到这个单词，请检查拼写是否正确');

  const posPrefix = posTags.length ? posTags.join('/') + ' ' : '';
  return { word, phonetic, chineseDefinition: posPrefix + translation };
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
    // 自动朗读单词
    speak(result.word);
  } catch (err) {
    setLookupResult(errorHTML(err.message));
  }
}

// ════════════════════════════════════════════
// TEXT-TO-SPEECH (用 iPad Safari 内置的语音合成)
// ════════════════════════════════════════════
function speak(word) {
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = 'en-US';
    utter.rate = 0.85;  // 稍慢一点,孩子听得清
    utter.pitch = 1.1;
    speechSynthesis.speak(utter);
  } catch (e) {}
}
// 暴露到全局,inline onclick 能调用
window.speak = speak;

function setLookupResult(html) {
  document.getElementById('lookup-result').innerHTML = html;
}

function resultHTML(result, justAdded, alreadyIn = false) {
  const phonetic = result.phonetic ? `<span class="result-phonetic">/${result.phonetic}/</span>` : '';
  let status = '';
  if (justAdded) {
    status = `<div class="result-status">🎉 加入生词本啦！</div>`;
  } else if (alreadyIn) {
    status = `<div class="result-status">✓ 已经在生词本里啦</div>`;
  }
  const wordEsc = esc(result.word);
  return `<div class="result-card">
    <div class="result-word-row">
      <p class="result-word">${wordEsc}</p>
      <button class="speak-btn" onclick="speak('${wordEsc}')" aria-label="再读一遍">🔊</button>
    </div>
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
  return `<div class="error-card">🙁 ${esc(msg)}</div>`;
}

function placeholderHTML() {
  return `<div class="placeholder">
    <div class="placeholder-emoji">🦊</div>
    <p>朗读或输入一个英文单词<br>我马上告诉你是什么意思！</p>
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
      <div class="empty-emoji">📖✨</div>
      <h3>生词本空空的</h3>
      <p>去查词页查一个单词吧<br>它会自动跑到这里！</p>
    </div>`;
    return;
  }

  let html = '';
  if (active.length) {
    html += `<p class="section-title">🌱 学习中 · ${active.length} 个</p>`;
    html += active.map(wordRowHTML).join('');
  }
  if (mastered.length) {
    html += `<p class="section-title" style="margin-top:14px">🏆 已掌握 · ${mastered.length} 个</p>`;
    html += mastered.map(wordRowHTML).join('');
  }
  if (!active.length && !mastered.length) {
    html = `<p style="color:var(--text-soft);text-align:center;padding:40px 0;font-weight:700">没找到这个单词 🔎</p>`;
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
  const isDue = !isMastered(word) && days === 0;
  let meta = '';
  if (!isMastered(word)) {
    meta = isDue
      ? `<p class="word-row-meta due">📣 今天要复习</p>`
      : `<p class="word-row-meta later">⏰ ${days} 天后复习</p>`;
  }
  const rowClass = isMastered(word) ? 'mastered' : (isDue ? 'due' : '');
  return `<div class="word-row ${rowClass}">
    <div class="word-row-info">
      <p class="word-row-english">${esc(word.english)}</p>
      <p class="word-row-chinese">${esc(word.chineseDefinition)}</p>
      ${meta}
    </div>
    ${starsHTML(word)}
    <button class="delete-btn" data-id="${word.id}" data-word="${esc(word.english)}" aria-label="删除">🗑️</button>
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
      <div class="review-empty-emoji">🌈</div>
      <h2>今天没有要复习的</h2>
      <p>${activeCount > 0
        ? `还有 ${activeCount} 个单词在学习中<br>明天再来挑战吧 💪`
        : '快去查词页面添加新单词吧 ✨'}</p>
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
          <div class="flip-stars">${starsHTML(word)}</div>
          <button class="speak-btn" style="margin-top:8px" onclick="event.stopPropagation();speak('${esc(word.english)}')" aria-label="朗读">🔊</button>
        </div>
        <div class="flip-face flip-back">
          <p class="flip-english-small">${esc(word.english)}</p>
          <p class="flip-chinese">${esc(word.chineseDefinition)}</p>
        </div>
      </div>
    </div>

    <p class="flip-tap-hint" id="flip-hint">👆 点击卡片看意思</p>

    <div class="answer-row hidden" id="answer-row">
      <button class="answer-btn btn-wrong" id="btn-wrong">😅 不认识</button>
      <button class="answer-btn btn-right" id="btn-right">😎 我认识！</button>
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
  const wasMasteredJustNow = !isMastered(word) && correct && word.reviewStage === 5;
  recordReview(word, correct);
  await updateWord(word);
  if (correct) {
    reviewCorrect++;
    celebrate(wasMasteredJustNow ? 60 : 20);
  }
  reviewIndex++;
  showReviewCard();
}

function showSessionDone() {
  const total = reviewQueue.length;
  const correct = reviewCorrect;
  const ratio = correct / total;
  const emoji = ratio >= 0.9 ? '🏆' : ratio >= 0.6 ? '🌟' : '💪';
  const msg = ratio >= 0.9 ? '你真是个小天才！' : ratio >= 0.6 ? '做得很棒！' : '继续加油！';

  document.getElementById('review-body').innerHTML = `
    <div class="session-done">
      <div class="session-emoji">${emoji}</div>
      <h2>${msg}</h2>
      <p>答对了 ${correct} / ${total} 个 🎯</p>
      <button class="btn-primary-lg" id="restart-btn">再来一轮 →</button>
    </div>`;

  document.getElementById('restart-btn').addEventListener('click', renderReview);
  celebrate(50);
}

// ─ Confetti celebration ─
function celebrate(count = 30) {
  const colors = ['#FF6B6B', '#FFD93D', '#6BCF7F', '#4ECDC4', '#A78BFA', '#FF9FB2', '#FFA726'];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = Math.random() * 100 + '%';
    c.style.background = colors[Math.floor(Math.random() * colors.length)];
    c.style.animationDelay = Math.random() * 0.4 + 's';
    c.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    c.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
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
