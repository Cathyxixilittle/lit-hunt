/* ============================================
   lit-hunt · script.js · v0.5
   关键词生成（AI + 规则兜底）+ 搜索历史 + 收藏
   ============================================ */

(function () {
  'use strict';
  try {
  /* ====================== MiniMax AI 关键词优化 ====================== */

  // MiniMax API Key（服务器注入，勿手动修改）
  const MINIMAX_API_KEY = 'sk-api-ztZGNnyqQCnbIXQ-ooEg7CI7LCjs5Vrujz1eoJdnQGXOWDoIOjUHfcWfklAIvZbGBzPx4W7Nfq0lKvfbQrxhvIxcrZN_h_7Y-2vStrPAx1boXTRF10BWijA';

  /* ====================== Semantic Scholar API（引用核验）====================== */

  const S2_VERIFY_LIMIT = 10;

  // Levenshtein 相似度计算
  function levenshteinSimilarity(a, b) {
    const s = String(a || '').toLowerCase().replace(/[^\w\s]/g, '');
    const t = String(b || '').toLowerCase().replace(/[^\w\s]/g, '');
    if (s === t) return 1;
    if (!s.length || !t.length) return 0;
    const m = s.length, n = t.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      }
    }
    const maxLen = Math.max(m, n);
    return maxLen === 0 ? 1 : 1 - d[m][n] / maxLen;
  }

  function fallbackVerification(paper, method, reason = '') {
    return {
      verified: false,
      similarity: 0,
      citationCount: paper.citedCount || 0,
      s2Id: '',
      venue: '',
      year: null,
      isOpenAccess: false,
      method,
      reason,
    };
  }

  /**
   * 用 Semantic Scholar API 核验一篇文献的真实性
   * 返回核验结果，包含 citationCount（用于更精准的排序）
   */
  async function verifyWithSemanticScholar(paper) {
    const title = paper.title || '';
    const doi = paper.doi || '';
    // 走 server.py 代理，绕过浏览器 CORS
    const S2_API = '/s2-proxy/graph/v1';
    const FIELDS = 'title,authors,year,externalIds,venue,publicationDate,citationCount,isOpenAccess';

    try {
      // 优先用 DOI 查询
      if (doi) {
        const res = await fetch(`${S2_API}/paper/DOI:${encodeURIComponent(doi)}?fields=${FIELDS}`, {
          headers: { Accept: 'application/json' },
        });
        if (res.status === 429) return fallbackVerification(paper, 's2_rate_limited', 'doi');
        if (res.ok) {
          const data = await res.json();
          const sim = levenshteinSimilarity(title, data.title || '');
          return {
            verified: sim >= 0.50,
            similarity: Math.round(sim * 100),
            citationCount: data.citationCount || 0,
            s2Id: data.paperId || '',
            venue: data.venue || '',
            year: data.year || null,
            isOpenAccess: data.isOpenAccess || false,
            method: 'doi',
          };
        }
      }
      // fallback：标题搜索
      const res = await fetch(
        `${S2_API}/paper/search?query=${encodeURIComponent(title)}&limit=3&fields=${FIELDS}`,
        { headers: { Accept: 'application/json' } }
      );
      if (res.status === 429) return fallbackVerification(paper, 's2_rate_limited', 'title');
      if (res.ok) {
        const data = await res.json();
        const results = data.data || [];
        // 取相似度最高的
        let best = null, bestSim = 0;
        for (const r of results) {
          const sim = levenshteinSimilarity(title, r.title || '');
          if (sim > bestSim) { bestSim = sim; best = r; }
        }
        if (best && bestSim >= 0.50) {
          return {
            verified: true,
            similarity: Math.round(bestSim * 100),
            citationCount: best.citationCount || 0,
            s2Id: best.paperId || '',
            venue: best.venue || '',
            year: best.year || null,
            isOpenAccess: best.isOpenAccess || false,
            method: 'title',
          };
        }
      }
    } catch (e) {
      return fallbackVerification(paper, 's2_error', e.message);
    }
    // 核验失败：用 OpenAlex 的引用量，降级
    return fallbackVerification(paper, 'openalex_fallback');
  }

  /**
   * 批量核验文献（只核验前几条，避免压垮 Semantic Scholar 匿名配额）
   * 同步更新结果区占位，让"状态文字"和"UI DOM 渲染"在 verify 期间也保持同步
   * （核验完由 doSearch 一次性 renderResults 覆盖占位）
   */
  async function verifyPapers(papers) {
    const results = [];
    const toVerify = papers.slice(0, S2_VERIFY_LIMIT);
    const $results = document.getElementById('results');
    for (let i = 0; i < toVerify.length; i++) {
      const p = toVerify[i];
      try {
        const verified = await verifyWithSemanticScholar(p);
        results.push({ ...p, _s2: verified });
      } catch(e) {
        results.push({ ...p, _s2: fallbackVerification(p, 'error_fallback', e.message) });
      }
      const n = i + 1;
      setStatus('working', `step4-verify(${n}/${toVerify.length})`);
      // 同步更新结果区 — 状态文字和 DOM 一起动
      if ($results) {
        $results.innerHTML = `<p class="block__empty">正在核验文献真实性… ${n}/${toVerify.length}<br/><span style="font-size:12px;color:var(--ink-4)">每篇约 1.2s 避免触发 Semantic Scholar 限流</span></p>`;
      }
      if (i < toVerify.length - 1) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }
    return results.concat(
      papers.slice(S2_VERIFY_LIMIT).map(p => ({
        ...p,
        _s2: fallbackVerification(p, 'not_verified_limit'),
      }))
    );
  }

  /* ====================== Evidence 层级分类 ======================= */

  /**
   * 根据论文标题 + 摘要 + 关键词推断 Evidence 层级
   * @returns 'systematic_review' | 'empirical' | 'theoretical' | 'mixed' | 'unknown'
   */
  function classifyEvidence(paper) {
    const text = [
      paper.title || '',
      paper.abstract || '',
      ...(paper.keywords || []),
    ].join(' ').toLowerCase();

    // 综述类关键词
    const reviewKws = [
      'review', 'meta-analysis', 'meta analysis', 'systematic review',
      'literature review', 'scoping review', 'integrative review', 'synthes',
      ' Cochrane', 'JBI', 'PRISMA', 'Cochrane review',
      '文献综述', '系统综述', '元分析', '综述',
    ];

    // 实证类关键词（方法/数据/统计相关）
    const empiricalKws = [
      'method', 'methodology', 'quantitative', 'qualitative', 'mixed method',
      'interview', 'survey', 'questionnaire', 'case study', 'experiment',
      'randomized', 'rct', 'control group', 'statistical', 'regression',
      'interview', 'focus group', 'ethnography', 'participant observation',
      'data analysis', 'findings', 'results', 'sample', 'participants',
      ' SPSS', ' ANOVA', ' t-test', ' p-value', 'significance',
      '访谈', '问卷', '调查', '实验', '定量', '定性', '混合方法',
      '样本', '参与者', '数据分析', '统计',
    ];

    // 理论/概念类关键词
    const theoreticalKws = [
      'theory', 'theoretical', 'conceptual', 'framework', 'model',
      'philosophical', 'discourse', 'critical analysis', 'argument',
      'propose', 'concept', 'definition', 'typology', 'taxonomy',
      '探讨', '理论', '概念框架', '分析框架', '论述', '思辨',
    ];

    const scoreR = reviewKws.filter(k => text.includes(k)).length;
    const scoreE = empiricalKws.filter(k => text.includes(k)).length;
    const scoreT = theoreticalKws.filter(k => text.includes(k)).length;

    const max = Math.max(scoreR, scoreE, scoreT);
    if (max === 0) return 'unknown';

    if (scoreR === max) return 'systematic_review';
    if (scoreE === max) return 'empirical';
    return 'theoretical';
  }

  const SYSTEM_PROMPT = `你是一个学术文献检索助手。根据用户输入的研究问题，识别核心概念，生成精准关键词并推荐奠基性文献。

请严格按以下 JSON 格式返回，不要有其他文字：
{
  "en_keywords": ["核心概念1", "核心概念2", "核心概念3"],
  "zh_keywords": ["对应中文1", "对应中文2", "对应中文3"],
  "alternative_phrasings": ["替代表达1", "替代表达2"],
  "related_topics": ["相关主题1", "相关主题2"],
  "canonical_scholars": ["学者姓名1", "学者姓名2"],
  "foundational_works": [
    {"title": "经典著作标题1", "author": "作者1", "year": 出版年},
    {"title": "经典著作标题2", "author": "作者2", "year": 出版年}
  ]
}

关键词筛选策略：
1. 识别研究问题的核心概念：提取研究对象和研究视角的关键名词/名词短语（如"Indigenous representation"、"媒体再现"）
2. 排除辅助性词语：不要使用"研究"、"分析"、"影响"、"方式"、"澳洲"这类通用词；它们不能帮助你找到精准文献
3. 优先名词短语：每个关键词必须是独立有意义的学术概念（如"ecologism"而非单独的"eco"）
4. 精确数量：en_keywords 只返回 3-5 个最核心的概念，不可贪多
5. 学术专用：关键词必须是学术数据库（OpenAlex/Web of Science/Scopus）能识别的标准术语

canonical_scholars：必须返回 2-4 位该领域最具影响力的学者英文全名
foundational_works：必须返回 2-4 本真实存在的该领域奠基性著作

只返回 JSON，不要任何解释`;

  async function callMiniMaxKeyword(rawQuestion) {
    if (!MINIMAX_API_KEY) {
      console.warn('MiniMax API Key 未配置');
      return null;
    }
    try {
      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 20000);
      const res = await fetch('https://api.minimaxi.com/v1/text/chatcompletion_v2', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MINIMAX_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'MiniMax-M3',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `研究问题：${rawQuestion}` },
          ],
          temperature: 0.3,
          max_tokens: 600,
        }),
      });
      clearTimeout(fetchTimeout);
      if (!res.ok) throw new Error(`API 错误: ${res.status}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      // 提取 JSON（可能有 markdown 包裹）
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      // 拿到 content 但没匹配到 JSON 块
      if (text && typeof showToast === 'function') {
        showToast('AI 没有返回结构化建议，已切换到规则建议');
      }
      return null;
    } catch (e) {
      console.error('MiniMax API 调用失败:', e);
      // 给用户友好提示（而不是只在控制台报错）
      if (typeof showToast === 'function') {
        if (e instanceof SyntaxError) {
          showToast('AI 返回格式异常，已切换到规则建议');
        } else if (e.name === 'AbortError' || /timeout/i.test(String(e?.message || ''))) {
          showToast('AI 响应超时，已切换到规则建议');
        } else {
          showToast('AI 暂时不可用，已切换到规则建议');
        }
      }
      return null;
    }
  }

  function showAiThinking(show) {
    const el = document.getElementById('aiThinking');
    if (el) el.hidden = !show;
  }

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
    '股价预测': 'stock price prediction',
    '股票预测': 'stock price prediction',
    '股价': 'stock price',
    '股票': 'stocks',
    '预测': 'forecasting',
    '估值': 'valuation',
    '市值': 'market capitalization',
    '财报': 'financial reports',
    '投资': 'investment',
  };

  const STOPWORDS_EN = new Set([
    'the','and','for','with','from','into','about','between',
    'how','what','why','when','where','which','who','does',
    'are','was','were','is','this','that','these','those',
    '我','你','他','她','的','了','是','在','和','与',
  ]);

  function extractZh(text) {
    if (typeof text !== 'string') alert('extractZh收到非字符串: ' + typeof text);
    const m = String(text || '').match(/[\u4e00-\u9fa5]{2,}/g) || [];
    return Array.from(new Set(m));
  }
  function extractEn(text) {
    if (typeof text !== 'string') alert('extractEn收到非字符串: ' + typeof text);
    const cleaned = String(text || '').replace(/[\u4e00-\u9fa5]/g, ' ');
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

  function uniqueTerms(items) {
    const seen = new Set();
    return items
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .filter(item => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function inferQueryIntent(text) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();
    const finance = /股价|股票|证券|估值|市值|投资|财报|营收|盈利|forecast|stock|share price|valuation|equity|financial/.test(lower);
    const companyEntity = /\banthropic\b|\bopenai\b|\bclaude\b|\bchatgpt\b|\bgoogle\b|\bnvidia\b|\bmicrosoft\b/.test(lower);
    return {
      finance,
      companyEntity,
      companyFinance: finance && companyEntity,
    };
  }

  function domainKeywordsFromQuery(text) {
    const intent = inferQueryIntent(text);
    if (intent.companyFinance) {
      return [
        'stock price prediction',
        'large language models',
        'financial forecasting',
        'AI company valuation',
      ];
    }
    if (intent.finance) {
      return uniqueTerms([
        ...zhToEn(text),
        'stock price prediction',
        'financial forecasting',
      ]);
    }
    return [];
  }

  function buildOpenAlexSearchTerms(rawText, aiResult) {
    const domainTerms = domainKeywordsFromQuery(rawText);
    const intent = inferQueryIntent(rawText);
    const aiTerms = uniqueTerms(aiResult?.en_keywords || []);
    if (intent.companyFinance && domainTerms.length) {
      return domainTerms.slice(0, 2);
    }
    return uniqueTerms([
      ...aiTerms,
      ...domainTerms,
      ...zhToEn(rawText),
      ...extractEn(rawText),
    ]).slice(0, 2);
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
    const domainTerms = domainKeywordsFromQuery(text);

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
    if (wantEn && domainTerms.length >= 2) {
      out.push({ tag: '英文 OR', text: `(${domainTerms.slice(0, 4).map(t => `"${t}"`).join(' OR ')})` });
    } else if (wantEn && translated.length >= 2) {
      out.push({ tag: '英文 OR', text: `(${translated.map(t => `"${t}"`).join(' OR ')})` });
    } else if (wantEn && (domainTerms.length === 1 || translated.length === 1)) {
      out.push({ tag: 'English', text: `"${domainTerms[0] || translated[0]}"` });
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

  /**
   * 用 AI 关键词 + 原始规则生成建议
   * aiResult: MiniMax 返回的 JSON（可能为 null）
   */
  function generateSuggestionsFromAI(rawText, langs, aiResult) {
    const text = (rawText || '').trim();
    if (!text) return [];
    const out = [];

    // AI 关键词池
    const aiEn = aiResult?.en_keywords || [];
    const aiZh = aiResult?.zh_keywords || [];
    const aiAlt = aiResult?.alternative_phrasings || [];
    const aiRelated = aiResult?.related_topics || [];
    const aiScholars = aiResult?.canonical_scholars || [];
    const aiFoundational = aiResult?.foundational_works || [];

    // 兜底：如果 AI 没返回足够词，用规则补充
    const zhTerms = extractZh(text);
    const enTerms = extractEn(text);
    const translated = zhToEn(text);
    const domainTerms = domainKeywordsFromQuery(text);

    // 中文关键词（只取核心的3-4个）
    const zhPool = aiZh.length > 0 ? aiZh : (zhTerms.length > 0 ? zhTerms : []);
    zhPool.slice(0, 4).forEach(zh => {
      out.push({ tag: '中文关键词', text: zh, lang: 'zh', source: 'ai' });
    });

    // EN关键词（只取核心的3-4个）
    const enPool = aiEn.length > 0
      ? uniqueTerms([...aiEn, ...domainTerms])
      : uniqueTerms(domainTerms.length > 0 ? domainTerms : enTerms.length > 0 ? enTerms : translated);
    enPool.slice(0, 4).forEach(en => {
      out.push({ tag: 'EN关键词', text: en, lang: 'en', source: 'ai' });
    });

    // AND 组合关键词（只取前2个核心概念）
    if (enPool.length >= 2) {
      out.push({ tag: 'AND 组合', text: `(${enPool.slice(0, 2).join(' AND ')})`, lang: 'en', source: 'ai' });
    }

    // 扩展表达
    if (aiAlt.length > 0) {
      out.push({ tag: '扩展表达', text: `(${aiAlt.slice(0, 3).join(' OR ')})`, lang: 'en', source: 'ai' });
    }

    // 相关主题
    if (aiRelated.length > 0) {
      out.push({ tag: '相关主题', text: `(${aiRelated.slice(0, 3).join(' OR ')})`, lang: 'en', source: 'ai' });
    }

    // 代表学者
    aiScholars.slice(0, 4).forEach(name => {
      out.push({ tag: '代表学者', text: name, lang: 'en', source: 'ai', scholar: true });
    });

    // 奠基著作
    aiFoundational.slice(0, 4).forEach(w => {
      out.push({
        tag: '奠基著作',
        text: w.title,
        sub: `${w.author} · ${w.year}`,
        lang: 'en',
        source: 'ai',
        foundational: true,
      });
    });

    return out.slice(0, 16);
  }

  /* ====================== OpenAlex 真实文献检索 ====================== */

  async function openAlexSearch(query, { year, type, citedCountMin } = {}) {
    // 构造年限过滤
    const yearMap = { '5y': '2020-2025', '10y': '2015-2025', '20y': '2005-2025', any: '' };
    const yearVal = yearMap[year] || yearMap['5y'];
    const yearFilter = yearVal ? `publication_year:${yearVal}` : '';

    // 构造类型过滤
    const typeFilter = type === 'review' ? 'type:review' :
                       type === 'article' ? 'type:journal-article' : '';

    // 构造引用量过滤（奠基文献用）
    const citedFilter = citedCountMin ? `cited_by_count:${citedCountMin}+` : '';

    // OpenAlex search：全字段搜索
    const params = new URLSearchParams({
      search: query,
      'per-page': '25',
      sort: 'relevance_score:desc',
    });
    const filters = [yearFilter, typeFilter, citedFilter].filter(Boolean);
    if (filters.length) params.set('filter', filters.join(','));

    const url = `https://api.openalex.org/works?${params.toString()}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      return (data.results || []).map(w => {
        // 重建 abstract
        let abstract = '';
        if (w.abstract_inverted_index) {
          const wordPositions = {};
          for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
            positions.forEach(pos => { wordPositions[pos] = word; });
          }
          abstract = Object.keys(wordPositions).sort((a, b) => a - b)
            .map(pos => wordPositions[pos]).join(' ');
        }

        // 作者（取前3个）
        const authors = (w.authorships || [])
          .slice(0, 3)
          .map(a => a.author?.display_name || '')
          .filter(Boolean)
          .join(', ');

        // 来源名称
        const source = w.primary_location?.source?.display_name || w.host_venue?.display_name || '';
        const publisher = w.primary_location?.source?.host_organization_name || '';
        const docType = w.type || '';
        const doi = w.doi ? w.doi.replace('https://doi.org/', '') : '';

        // 作者完整信息（用于学者搜索展示）
        const authorList = (w.authorships || []).map(a => ({
          name: a.author?.display_name || '',
          id: a.author?.id ? a.author.id.replace('https://openalex.org/', '') : '',
        }));

        return {
          title: w.title || '',
          authors,
          authorList,
          year: w.publication_year || '',
          source,
          publisher,
          type: docType,
          abstract: abstract.slice(0, 300),
          url: w.doi || w.id || '#',
          doi,
          citedCount: w.cited_by_count || 0,
        };
      });
    } catch (e) {
      console.error('OpenAlex 搜索失败:', e);
      return [];
    }
  }

  /**
   * 按学者姓名搜索该学者的文章
   */
  async function openAlexAuthorSearch(authorNames, keywordQuery, year) {
    const yearMap = { '5y': '2020-2025', '10y': '2015-2025', '20y': '2005-2025', any: '' };
    const yearVal = yearMap[year] || yearMap['5y'];
    const yearFilter = yearVal ? `publication_year:${yearVal}` : '';

    const results = [];
    for (const name of authorNames) {
      // OpenAlex 支持 author.display_name.search 过滤
      const params = new URLSearchParams({
        search: keywordQuery,
        'per-page': '10',
        sort: 'cited_by_count:desc',
      });
      const filters = [
        yearFilter,
        `author.display_name.search:${name.trim()}`,
      ].filter(Boolean);
      params.set('filter', filters.join(','));

      try {
        const res = await fetch(`https://api.openalex.org/works?${params.toString()}`);
        if (!res.ok) continue;
        const data = await res.json();
        const papers = (data.results || []).map(w => {
          let abstract = '';
          if (w.abstract_inverted_index) {
            const wordPositions = {};
            for (const [word, positions] of Object.entries(w.abstract_inverted_index)) {
              positions.forEach(pos => { wordPositions[pos] = word; });
            }
            abstract = Object.keys(wordPositions).sort((a, b) => a - b)
              .map(pos => wordPositions[pos]).join(' ');
          }
          const authors = (w.authorships || []).slice(0, 3)
            .map(a => a.author?.display_name || '').filter(Boolean).join(', ');
          const source = w.primary_location?.source?.display_name || '';
          const publisher = w.primary_location?.source?.host_organization_name || '';
          const doi = w.doi ? w.doi.replace('https://doi.org/', '') : '';
          const authorList = (w.authorships || []).map(a => ({
            name: a.author?.display_name || '',
            id: a.author?.id ? a.author.id.replace('https://openalex.org/', '') : '',
          }));
          return {
            title: w.title || '',
            authors,
            authorList,
            year: w.publication_year || '',
            source,
            publisher,
            type: w.type || '',
            abstract: abstract.slice(0, 300),
            url: w.doi || w.id || '#',
            doi,
            citedCount: w.cited_by_count || 0,
            scholarNote: name.trim(),
          };
        });
        results.push(...papers);
      } catch (e) {
        console.error(`学者搜索失败 [${name}]:`, e);
      }
    }
    // 去重 + 按引用量排序
    const seen = new Set();
    return results.filter(p => {
      if (seen.has(p.title)) return false;
      seen.add(p.title);
      return true;
    }).sort((a, b) => b.citedCount - a.citedCount);
  }

  /* ====================== Mock 文献（保留作降级）====================== */

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
        if (paper.keywords.some(k => String(k || '').toLowerCase() === t)) score += 2; // 关键词命中加权
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
  const $statusText = $status ? $status.querySelector('.searchbox__status-text') : null;
  const $dot = $status ? $status.querySelector('.dot') : null;
  const $langChips = $$('.chip[data-lang]');
  const $yearChips = $$('.chip[data-year]');
  const $typeChips = $$('.chip[data-type]');
  const $scholars = $('#scholars');
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
  let currentType = 'any';
  let currentSession = null;

  /* ====================== 设置面板 ====================== */

  // Zotero 配置（优先 localStorage，fallback 到 server /config）
  function loadZoteroConfig() {
    try {
      return JSON.parse(localStorage.getItem('lithunt_zotero') || '{}');
    } catch { return {}; }
  }
  function saveZoteroConfig(cfg) {
    localStorage.setItem('lithunt_zotero', JSON.stringify(cfg));
  }
  async function getServerZoteroConfig() {
    try {
      const res = await fetch('/config');
      if (res.ok) return await res.json();
    } catch {}
    return {};
  }

  // 打开/关闭设置面板（优先 localStorage，fallback server 配置）
  async function openSettings() {
    const local = loadZoteroConfig();
    const server = await getServerZoteroConfig();
    const userId = local.userId || server.zoteroUserId || '';
    const apiKey = local.apiKey || server.zoteroApiKey || '';
    $('#zoteroUserId').value = userId;
    $('#zoteroApiKey').value = apiKey;
    $('#zoteroLibraryType').value = local.libraryType || 'user';
    $('#zoteroGroupId').value = local.groupId || '';
    $('#zoteroGroupIdField').style.display = $('#zoteroLibraryType').value === 'group' ? '' : 'none';
    $('#zoteroTestResult').textContent = '';
    // 动态构建测试链接（用当前填入的值）
    updateTestLink();
    $('#settingsModal').hidden = false;
  }

  function updateTestLink() {
    const local = loadZoteroConfig();
    const uid = $('#zoteroUserId').value || local.userId || '';
    const key = $('#zoteroApiKey').value || local.apiKey || '';
    const lib = $('#zoteroLibraryType').value || 'user';
    const gid = $('#zoteroGroupId').value || '';
    const $link = $('#testZotero');
    if (uid && key) {
      $link.href = `/zotero-test?userId=${encodeURIComponent(uid)}&apiKey=${encodeURIComponent(key)}&libraryType=${encodeURIComponent(lib)}&groupId=${encodeURIComponent(gid)}`;
    } else {
      $link.href = '#';
    }
  }

  // 输入框变化时实时更新测试链接
  ['zoteroUserId','zoteroApiKey','zoteroLibraryType','zoteroGroupId'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateTestLink);
  });

  function closeSettings() {
    $('#settingsModal').hidden = true;
  }

  // 初始化设置按钮
  $('#openSettings').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', e => {
    if (e.target === $('#settingsModal')) closeSettings();
  });

  // Library type 切换
  $('#zoteroLibraryType').addEventListener('change', e => {
    $('#zoteroGroupIdField').style.display = e.target.value === 'group' ? '' : 'none';
  });

  /* ====================== Sidebar 抽屉（窄屏）====================== */

  function isNarrowViewport() {
    return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  }
  function openSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (sb) sb.classList.add('is-open');
    if (bd) {
      bd.hidden = false;
      // 强制 reflow 后加 class，让 transition 生效
      void bd.offsetWidth;
      bd.classList.add('is-shown');
    }
  }
  function closeSidebar() {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (sb) sb.classList.remove('is-open');
    if (bd) {
      bd.classList.remove('is-shown');
      // transition 完成后隐藏（避免占位）
      setTimeout(() => {
        if (bd && !bd.classList.contains('is-shown')) bd.hidden = true;
      }, 280);
    }
  }
  function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('is-open')) closeSidebar();
    else openSidebar();
  }
  const $toggleSidebar = document.getElementById('toggleSidebar');
  if ($toggleSidebar) {
    $toggleSidebar.addEventListener('click', toggleSidebar);
  }
  const $sidebarBackdrop = document.getElementById('sidebarBackdrop');
  if ($sidebarBackdrop) {
    $sidebarBackdrop.addEventListener('click', closeSidebar);
  }
  // 视口从窄变宽时自动关闭抽屉，避免状态残留
  if (window.matchMedia) {
    const mql = window.matchMedia('(max-width: 720px)');
    const onChange = e => { if (!e.matches) closeSidebar(); };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange); // Safari < 14
  }

  // 保存设置
  $('#saveSettings').addEventListener('click', () => {
    const cfg = {
      userId: $('#zoteroUserId').value.trim(),
      apiKey: $('#zoteroApiKey').value.trim(),
      libraryType: $('#zoteroLibraryType').value,
      groupId: $('#zoteroGroupId').value.trim(),
    };
    saveZoteroConfig(cfg);
    closeSettings();
    showToast('设置已保存');
  });

  /* ====================== 状态管理 ====================== */

  function setStatus(state, text) {
    $dot.className = 'dot dot--' + state;
    $statusText.textContent = text;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ====================== 渲染 ====================== */

  function renderSuggestions(items) {
    if (!items.length) {
      $suggestions.innerHTML = '<p class="block__empty">没有可建议的关键词。试着更具体地描述你的研究问题。</p>';
      $suggestionMeta.textContent = '0 条';
      return;
    }
    $suggestionMeta.textContent = items.length + ' 条';
    $suggestions.innerHTML = items.map((it, i) => {
      if (it.foundational) {
        // 奠基著作卡片：显示标题+作者年份
        return `
          <div class="suggestion suggestion--foundational" style="animation-delay:${0.04 + i * 0.05}s">
            <div class="suggestion__head">
              <span class="suggestion__tag">${escapeHtml(it.tag)}</span>
              <button class="suggestion__star" data-save="kw::${escapeHtml(it.text)}" aria-label="收藏" type="button">☆</button>
            </div>
            <div class="suggestion__body">
              <span class="suggestion__text suggestion__text--foundational">${escapeHtml(it.text)}</span>
              ${it.sub ? `<span class="suggestion__sub">${escapeHtml(it.sub)}</span>` : ''}
            </div>
            <div class="suggestion__foot">
              <button class="suggestion__copy" data-copy="${escapeHtml(it.text + (it.sub ? ' — ' + it.sub : '')).replace(/"/g, '&quot;')}" type="button">复制</button>
            </div>
          </div>`;
      }
      if (it.scholar) {
        // 代表学者卡片：显示学者名字+搜索该学者文章的按钮
        return `
          <div class="suggestion suggestion--scholar" style="animation-delay:${0.04 + i * 0.05}s">
            <div class="suggestion__head">
              <span class="suggestion__tag">${escapeHtml(it.tag)}</span>
              <button class="suggestion__star" data-save="kw::${escapeHtml(it.text)}" aria-label="收藏" type="button">☆</button>
            </div>
            <div class="suggestion__body">
              <span class="suggestion__text suggestion__text--scholar">${escapeHtml(it.text)}</span>
            </div>
            <div class="suggestion__foot">
              <button class="suggestion__copy" data-copy="${escapeHtml(it.text).replace(/"/g, '&quot;')}" type="button">复制</button>
            </div>
          </div>`;
      }
      return `
        <div class="suggestion" style="animation-delay:${0.04 + i * 0.05}s">
          <div class="suggestion__head">
            <span class="suggestion__tag">${escapeHtml(it.tag)}</span>
            <button class="suggestion__star" data-save="kw::${escapeHtml(it.text)}" aria-label="收藏" type="button">☆</button>
          </div>
          <div class="suggestion__body">
            <span class="suggestion__text">${escapeHtml(it.text)}</span>
          </div>
          <div class="suggestion__foot">
            <button class="suggestion__copy" data-copy="${escapeHtml(it.text).replace(/"/g, '&quot;')}" type="button">复制</button>
          </div>
        </div>`;
    }).join('');
    bindSuggestionActions();
  }

  function renderResults(papers) {
    if (!papers.length) {
      $results.innerHTML = '      <p class="block__empty">OpenAlex 找到的文献未通过核验，请尝试调整关键词或扩大年限范围。</p>';
      $resultMeta.textContent = '0 条';
      return;
    }
    const verifiedCount = papers.filter(p => p._s2?.verified).length;
    $resultMeta.textContent = `${papers.length} 条（S2 核验 ${verifiedCount}/${papers.length}）`;
    $results.innerHTML = papers.map((p, i) => {
      // 用 S2 引用量（更精准）
      const citedCount = p._s2?.citationCount || p.citedCount || 0;
      // 核验状态
      const s2Id = p._s2?.s2Id || '';
      const s2Venue = p._s2?.venue || '';
      // 来源期刊（优先用 S2 核验结果里的期刊名）
      const displaySource = s2Venue || p.source || '';
      // Evidence 层级
      const evLabel = { systematic_review: '综述', empirical: '实证', theoretical: '理论', mixed: '综述+实证', unknown: '未分类' }[p._evidence] || '';
      const evClass  = { systematic_review: 'result__badge--review', empirical: 'result__badge--empirical', theoretical: 'result__badge--theory', mixed: 'result__badge--review', unknown: '' }[p._evidence] || '';
      return `
      <div class="result${p._isScholarResult ? ' result--scholar' : ''}${p._s2?.verified ? ' result--verified' : ''}" style="animation-delay:${0.04 + i * 0.05}s">
        <div class="result__head">
          <div class="result__meta-left">
            ${p._isScholarResult ? `<span class="result__badge result__badge--scholar">学者推荐</span>` : ''}
            ${evLabel ? `<span class="result__badge ${evClass}" title="Evidence 层级：${evLabel}">📋 ${evLabel}</span>` : ''}
            ${displaySource ? `<span class="result__journal">${escapeHtml(displaySource)}</span>` : ''}
          </div>
          <div class="result__meta-right">
            ${citedCount ? `<span class="result__cited">被引 ${citedCount}</span>` : ''}
            <button class="result__star" data-save="paper::${escapeHtml(p.title)}" aria-label="收藏" type="button">☆</button>
          </div>
        </div>
        <h4 class="result__title">${p.url && p.url !== '#' ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>` : escapeHtml(p.title)}</h4>
        <p class="result__meta">
          <span>${escapeHtml(p.authors)}</span>
          <span class="sep">·</span>
          <span class="year">${p.year}</span>
          ${p.type ? `<span class="sep">·</span><span class="result__type">${escapeHtml(p.type)}</span>` : ''}
          ${p.doi ? `<span class="sep">·</span><a class="result__doi" href="https://doi.org/${escapeHtml(p.doi)}" target="_blank" rel="noopener">DOI: ${escapeHtml(p.doi)}</a>` : ''}
          ${s2Id ? `<span class="sep">·</span><a class="result__doi" href="https://www.semanticscholar.org/paper/${escapeHtml(s2Id)}" target="_blank" rel="noopener">S2</a>` : ''}
        </p>
        <p class="result__abstract result__abstract--clamp">${escapeHtml(p.abstract)}</p>
        <div class="result__actions">
          <button class="result__btn" data-copy="${escapeHtml(p.title).replace(/"/g, '&quot;')}" type="button">复制标题</button>
          <button class="result__btn" data-action="cite" type="button">加入引用</button>
          ${p.doi ? `<button class="result__btn result__btn--pdf" data-pdf="${escapeHtml(p.doi)}" type="button">下载 PDF</button>` : ''}
          <button class="result__btn result__btn--zotero" data-zotero="${escapeHtml(p.title).replace(/"/g, '&quot;')}" data-doi="${escapeHtml(p.doi || '')}" data-authors="${escapeHtml(p.authors || '')}" data-year="${escapeHtml(p.year || '')}" data-source="${escapeHtml(p.source || '')}" data-url="${escapeHtml(p.url || '')}" type="button">同步 Zotero</button>
        </div>
      </div>`;
    }).join('');
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
        startSearch(false); // 不重新记录
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
    $results.querySelectorAll('[data-pdf]').forEach(b => {
      b.addEventListener('click', async () => {
        const btn = b;
        const doi = btn.dataset.pdf;
        if (btn.disabled || btn.classList.contains('is-loading')) return;
        btn.disabled = true;
        btn.classList.add('is-loading');
        btn.textContent = '下载中…';
        try {
          const res = await fetch(`/download-pdf?doi=${encodeURIComponent(doi)}`);
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/pdf')) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('PDF 下载成功');
          } else {
            const json = await res.json();
            // server.py 保证 error 是 string；非 dict 时直接展示
            const msg = (json && (json.error || json.message)) || '下载失败，请稍后重试';
            showToast(typeof msg === 'string' ? msg : '下载失败，请稍后重试');
          }
        } catch (e) {
          // 不暴露任何 Python/JS 异常原文给用户
          console.error('PDF 下载失败:', e);
          showToast('下载出错，请稍后再试');
        } finally {
          btn.disabled = false;
          btn.classList.remove('is-loading');
          btn.textContent = '下载 PDF';
        }
      });
    });

    // Zotero 同步按钮
    $results.querySelectorAll('[data-zotero]').forEach(b => {
      b.addEventListener('click', async () => {
        const btn = b;
        if (btn.disabled || btn.classList.contains('is-loading')) return;
        const local = loadZoteroConfig();
        const server = await getServerZoteroConfig();
        const userId = local.userId || server.zoteroUserId || '';
        const apiKey = local.apiKey || server.zoteroApiKey || '';
        if (!userId || !apiKey) {
          showToast('请先在设置中配置 Zotero');
          openSettings();
          return;
        }
        btn.disabled = true;
        btn.classList.add('is-loading');
        btn.textContent = '同步中…';
        const payload = {
          title: btn.dataset.zotero,
          doi: btn.dataset.doi,
          authors: btn.dataset.authors,
          year: btn.dataset.year,
          source: btn.dataset.source,
          url: btn.dataset.url,
          userId: userId,
          apiKey: apiKey,
          libraryType: local.libraryType || 'user',
          groupId: local.groupId || '',
        };
        try {
          const res = await fetch('/zotero-add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const json = await res.json();
          if (json.ok) {
            showToast('✓ 已同步到 Zotero');
            btn.textContent = '已同步 ✓';
            btn.classList.add('result__btn--synced');
          } else {
            showToast(json.error || '同步失败');
            btn.textContent = '同步失败';
          }
        } catch {
          showToast('同步出错，请重试');
        } finally {
          if (!btn.classList.contains('result__btn--synced')) {
            btn.disabled = false;
            btn.classList.remove('is-loading');
            btn.textContent = '同步 Zotero';
          }
        }
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

  $typeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      $typeChips.forEach(c => c.classList.remove('is-on'));
      chip.classList.add('is-on');
      currentType = chip.dataset.type;
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

  async function doSearch(record = true) {
    const savedValue = $topic.value;
    const query = savedValue.trim();
    if (!query) {
      setStatus('idle', '请先输入研究问题');
      return;
    }
    setStatus('working', 'step1-ai');
    showAiThinking(true);

    let aiResult = null;
    try {
      const aiTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('AI超时')), 15000));
      aiResult = await Promise.race([callMiniMaxKeyword(query), aiTimeout]);
    } catch (err) {
      console.warn('AI 分析跳过:', err.message);
      aiResult = null;
    }

    try {
      setStatus('working', 'step2-suggestions');
      const suggestions = generateSuggestionsFromAI(query, currentLangs, aiResult);

      // 3. 用 AI 英文关键词组合做 OpenAlex 真实检索
      let results = [];
      let scholarResults = [];

      // 读取代表学者输入
      const scholarsInput = ($scholars.value || '').trim();
      const scholarNames = scholarsInput
        ? scholarsInput.split(/[,，]/).map(s => s.trim()).filter(Boolean)
        : (aiResult?.canonical_scholars || []).slice(0, 4);

        // 决定用哪个关键词做搜索（精简化：只用核心2个）
        const searchTerms = buildOpenAlexSearchTerms(query, aiResult);

      // 如果没有英文关键词，直接用原始查询
      if (searchTerms.length === 0) {
        searchTerms.push(query);
      }

      if (searchTerms.length > 0) {
        // 决定年限范围（奠基文献模式放宽到20年）
        const useYear = currentType === 'foundational' ? '20y' : currentYear;

        // 决定引用量阈值（奠基文献模式要求至少被引20次）
        const citedMin = currentType === 'foundational' ? 20 : 0;

        // 核心关键词搜索
        const searchOpts = { langs: currentLangs, year: useYear, type: currentType, citedCountMin: citedMin };
        const preciseQuery = searchTerms.join(' AND ');
        const looseQuery = searchTerms.join(' OR ');
        setStatus('working', 'step3-openalex(' + searchTerms.join(' AND ') + ')');
        const preciseResults = await openAlexSearch(preciseQuery, searchOpts);
        setStatus('working', 'step3-openalex done, found ' + preciseResults.length + ' papers');

        // 补一个宽松的 OR 搜索，然后合并去重（之前只在精确搜索 0 命中时才跑）
        const looseResults = await openAlexSearch(looseQuery, searchOpts);
        const seenA = new Set();
        results = [...preciseResults, ...looseResults].filter(p => {
          if (seenA.has(p.title)) return false;
          seenA.add(p.title);
          return true;
        }).slice(0, 30);
        setStatus('working', 'step3-openalex merged, ' + results.length + ' papers after dedup');

        // 按学者搜索（如果输入了学者或 AI 推荐了学者）
        if (scholarNames.length > 0) {
          scholarResults = await openAlexAuthorSearch(scholarNames, searchTerms.join(' OR '), useYear);
        }

        // 合并两批结果，去重
        console.log('[lit-hunt] 节点1 — OpenAlex=' + results.length + ' 篇，学者搜索=' + scholarResults.length + ' 篇');
        const allResults = [...results, ...scholarResults];
        const seen = new Set();
        const merged = allResults.filter(p => {
          if (seen.has(p.title)) return false;
          seen.add(p.title);
          return true;
        });

        // 双重排序：关键词匹配度优先，再按引用量
        const allKws = [...new Set(searchTerms.map(k => k.toLowerCase()))];
        const preSorted = merged
          .map(p => ({
            ...p,
            _matchScore: allKws.filter(kw => {
              const text = (String(p.title || '') + ' ' + String(p.abstract || '')).toLowerCase();
              return kw.split(' ').every(w => text.includes(w));
            }).length,
            _isScholarResult: scholarResults.some(s => s.title === p.title),
          }))
          .sort((a, b) => {
            // 学者结果优先
            if (b._isScholarResult !== a._isScholarResult) return b._isScholarResult ? 1 : -1;
            if (b._matchScore !== a._matchScore) return b._matchScore - a._matchScore;
            return b.citedCount - a.citedCount;
          });

        // 4. 用 Semantic Scholar API 核验每篇文献，并获取更精准的引用量
        results = await verifyPapers(preSorted);
        const verifiedCount = results.filter(p => p._s2?.verified).length;
        console.log('[lit-hunt] 节点2 — verifyPapers完成，进入=' + preSorted.length + ' 篇，验证通过=' + verifiedCount + ' 篇');

        // 5. 用 S2 引用量重新排序：关键词匹配度 > 核验状态 > 引用量
        results = results
          .map(p => ({
            ...p,
            _effectiveCitedCount: p._s2?.citationCount || p.citedCount || 0,
          }))
          .sort((a, b) => {
            if (b._isScholarResult !== a._isScholarResult) return b._isScholarResult ? 1 : -1;
            if (b._matchScore !== a._matchScore) return b._matchScore - a._matchScore;
            // 已核验的优先于未核验的
            if (b._s2?.verified !== a._s2?.verified) return b._s2?.verified ? 1 : -1;
            return b._effectiveCitedCount - a._effectiveCitedCount;
          });

        // 6. 给每篇论文贴 Evidence 层级标签（S2 验证仅供参考，失败不过滤）
        results = results.map(p => ({ ...p, _evidence: classifyEvidence(p) }));
      }

      showAiThinking(false);
      setStatus('working', 'step5-render');
      renderSuggestions(suggestions);
      console.log('[lit-hunt] 节点3 — 准备渲染，共 ' + results.length + ' 篇论文');
      renderResults(results);

      const aiTag = aiResult ? ' · AI 加持' : '';
      setStatus('done', `${suggestions.length} 条建议词${aiTag} · ${results.length} 条结果`);

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
    } catch (err) {
      showAiThinking(false);
      console.error('搜索出错:', err);
      setStatus('idle', '错误: ' + err.message);
      alert('搜索出错: ' + err.message + '\n\n详见浏览器控制台（F12）');
    }
  }

  let isSearching = false;
  const $searchBtn = document.getElementById('searchBtn');

  function setSearchBusy(busy) {
    if (!$searchBtn) return;
    $searchBtn.disabled = busy;
    $searchBtn.classList.toggle('is-loading', busy);
  }

  async function startSearch(record = true) {
    if (isSearching) return;
    const query = $topic.value.trim();
    if (!query) {
      setStatus('idle', '请先输入研究问题');
      return;
    }
    isSearching = true;
    setSearchBusy(true);
    setStatus('working', '正在检索…');
    // 清空上次结果——新搜索不等旧结果（避免建议词/结果区显示残留）
    if ($suggestions) {
      $suggestions.innerHTML = '<p class="block__empty">正在生成建议词…</p>';
      if ($suggestionMeta) $suggestionMeta.textContent = '…';
    }
    if ($results) {
      $results.innerHTML = '<p class="block__empty">正在检索 OpenAlex…</p>';
      if ($resultMeta) $resultMeta.textContent = '…';
    }
    try {
      await doSearch(record);
    } finally {
      isSearching = false;
      setSearchBusy(false);
    }
  }

  if ($searchBtn) {
    $searchBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      startSearch(true);
    });
  }

  $form.addEventListener('submit', e => {
    e.preventDefault();
    e.stopPropagation();
    startSearch(true);
  });

  $topic.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $form.requestSubmit();
    }
  });

  /* ====================== DOI 解析（引用格式速查）====================== */

  /**
   * 把 "Charles R." / "K. Jarrod" 拆成 "C. R." / "K. J."
   * 兼容 hyphen、点号、多段
   */
  function givenToInitials(given) {
    if (!given) return '';
    return String(given)
      .trim()
      .split(/\s+/)
      .map(part => {
        // 跳过 "van" / "de" 这类小品词？哈佛/APA 都不跳过，全转首字母即可
        const cleaned = part.replace(/[.,]/g, '');
        if (!cleaned) return '';
        return cleaned.charAt(0).toUpperCase() + '.';
      })
      .filter(Boolean)
      .join(' ');
  }

  /** APA 7：1-20 作者全列，21+ 缩成"前 19 + … + 最后"。 */
  function formatAPAAuthors(authors) {
    if (!authors || !authors.length) return '';
    const one = a => {
      const family = a.family || a.display || '';
      const init = givenToInitials(a.given);
      return init ? `${family}, ${init}` : family;
    };
    const arr = authors.map(one);
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]}, & ${arr[1]}`;
    if (arr.length <= 20) return `${arr.slice(0, -1).join(', ')}, & ${arr[arr.length - 1]}`;
    // 21+：前 19 + … + 最后
    return `${arr.slice(0, 19).join(', ')}, … ${arr[arr.length - 1]}`;
  }

  /** MLA 9：单作者 "Last, First"；多作者 "Last, First, et al." */
  function formatMLAAuthors(authors) {
    if (!authors || !authors.length) return '';
    const a = authors[0];
    const family = a.family || a.display || '';
    if (!a.given) return family;
    if (authors.length === 1) return `${family}, ${a.given}`;
    return `${family}, ${a.given}, et al.`;
  }

  /** Chicago 17（author-date）：1-10 作者全列，11+ 缩成"第 1 + … + 最后"。 */
  function formatChicagoAuthors(authors) {
    if (!authors || !authors.length) return '';
    const one = a => {
      const family = a.family || a.display || '';
      if (!a.given) return family;
      return `${family}, ${a.given}`;
    };
    const rest = a => {
      const family = a.family || a.display || '';
      return a.given ? `${family}, ${a.given}` : family;
    };
    if (authors.length === 1) return one(authors[0]);
    const first = one(authors[0]);
    if (authors.length <= 10) {
      const tail = authors.slice(1).map(rest);
      if (tail.length === 1) return `${first}, and ${tail[0]}`;
      return `${first}, ${tail.slice(0, -1).join(', ')}, and ${tail[tail.length - 1]}`;
    }
    // 11+：第 1 + … + 最后（其余省略）
    return `${first}, … ${rest(authors[authors.length - 1])}`;
  }

  /** Harvard：1-3 作者全列，4+ 缩成"第 1 + … + 最后"。 */
  function formatHarvardAuthors(authors) {
    if (!authors || !authors.length) return '';
    const one = a => {
      const family = a.family || a.display || '';
      const init = givenToInitials(a.given);
      return init ? `${family}, ${init}` : family;
    };
    const arr = authors.map(one);
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
    if (arr.length === 3) return `${arr[0]}, ${arr[1]} and ${arr[2]}`;
    // 4+：第 1 + … + 最后
    return `${arr[0]}, … ${arr[arr.length - 1]}`;
  }

  /** 判断是不是"书"（monograph/book/chapter）—— 没 container-title 兜底也算书 */
  function isBookLike(meta) {
    const t = (meta.type || '').toLowerCase();
    if (t === 'monograph' || t === 'book' || t === 'book-chapter' || t === 'book-part' || t === 'book-set') return true;
    // 没有 container-title、且有 publisher，大概率是书
    if (!meta.container && meta.publisher) return true;
    return false;
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  // 把 "123-145" 这种 en-dash 风格改成 "123–145"（仅 APA / Harvard 用）
  function pageRange(s) {
    if (!s) return '';
    return String(s).replace(/-/g, '–');
  }

  /**
   * APA 7
   * Author, A. A. (Year). Title. Journal, Volume(Issue), Pages. https://doi.org/xxx
   * Book:  Author, A. A. (Year). Title. Publisher. https://doi.org/xxx
   */
  function formatAPA(meta) {
    const author = formatAPAAuthors(meta.authors);
    const year = meta.year || 'n.d.';
    const title = meta.title || '(无题名)';
    const doi = meta.doi || '';
    if (isBookLike(meta)) {
      const pub = meta.publisher || '';
      let out = (author ? author + ' ' : '') + `(${year}). <em>${escapeHTML(title)}</em>.`;
      if (pub) out += ' ' + escapeHTML(pub) + '.';
      if (doi) out += ' ' + escapeHTML('https://doi.org/' + doi) + '.';
      return out;
    }
    const journal = meta.container || '';
    const vol = meta.volume || '';
    const iss = meta.issue || '';
    const page = pageRange(meta.page);
    let tail = '';
    if (journal) tail += ` <em>${escapeHTML(journal)}</em>`;
    if (vol) tail += `, ${escapeHTML(vol)}`;
    if (iss) tail += `(${escapeHTML(iss)})`;
    if (page) tail += `, ${escapeHTML(page)}`;
    return `${author ? author + ' ' : ''}(${year}). ${escapeHTML(title)}.${tail}.${doi ? ' ' + escapeHTML('https://doi.org/' + doi) : ''}`;
  }

  /**
   * MLA 9
   * Article: Last, First. "Title." Journal, vol. X, no. Y, Year, pp. PP–PP. doi:xxx
   * Book:    Last, First. Title. Publisher, Year.
   */
  function formatMLA(meta) {
    const author = formatMLAAuthors(meta.authors);
    const year = meta.year || '';
    const title = meta.title || '(无题名)';
    const doi = meta.doi || '';
    if (isBookLike(meta)) {
      const pub = meta.publisher || '';
      return `${author ? author.replace(/\.+\s*$/, '') + '. ' : ''}<em>${escapeHTML(title)}</em>.${pub ? ' ' + escapeHTML(pub) + ',' : ''}${year ? ' ' + year + '.' : ''}${doi ? ' doi:' + escapeHTML(doi) + '.' : ''}`;
    }
    const journal = meta.container || '';
    const vol = meta.volume || '';
    const iss = meta.issue || '';
    const page = pageRange(meta.page);
    const parts = [`<em>${escapeHTML(title)}</em>`];
    if (journal) parts.push(`<em>${escapeHTML(journal)}</em>`);
    let middle = '';
    if (vol) middle += `vol. ${escapeHTML(vol)}`;
    if (iss) middle += (middle ? ', ' : '') + `no. ${escapeHTML(iss)}`;
    if (year) middle += (middle ? ', ' : '') + year;
    if (page) middle += (middle ? ', ' : '') + `pp. ${escapeHTML(page)}`;
    if (middle) parts.push(middle);
    let out = '';
    if (author) out = author.replace(/\.+\s*$/, '') + '. ';
    out += `"${parts[0]}."`;
    if (parts.length > 1) {
      out += ' ' + parts.slice(1).join(', ');
    }
    if (!/[.!?]$/.test(out)) out += '.';
    if (doi) out += ' doi:' + escapeHTML(doi) + '.';
    return out;
  }

  /**
   * Chicago 17（author-date）
   * Article: Last, First. Year. "Title." Journal Volume (Issue): Pages. https://doi.org/xxx.
   * Book:    Last, First. Year. Title. Publisher.
   */
  function formatChicago(meta) {
    const author = formatChicagoAuthors(meta.authors);
    const year = meta.year || 'n.d.';
    const title = meta.title || '(无题名)';
    const doi = meta.doi || '';
    if (isBookLike(meta)) {
      const pub = meta.publisher || '';
      let out = (author ? author + '. ' : '') + `${year}. <em>${escapeHTML(title)}</em>.`;
      if (pub) out += ' ' + escapeHTML(pub) + '.';
      if (doi) out += ' ' + escapeHTML('https://doi.org/' + doi) + '.';
      return out;
    }
    const journal = meta.container || '';
    const vol = meta.volume || '';
    const iss = meta.issue || '';
    const page = pageRange(meta.page);
    let mid = '';
    if (journal) mid += ` <em>${escapeHTML(journal)}</em>`;
    if (vol) mid += ` ${escapeHTML(vol)}`;
    if (iss) mid += ` (${escapeHTML(iss)})`;
    if (page) mid += `: ${escapeHTML(page)}`;
    let out = '';
    if (author) {
      out = author.replace(/\.+\s*$/, '') + '. ';
    }
    out += `${year}. "${escapeHTML(title)}."${mid}.`;
    if (doi) out += ' ' + escapeHTML('https://doi.org/' + doi) + '.';
    return out;
  }

  /**
   * Harvard
   * Article: Last, F., Year. Title. Journal, Volume(Issue), pp. PP–PP. doi:xxx
   * Book:    Last, F. (Year) Title. Publisher.
   */
  function formatHarvard(meta) {
    const author = formatHarvardAuthors(meta.authors);
    const year = meta.year || 'n.d.';
    const title = meta.title || '(无题名)';
    const doi = meta.doi || '';
    if (isBookLike(meta)) {
      const pub = meta.publisher || '';
      let out = (author ? author + ' ' : '') + `(${year}) <em>${escapeHTML(title)}</em>.`;
      if (pub) out += ' ' + escapeHTML(pub) + '.';
      if (doi) out += ' ' + escapeHTML('https://doi.org/' + doi) + '.';
      return out;
    }
    const journal = meta.container || '';
    const vol = meta.volume || '';
    const iss = meta.issue || '';
    const page = pageRange(meta.page);
    let mid = '';
    if (journal) mid += ` <em>${escapeHTML(journal)}</em>`;
    if (vol) mid += `, ${escapeHTML(vol)}`;
    if (iss) mid += `(${escapeHTML(iss)})`;
    if (page) mid += `, pp. ${escapeHTML(page)}`;
    return `${author ? author + ' ' : ''}${year}. ${escapeHTML(title)}.${mid}.${doi ? ' doi:' + escapeHTML(doi) + '.' : ''}`;
  }

  // ====================== DOM ======================
  const $doiInput = document.getElementById('doiInput');
  const $doiBtn = document.getElementById('doiLookupBtn');
  const $doiStatus = document.getElementById('doiStatus');
  const $citeCells = $$('.cite-cell .cite-cell__text');
  const DOI_RE = /^10\.\d{4,9}\/\S+$/;

  function setDoiStatus(text, kind) {
    if (!$doiStatus) return;
    $doiStatus.textContent = text;
    $doiStatus.classList.remove('is-loading', 'is-error', 'is-ok');
    if (kind) $doiStatus.classList.add('is-' + kind);
  }

  function renderCiteTable(meta) {
    if (!$citeCells.length) return;
    const four = [
      formatAPA(meta),
      formatMLA(meta),
      formatChicago(meta),
      formatHarvard(meta),
    ];
    four.forEach((html, i) => {
      if ($citeCells[i]) $citeCells[i].innerHTML = html;
    });
  }

  async function doDoiLookup() {
    if (!$doiInput) return;
    const raw = ($doiInput.value || '').trim();
    if (!raw) {
      setDoiStatus('请先粘贴一个 DOI', 'error');
      showToast('请先粘贴一个 DOI');
      $doiInput.focus();
      return;
    }
    if (!DOI_RE.test(raw)) {
      setDoiStatus('DOI 格式不对，应是 10.xxxx/... 形式', 'error');
      showToast('DOI 格式不对，应是 10.xxxx/... 形式');
      $doiInput.focus();
      return;
    }

    $doiBtn.disabled = true;
    setDoiStatus('正在解析…', 'loading');
    try {
      const res = await fetch('/doi-lookup?doi=' + encodeURIComponent(raw));
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      if (!res.ok || !body || !body.ok) {
        const err = (body && body.error) || `HTTP ${res.status}`;
        setDoiStatus(err, 'error');
        showToast(err);
        return;
      }
      renderCiteTable(body.data);
      const authorLabel = (body.data.authors && body.data.authors[0] && (body.data.authors[0].family || body.data.authors[0].display)) || '佚名';
      setDoiStatus(`✓ 已生成 · ${authorLabel} (${body.data.year || 'n.d.'})`, 'ok');
      showToast('已生成 4 种引用格式');
    } catch (e) {
      const msg = 'DOI 解析失败：网络错误';
      setDoiStatus(msg, 'error');
      showToast(msg);
    } finally {
      $doiBtn.disabled = false;
    }
  }

  if ($doiBtn) $doiBtn.addEventListener('click', doDoiLookup);
  if ($doiInput) {
    $doiInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doDoiLookup();
      }
    });
  }
  // 示例 DOI 链接：点一下自动填
  $$('.doi-box__sample').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      if (!$doiInput) return;
      $doiInput.value = a.dataset.doi || '';
      $doiInput.focus();
      doDoiLookup();
    });
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

  // 兼容外部调用；所有入口都走同一把搜索锁。
  window.__doSearch = startSearch;

  } catch(e) {
    document.body.insertAdjacentHTML('beforeend',
      '<div style="position:fixed;top:0;left:0;right:0;background:#fee;border-bottom:3px solid #c00;padding:12px;font-family:monospace;font-size:14px;z-index:99999;color:#c00">' +
      '<b>SCRIPT ERROR:</b> ' + e.message + '</div>');
  }

})();
