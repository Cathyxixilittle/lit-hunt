/* ============================================
   lit-hunt · script.js · v0.2
   关键词生成 + 搜索历史（localStorage）+ 收藏
   ============================================ */

(function () {
  'use strict';

  /* ====================== 数据层 ====================== */

  const STORAGE_KEYS = {
    history: 'lithunt.history.v1',
    saved: 'lithunt.saved.v1',
  };

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.history) || '[]'); }
    catch { return []; }
  }
  function saveHistory(arr) {
    try { localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(arr.slice(0, 30))); }
    catch {}
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.saved) || '[]'); }
    catch { return []; }
  }
  function saveSaved(arr) {
    try { localStorage.setItem(STORAGE_KEYS.saved, JSON.stringify(arr.slice(0, 50))); }
    catch {}
  }

  /* ====================== 关键词词典 ====================== */

  const EN_ZH = {
    '澳洲原住民': 'Aboriginal Australian',
    '原住民': 'Indigenous',
    '土著': 'Indigenous',
    '主流媒体': 'mainstream media',
    '媒体': 'media',
    '再现': 'representation',
    '再现方式': 'representation',
    '议题': 'discourse',
    '形象': 'imagery',
    '刻板印象': 'stereotype',
    '殖民': 'colonial',
    '后殖民': 'postcolonial',
    '白人': 'white',
    '白人特权': 'white privilege',
    '白人至上': 'white supremacy',
    '种族': 'race',
    '种族主义': 'racism',
    '身份': 'identity',
    '身份认同': 'identity',
    '文化': 'culture',
    '社会学': 'sociology',
    '民族志': 'ethnography',
    '田野调查': 'fieldwork',
    '访谈': 'interview',
    '话语': 'discourse',
    '话语分析': 'discourse analysis',
    '框架': 'framing',
    '新闻': 'journalism',
    '新闻业': 'journalism',
    '叙事': 'narrative',
    '政策': 'policy',
    '历史': 'history',
    '教育': 'education',
    '土地': 'land',
    '主权': 'sovereignty',
    '性别': 'gender',
    '女性主义': 'feminism',
    '阶级': 'class',
    '权力': 'power',
    '国家': 'state',
    '民族': 'nation',
    '民族主义': 'nationalism',
    '移民': 'migration',
    '难民': 'refugee',
    '环境': 'environment',
    '气候': 'climate',
    '经济': 'economy',
    '全球化': 'globalization',
    '技术': 'technology',
    '人工智能': 'artificial intelligence',
    '数据': 'data',
    '算法': 'algorithm',
  };

  const STOPWORDS_EN = new Set([
    'the','and','for','with','from','into','about','between',
    'how','what','why','when','where','which','who','does',
    'are','was','were','is','this','that','these','those',
    '我','你','他','她','的','了','是','在','和','与',
  ]);

  function extractZh(text) {
    const m = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    return Array.from(new Set(m));
  }
  function extractEn(text) {
    const cleaned = text.replace(/[\u4e00-\u9fa5]/g, ' ');
    const phrases = [];
    (cleaned.match(/"([^"]+)"|"([^"]+)"|'([^']+)'/g) || []).forEach(q => {
      const inner = q.replace(/['"]/g, '').trim();
      if (inner) phrases.push(inner);
    });
    const words = cleaned.toLowerCase().replace(/[^a-z0-9\s\-]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS_EN.has(w));
    return Array.from(new Set([...phrases, ...words]));
  }
  function zhToEn(text) {
    const out = new Set();
    for (const [zh, en] of Object.entries(EN_ZH)) {
      if (text.includes(zh)) out.add(en);
    }
    return Array.from(out);
  }

  function generateSuggestions(rawText, langs) {
    const text = (rawText || '').trim();
    if (!text) return [];
    const out = [];
    const wantZh = langs.includes('zh');
    const wantEn = langs.includes('en');
    const zhTerms = extractZh(text);
    const enTerms = extractEn(text);
    const translated = zhToEn(text);

    // 1. 原文（起步）
    if (text.length <= 80) {
      out.push({ tag: '原文', text: `"${text}"` });
    }

    // 2. 中文 OR
    if (wantZh && zhTerms.length >= 2) {
      out.push({ tag: '中文 OR', text: `(${zhTerms.slice(0, 4).join(' OR ')})` });
    } else if (wantZh && zhTerms.length === 1) {
      out.push({ tag: '中文', text: `"${zhTerms[0]}"` });
    }

    // 3. 英文 OR（如果原文含中文）
    if (wantEn && translated.length >= 2) {
      out.push({ tag: '英文 OR', text: `(${translated.map(t => `"${t}"`).join(' OR ')})` });
    } else if (wantEn && translated.length === 1) {
      out.push({ tag: 'English', text: `"${translated[0]}"` });
    } else if (wantEn && enTerms.length >= 2) {
      out.push({ tag: '英文 OR', text: `(${enTerms.slice(0, 4).map(t => `"${t}"`).join(' OR ')})` });
    }

    // 4. 跨语种 fallback
    if (translated.length === 0 && zhTerms.length > 0 && wantEn) {
      out.push({ tag: '中英', text: `"${zhTerms[0]}" AND "${enTerms[0] || 'Australia'}"` });
    }

    // 5. 年限
    if (out.length > 0) {
      out.push({
        tag: '筛选',
        text: `${out[0].text} AND PUB_YEAR > 2019`,
      });
    }

    return out.slice(0, 6);
  }

  /* ====================== Mock 文献 ====================== */

  // 简化的 mock 数据库，覆盖她可能的研究方向
  const MOCK_CORPUS = [
    {
      title: 'The White Possessive: Property, Power, and Indigenous Sovereignty',
      authors: 'Aileen Moreton-Robinson',
      year: 2015,
      source: 'Univ. of Minnesota Press',
      type: 'Book',
      abstract: '探讨白人占有性（white possessive）如何作为澳大利亚殖民结构中的核心组织原则，审视原住民主权、身份与土地之间的关系。',
      keywords: ['Indigenous', 'sovereignty', 'white privilege', 'Australia'],
    },
    {
      title: 'Indigenous Representation in Australian Print Media: A Critical Discourse Analysis',
      authors: 'Kerry McCallum, Holly Wei',
      year: 2022,
      source: 'Media, Culture & Society',
      type: 'Article',
      abstract: '通过批判性话语分析，审视 2015–2020 年间三家澳大利亚主流报纸如何再现原住民议题，揭示"受害者/威胁"的二元框架。',
      keywords: ['Indigenous', 'media', 'discourse', 'representation', 'Australia'],
    },
    {
      title: 'Decolonizing Methodologies: Research and Indigenous Peoples',
      authors: 'Linda Tuhiwai Smith',
      year: 2021,
      source: 'Zed Books',
      type: 'Book',
      abstract: '第二版。系统反思殖民主义对学术研究的影响，提出 25 项去殖民化的研究项目原则。',
      keywords: ['decolonization', 'Indigenous', 'methodology', 'research'],
    },
    {
      title: 'Settler Colonialism and the Politics of Collective Memory',
      authors: 'Lorenzo Veracini',
      year: 2023,
      source: 'Routledge',
      type: 'Article',
      abstract: '分析定居殖民（settler colonialism）作为独立政治结构的历史逻辑，并以澳洲、加拿大案例对比。',
      keywords: ['settler colonialism', 'history', 'sovereignty', 'Australia', 'Canada'],
    },
    {
      title: 'Aboriginal Self-Determination in Australia: Policy and Practice',
      authors: 'Dianne Kirby, Janet Sightholt',
      year: 2020,
      source: 'Australian Journal of Politics & History',
      type: 'Article',
      abstract: '梳理 1967 年公投以来澳大利亚原住民自决权政策的发展与实践困境。',
      keywords: ['Indigenous', 'policy', 'sovereignty', 'self-determination', 'Australia'],
    },
    {
      title: 'White Fragility and the Discourse of Race in the Workplace',
      authors: 'Robin DiAngelo, Özlem Sensoy',
      year: 2019,
      source: 'International Journal of Critical Diversity Studies',
      type: 'Article',
      abstract: '借用白人脆弱性（white fragility）概念，分析职场与教育场域中关于种族的回避性话语结构。',
      keywords: ['white fragility', 'race', 'discourse', 'education'],
    },
    {
      title: 'The Colonial Gaze in Mainstream News: Aboriginal Australia on Screen',
      authors: 'Katherine Aigner',
      year: 2018,
      source: 'Journal of Australian Studies',
      type: 'Article',
      abstract: '对 2000–2016 年间澳大利亚新闻中的原住民影像进行视觉分析，提出"殖民凝视"作为再现模式。',
      keywords: ['representation', 'media', 'Indigenous', 'visual analysis', 'Australia'],
    },
    {
      title: 'Critical Race Theory in Education: A Scholar\'s Journey',
      authors: 'Gloria Ladson-Billings',
      year: 2021,
      source: 'Teachers College Press',
      type: 'Book',
      abstract: '回顾批判种族理论在教育研究中的兴起与争议，以及作者作为黑人女性学者的学术实践。',
      keywords: ['critical race theory', 'education', 'race', 'pedagogy'],
    },
  ];

  // 简单打分：匹配关键词越多越排前
  function mockSearch(query) {
    const q = (query || '').toLowerCase();
    const qTokens = new Set([
      ...extractZh(q),
      ...extractEn(q),
      ...zhToEn(q),
    ].map(s => s.toLowerCase()));

    const scored = MOCK_CORPUS.map(paper => {
      let score = 0;
      const text = [
        paper.title,
        paper.authors,
        paper.abstract,
        ...paper.keywords,
      ].join(' ').toLowerCase();

      qTokens.forEach(t => {
        if (t && text.includes(t)) score += 1;
        if (paper.keywords.some(k => k.toLowerCase() === t)) score += 2; // 关键词命中加权
      });

      return { ...paper, _score: score };
    });

    return scored.filter(p => p._score > 0).sort((a, b) => b._score - a._score);
  }

  /* ====================== DOM 引用 ====================== */

  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);

  const $topic = $('#topic');
  const $form = $('#searchForm');
  const $status = $('#searchStatus');
  const $statusText = $status.querySelector('.searchbox__status-text');
  const $dot = $status.querySelector('.dot');
  const $langChips = $$('.chip[data-lang]');
  const $yearChips = $$('.chip[data-year]');
  const $suggestions = $('#suggestions');
  const $results = $('#results');
  const $suggestionMeta = $('#suggestionMeta');
  const $resultMeta = $('#resultMeta');
  const $resultSource = $('#resultSource');
  const $history = $('#history');
  const $saved = $('#saved');
  const $savedCount = $('#savedCount');
  const $clearHistory = $('#clearHistory');
  const $toast = $('#toast');

  let currentLangs = ['zh', 'en'];
  let currentYear = '5y';
  let currentSession = null;

  /* ====================== 状态管理 ====================== */

  function setStatus(state, text) {
    $dot.className = 'dot dot--' + state;
    $statusText.textContent = text;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ====================== 渲染 ====================== */

  function renderSuggestions(items) {
    if (!items.length) {
      $suggestions.innerHTML = '<p class="block__empty">没有可建议的关键词。试着更具体地描述你的研究问题。</p>';
      $suggestionMeta.textContent = '0 条';
      return;
    }
    $suggestionMeta.textContent = items.length + ' 条';
    $suggestions.innerHTML = items.map((it, i) => `
      <div class="suggestion" style="animation-delay:${0.04 + i * 0.05}s">
        <div class="suggestion__head">
          <span class="suggestion__tag">${escapeHtml(it.tag)}</span>
          <button class="suggestion__star" data-save="kw::${escapeHtml(it.text)}" aria-label="收藏" type="button">☆</button>
        </div>
        <div class="suggestion__text">${escapeHtml(it.text)}</div>
        <button class="suggestion__copy" data-copy="${escapeHtml(it.text).replace(/"/g, '&quot;')}" type="button">复制</button>
      </div>
    `).join('');
    bindSuggestionActions();
  }

  function renderResults(papers) {
    if (!papers.length) {
      $results.innerHTML = '<p class="block__empty">当前 mock 数据库里没有匹配项。试试更宽泛的词，或接 Crossref / OpenAlex API。</p>';
      $resultMeta.textContent = '0 条';
      return;
    }
    $resultMeta.textContent = papers.length + ' 条';
    $results.innerHTML = papers.map((p, i) => `
      <div class="result" style="animation-delay:${0.04 + i * 0.05}s">
        <div class="result__head">
          <span class="result__source">${escapeHtml(p.source)} · ${escapeHtml(p.type)}</span>
          <button class="result__star" data-save="paper::${escapeHtml(p.title)}" aria-label="收藏" type="button">☆</button>
        </div>
        <h4 class="result__title">${escapeHtml(p.title)}</h4>
        <p class="result__meta">
          <span>${escapeHtml(p.authors)}</span>
          <span class="sep">·</span>
          <span class="year">${p.year}</span>
          <span class="sep">·</span>
          <span class="cited">mock data</span>
        </p>
        <p class="result__abstract result__abstract--clamp">${escapeHtml(p.abstract)}</p>
        <div class="result__actions">
          <button class="result__btn" data-copy="${escapeHtml(p.title).replace(/"/g, '&quot;')}" type="button">复制标题</button>
          <button class="result__btn" data-action="cite" type="button">加入引用</button>
        </div>
      </div>
    `).join('');
    bindResultActions();
  }

  function renderHistory() {
    const items = loadHistory();
    if (!items.length) {
      $history.innerHTML = '<li class="history__empty">还没有搜索记录。<br/>在右边输入你的第一个问题。</li>';
      return;
    }
    $history.innerHTML = items.map(it => `
      <li class="history__item" data-id="${it.id}">
        <div class="history__item-query">${escapeHtml(it.query)}</div>
        <div class="history__item-meta">
          <span>${formatTime(it.ts)}</span>
          <span class="sep">·</span>
          <span>${it.suggestionCount}kw / ${it.resultCount}res</span>
        </div>
        <button class="history__item-del" data-del="${it.id}" aria-label="删除这条" type="button">×</button>
      </li>
    `).join('');

    // 绑定点击
    $history.querySelectorAll('.history__item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.history__item-del')) return;
        const id = el.dataset.id;
        const item = loadHistory().find(x => x.id === id);
        if (!item) return;
        $topic.value = item.query;
        currentSession = id;
        markActiveHistory(id);
        doSearch(false); // 不重新记录
        // 滚到搜索区
        document.getElementById('search').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    $history.querySelectorAll('.history__item-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.del;
        const arr = loadHistory().filter(x => x.id !== id);
        saveHistory(arr);
        renderHistory();
        if (currentSession === id) currentSession = null;
      });
    });
  }

  function renderSaved() {
    const items = loadSaved();
    $savedCount.textContent = items.length;
    if (!items.length) {
      $saved.innerHTML = '<li class="history__empty">在搜索结果或建议词上点 ☆ 即可收藏。</li>';
      return;
    }
    $saved.innerHTML = items.map(it => `
      <li class="saved__item" data-id="${it.id}">
        <div class="history__item-query">
          <span class="saved__item-star">★</span>${escapeHtml(it.preview)}
        </div>
        <div class="history__item-meta">
          <span>${formatTime(it.ts)}</span>
          <span class="sep">·</span>
          <span>${escapeHtml(it.kind)}</span>
        </div>
        <button class="history__item-del" data-unsave="${it.id}" aria-label="取消收藏" type="button">×</button>
      </li>
    `).join('');

    $saved.querySelectorAll('.saved__item').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('.history__item-del')) return;
        // 如果是关键词，复制到剪贴板
        const id = el.dataset.id;
        const item = loadSaved().find(x => x.id === id);
        if (item && item.kind === '关键词') {
          copyToClipboard(item.full);
          showToast('关键词已复制');
        }
      });
    });
    $saved.querySelectorAll('[data-unsave]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.unsave;
        saveSaved(loadSaved().filter(x => x.id !== id));
        renderSaved();
        showToast('已取消收藏');
      });
    });
  }

  function markActiveHistory(id) {
    $history.querySelectorAll('.history__item').forEach(el => {
      el.classList.toggle('is-active', el.dataset.id === id);
    });
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* ====================== 收藏动作 ====================== */

  function toggleSave(kind, full, preview) {
    const arr = loadSaved();
    const id = kind + '::' + full;
    const existing = arr.find(x => x.id === id);
    if (existing) {
      saveSaved(arr.filter(x => x.id !== id));
      showToast('已取消收藏');
    } else {
      arr.unshift({
        id,
        kind,
        full,
        preview,
        ts: Date.now(),
      });
      saveSaved(arr);
      showToast('已收藏');
    }
    renderSaved();
    refreshStarStates();
  }

  function refreshStarStates() {
    const savedIds = new Set(loadSaved().map(x => x.id));
    document.querySelectorAll('[data-save]').forEach(btn => {
      const id = btn.dataset.save;
      btn.classList.toggle('is-saved', savedIds.has(id));
      btn.textContent = savedIds.has(id) ? '★' : '☆';
    });
  }

  /* ====================== 事件绑定 ====================== */

  function bindSuggestionActions() {
    $suggestions.querySelectorAll('.suggestion__copy').forEach(b => {
      b.addEventListener('click', () => {
        copyToClipboard(b.dataset.copy);
        showToast('关键词已复制');
      });
    });
    $suggestions.querySelectorAll('[data-save]').forEach(b => {
      b.addEventListener('click', () => {
        const full = b.dataset.save.replace(/^kw::/, '');
        toggleSave('关键词', full, full.length > 30 ? full.slice(0, 30) + '…' : full);
      });
    });
  }

  function bindResultActions() {
    $results.querySelectorAll('.result__btn[data-copy]').forEach(b => {
      b.addEventListener('click', () => {
        copyToClipboard(b.dataset.copy);
        showToast('标题已复制');
      });
    });
    $results.querySelectorAll('.result__btn[data-action=cite]').forEach(b => {
      b.addEventListener('click', () => {
        showToast('已加入引用队列（v0.3 上线正式功能）');
      });
    });
    $results.querySelectorAll('[data-save]').forEach(b => {
      b.addEventListener('click', () => {
        const full = b.dataset.save.replace(/^paper::/, '');
        toggleSave('文献', full, full.length > 30 ? full.slice(0, 30) + '…' : full);
      });
    });
  }

  $langChips.forEach(chip => {
    chip.addEventListener('click', () => {
      chip.classList.toggle('is-on');
      currentLangs = Array.from($langChips).filter(c => c.classList.contains('is-on')).map(c => c.dataset.lang);
      if (!currentLangs.length) {
        // 至少留一个
        chip.classList.add('is-on');
        currentLangs = [chip.dataset.lang];
      }
    });
  });

  $yearChips.forEach(chip => {
    chip.addEventListener('click', () => {
      $yearChips.forEach(c => c.classList.remove('is-on'));
      chip.classList.add('is-on');
      currentYear = chip.dataset.year;
    });
  });

  $clearHistory.addEventListener('click', () => {
    if (!confirm('确定要清空所有搜索记录吗？')) return;
    saveHistory([]);
    currentSession = null;
    renderHistory();
    showToast('搜索记录已清空');
  });

  /* ====================== 搜索 ====================== */

  function doSearch(record = true) {
    const query = $topic.value.trim();
    if (!query) {
      setStatus('idle', '请先输入研究问题');
      return;
    }
    setStatus('working', '正在检索…');

    // 模拟一点点延迟
    setTimeout(() => {
      const suggestions = generateSuggestions(query, currentLangs);
      const results = mockSearch(query);
      renderSuggestions(suggestions);
      renderResults(results);

      setStatus('done', `${suggestions.length} 条建议词 · ${results.length} 条结果`);

      if (record) {
        const arr = loadHistory();
        // 5 秒内同查询的旧记录 → 替换而非新增
        const recent = arr[0];
        if (recent && recent.query === query && (Date.now() - recent.ts) < 5000) {
          recent.year = currentYear;
          recent.langs = currentLangs;
          recent.suggestionCount = suggestions.length;
          recent.resultCount = results.length;
          recent.ts = Date.now();
          currentSession = recent.id;
        } else {
          const id = 'sess_' + Date.now().toString(36);
          arr.unshift({
            id,
            query,
            year: currentYear,
            langs: currentLangs,
            suggestionCount: suggestions.length,
            resultCount: results.length,
            ts: Date.now(),
          });
          currentSession = id;
        }
        saveHistory(arr);
        renderHistory();
        markActiveHistory(currentSession);
      } else {
        markActiveHistory(currentSession);
      }
    }, 380);
  }

  $form.addEventListener('submit', e => {
    e.preventDefault();
    doSearch(true);
  });

  $topic.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $form.requestSubmit();
    }
  });

  /* ====================== Citation 复制 ====================== */

  $$('.cite-cell').forEach(cell => {
    cell.addEventListener('click', async () => {
      const text = cell.querySelector('.cite-cell__text').innerText.trim();
      await copyToClipboard(text);
      cell.classList.add('is-copied');
      const tag = cell.querySelector('.cite-cell__tag');
      const original = tag.textContent;
      tag.textContent = '✓ 已复制';
      showToast('引用已复制');
      setTimeout(() => {
        cell.classList.remove('is-copied');
        tag.textContent = original;
      }, 1600);
    });
  });

  /* ====================== Toast ====================== */

  let toastTimer = null;
  function showToast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('is-shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('is-shown'), 1800);
  }

  /* ====================== 文件上传区 ====================== */

  const $dropzone = document.getElementById('dropzone');
  const $fileInput = document.getElementById('fileInput');
  const $uploadList = document.getElementById('uploadList');

  const UPLOADS_KEY = 'lit_hunt_uploads';

  function loadUploads() {
    try { return JSON.parse(localStorage.getItem(UPLOADS_KEY) || '[]'); }
    catch { return []; }
  }

  function saveUploads(arr) {
    localStorage.setItem(UPLOADS_KEY, JSON.stringify(arr));
  }

  function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'pdf') return '📕';
    if (['doc', 'docx'].includes(ext)) return '📄';
    return '📄';
  }

  function fileBadgeClass(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'badge--pdf';
    if (ext === 'docx') return 'badge--docx';
    if (ext === 'doc') return 'badge--doc';
    return 'badge--txt';
  }

  function badgeLabel(name) {
    return name.split('.').pop().toUpperCase();
  }

  function renderUploads() {
    const uploads = loadUploads();
    if (!uploads.length) {
      $uploadList.innerHTML = '';
      return;
    }
    $uploadList.innerHTML = uploads.map((f, i) => `
      <div class="upload-card" data-index="${i}">
        <div class="upload-card__icon">${fileIcon(f.name)}</div>
        <div class="upload-card__info">
          <p class="upload-card__name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</p>
          <div class="upload-card__meta">
            <span class="upload-card__badge ${fileBadgeClass(f.name)}">${badgeLabel(f.name)}</span>
            <span>${f.size > 1024 * 1024 ? Math.round(f.size / 1024 / 1024) + ' MB' : Math.round(f.size / 1024) + ' KB'}</span>
          </div>
        </div>
        <button class="upload-card__del" data-index="${i}" type="button" title="删除" aria-label="删除 ${escapeHtml(f.name)}">×</button>
      </div>
    `).join('');

    // 绑定删除
    $uploadList.querySelectorAll('.upload-card__del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        const uploads = loadUploads();
        uploads.splice(idx, 1);
        saveUploads(uploads);
        renderUploads();
        showToast('文件已删除');
      });
    });
  }

  function addFile(file) {
    const uploads = loadUploads();
    // 避免重复
    if (uploads.some(u => u.name === file.name && u.size === file.size)) {
      showToast('这个文件已经上传过了');
      return;
    }
    // 大小限制 20MB
    if (file.size > 20 * 1024 * 1024) {
      showToast('文件太大，请控制在 20MB 以内');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => {
      uploads.push({
        name: file.name,
        size: file.size,
        type: file.type,
        content: e.target.result, // base64
        ts: Date.now(),
      });
      saveUploads(uploads);
      renderUploads();
      showToast(`已添加：${file.name}`);
    };
    reader.readAsDataURL(file);
  }

  // 拖拽
  $dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    $dropzone.classList.add('dropzone--drag');
  });
  $dropzone.addEventListener('dragleave', e => {
    e.preventDefault();
    $dropzone.classList.remove('dropzone--drag');
  });
  $dropzone.addEventListener('drop', e => {
    e.preventDefault();
    $dropzone.classList.remove('dropzone--drag');
    const files = Array.from(e.dataTransfer.files);
    files.forEach(f => addFile(f));
  });

  // 点击触发 file input
  $dropzone.addEventListener('click', () => $fileInput.click());
  $dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $fileInput.click(); }
  });

  // 文件选择
  $fileInput.addEventListener('change', () => {
    Array.from($fileInput.files).forEach(f => addFile(f));
    $fileInput.value = ''; // reset so同一文件可以重复选
  });

  /* ====================== Clipboard ====================== */

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ====================== Init ====================== */

  renderHistory();
  renderSaved();
  renderUploads();
  setStatus('idle', '就绪');
  $topic.focus();

})();
