/* ============================================
   lit-hunt · edit.js
   Lovable-style 浮层编辑器
   流程：点 FAB 开编辑 → 点页面上元素选中 → 快捷按钮 / 大白话输入
        → 改 inline style → "发给 Coder" 整理成结构化清单复制到剪贴板
   ============================================ */

(function () {
  'use strict';

  // 启动标记
  console.log('[lit-hunt edit] ready');

  const state = {
    enabled: false,
    selected: null,
    changes: [],   // {selector, prop, from, to, kind, value}
  };

  /* ---------- 工具 ---------- */

  function describeSelector(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = (el.className && typeof el.className === 'string')
      ? '.' + el.className.trim().split(/\s+/).filter(Boolean).join('.')
      : '';
    return `${tag}${id}${cls}`.slice(0, 80);
  }

  function getCurrentStyles(el) {
    const cs = getComputedStyle(el);
    return {
      'font-size': cs.fontSize,
      'color': cs.color,
      'background-color': cs.backgroundColor,
      'font-weight': cs.fontWeight,
      'font-style': cs.fontStyle,
      'text-align': cs.textAlign,
      'display': cs.display,
      'padding': cs.padding,
      'border': cs.border,
      'box-shadow': cs.boxShadow,
    };
  }

  /* ---------- 选中元素 ---------- */

  function selectElement(el) {
    if (state.selected === el) return;
    if (state.selected) state.selected.classList.remove('edit-selected');
    state.selected = el;
    if (el) el.classList.add('edit-selected');
    renderSelected();
  }

  function renderSelected() {
    const info = document.getElementById('editSelectedInfo');
    if (!state.selected) {
      info.innerHTML = '<p class="edit-panel__hint">还没选中任何东西。<br/>在页面上点一下你想改的地方。</p>';
      return;
    }
    const el = state.selected;
    const desc = describeSelector(el);
    const s = getCurrentStyles(el);
    info.innerHTML = `
      <div class="edit-sel__head">
        <code class="edit-sel__tag">${escapeHtml(desc)}</code>
      </div>
      <dl class="edit-sel__styles">
        <div><dt>size</dt><dd>${s['font-size']}</dd></div>
        <div><dt>color</dt><dd>${s.color}</dd></div>
        <div><dt>bg</dt><dd>${s['background-color']}</dd></div>
        <div><dt>weight</dt><dd>${s['font-weight']}</dd></div>
        <div><dt>align</dt><dd>${s['text-align']}</dd></div>
        <div><dt>display</dt><dd>${s.display}</dd></div>
      </dl>
    `;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- 日志 ---------- */

  function log(msg, kind = 'ok') {
    const log = document.getElementById('editLog');
    const line = document.createElement('div');
    line.className = 'edit-log__line' + (kind === 'err' ? ' edit-log__line--err' : ' edit-log__line--ok');
    line.textContent = msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  /* ---------- 应用编辑 ---------- */

  const ACTIONS = {
    'size+':       { prop: 'font-size', mode: 'multiply', value: 1.2 },
    'size-':       { prop: 'font-size', mode: 'multiply', value: 0.85 },
    'color-ink':   { prop: 'color', mode: 'set', value: '#2B1F18' },
    'color-tea':   { prop: 'color', mode: 'set', value: '#CBAF98' },
    'color-red':   { prop: 'color', mode: 'set', value: '#A03B2C' },
    'color-margin':{ prop: 'color', mode: 'set', value: '#DBB9A4' },
    'bg-paper':    { prop: 'background-color', mode: 'set', value: '#FFFFFF' },
    'bg-tea':      { prop: 'background-color', mode: 'set', value: '#CBAF98' },
    'bg-pottery':  { prop: 'background-color', mode: 'set', value: '#E1D8C7' },
    'bold':        { prop: 'font-weight', mode: 'set', value: '700' },
    'normal':      { prop: 'font-weight', mode: 'set', value: '400' },
    'italic':      { prop: 'font-style', mode: 'set', value: 'italic' },
    'center':      { prop: 'text-align', mode: 'set', value: 'center' },
    'left':        { prop: 'text-align', mode: 'set', value: 'left' },
    'right':       { prop: 'text-align', mode: 'set', value: 'right' },
    'shadow':      { prop: 'box-shadow', mode: 'set', value: '0 4px 16px rgba(43, 31, 24, 0.15)' },
    'noshadow':    { prop: 'box-shadow', mode: 'set', value: 'none' },
    'hide':        { prop: 'display', mode: 'set', value: 'none' },
    'show':        { prop: 'display', mode: 'set', value: 'block' },
  };

  function applyAction(actionKey) {
    if (!state.selected) {
      log('✗ 先点页面上一个元素', 'err');
      return;
    }
    if (actionKey === 'delete') {
      const desc = describeSelector(state.selected);
      state.selected.remove();
      state.changes.push({ kind: 'delete', selector: desc });
      log(`✓ 已删除 ${desc}`);
      state.selected = null;
      renderSelected();
      return;
    }
    const a = ACTIONS[actionKey];
    if (!a) return;
    const el = state.selected;
    const before = getCurrentStyles(el)[a.prop];
    if (a.mode === 'multiply') {
      const num = parseFloat(before);
      const unit = before.replace(/[\d.\-]/g, '') || 'px';
      el.style[a.prop] = (num * a.value) + unit;
    } else {
      el.style[a.prop] = a.value;
    }
    const after = getComputedStyle(el)[a.prop];
    state.changes.push({
      kind: 'style',
      selector: describeSelector(el),
      prop: a.prop,
      from: before,
      to: after,
    });
    log(`✓ ${a.prop}: ${before} → ${after}`);
    renderSelected();
  }

  /* ---------- 大白话解析 ---------- */

  function parseFreeText(text) {
    const t = text.toLowerCase();
    // size
    if (/(大|大一点|更大|加大|放大|big(ger)?|increase|larger|放大点)/.test(t)) return 'size+';
    if (/(小|小一点|缩小|小点|small(er)?|decrease|smaller)/.test(t)) return 'size-';
    // color
    if (/(红色|红|警示|red|danger)/.test(t)) return 'color-red';
    if (/(茶|茶色|茶烟|棕|tea|brown)/.test(t)) return 'color-tea';
    if (/(页边|浅棕|页边褐|margin)/.test(t)) return 'color-margin';
    if (/(深|深色|黑|深棕|ink|dark|black)/.test(t)) return 'color-ink';
    // bg
    if (/(白底|白色|背景白|white|paper)/.test(t)) return 'bg-paper';
    if (/(茶色背景|茶底|bg tea)/.test(t)) return 'bg-tea';
    if (/(陶|素陶|米色|pottery|beige)/.test(t)) return 'bg-pottery';
    // weight
    if (/(加粗|粗|bold)/.test(t)) return 'bold';
    if (/(正常粗细|不粗|normal)/.test(t)) return 'normal';
    // italic
    if (/(斜体|斜|italic)/.test(t)) return 'italic';
    // align
    if (/(居中|center|中间)/.test(t)) return 'center';
    if (/(左|left|靠左)/.test(t)) return 'left';
    if (/(右|right|靠右)/.test(t)) return 'right';
    // shadow
    if (/(加阴影|阴影|投影|shadow)/.test(t)) return 'shadow';
    if (/(去阴影|没阴影|不要阴影|noshadow)/.test(t)) return 'noshadow';
    // visibility
    if (/(隐藏|不见|hide)/.test(t)) return 'hide';
    if (/(显示|出来|show)/.test(t)) return 'show';
    // delete
    if (/(删除|删掉|不要了|delete|remove)/.test(t)) return 'delete';
    return null;
  }

  /* ---------- 发给 Coder（结构化清单） ---------- */

  function buildChangeRequest() {
    if (!state.changes.length) {
      return '（还没有任何改动）';
    }
    const bySelector = {};
    state.changes.forEach(c => {
      if (!bySelector[c.selector]) bySelector[c.selector] = [];
      bySelector[c.selector].push(c);
    });

    const lines = ['【chenyu 在浏览器里改的，请照搬到 styles.css 里】', ''];
    Object.entries(bySelector).forEach(([sel, list]) => {
      lines.push(`→ ${sel}`);
      list.forEach(c => {
        if (c.kind === 'delete') {
          lines.push(`   删除这个元素（从 index.html 移除）`);
        } else {
          lines.push(`   ${c.prop}: ${c.from} → ${c.to}`);
        }
      });
      lines.push('');
    });
    lines.push('改完 commit + push。');
    return lines.join('\n');
  }

  async function sendToCoder() {
    const text = buildChangeRequest();
    try {
      await navigator.clipboard.writeText(text);
      log(`✓ 清单已复制（${state.changes.length} 处）。贴到对话里给我。`);
    } catch (e) {
      // 老浏览器 fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) {}
      document.body.removeChild(ta);
      log(`✓ 清单已复制（${state.changes.length} 处）。贴到对话里给我。`);
    }
  }

  /* ---------- 事件 ---------- */

  function setupEditMode() {
    const fab = document.getElementById('editFab');
    const panel = document.getElementById('editPanel');
    const closeBtn = document.getElementById('editClose');
    const input = document.getElementById('editInput');
    const form = document.getElementById('editForm');
    const reset = document.getElementById('editReset');
    const sendBtn = document.getElementById('editSend');
    const fabLabel = document.getElementById('editFabLabel');

    if (!fab || !panel) {
      console.warn('[edit] missing fab/panel — edit mode disabled');
      return;
    }

    function setEnabled(on) {
      state.enabled = on;
      document.body.classList.toggle('edit-mode', on);
      panel.hidden = !on;
      fab.classList.toggle('is-on', on);
      if (fabLabel) fabLabel.textContent = on ? 'Editing' : 'Edit';
      if (!on && state.selected) {
        state.selected.classList.remove('edit-selected');
        state.selected = null;
        renderSelected();
      }
    }

    let fabLastClick = 0;
    fab.addEventListener('click', e => {
      e.stopPropagation();
      // 防抖：双击（或自动化工具的 mousedown+mouseup 误判）只算一次
      const now = Date.now();
      if (now - fabLastClick < 250) return;
      fabLastClick = now;
      setEnabled(!state.enabled);
    });

    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      setEnabled(false);
    });

    // 点击页面元素选中（用 capture 拦截，但放过 panel/fab）
    document.addEventListener('click', e => {
      if (!state.enabled) return;
      if (e.target.closest('.edit-panel') || e.target.closest('.edit-fab')) return;
      e.preventDefault();
      e.stopPropagation();
      selectElement(e.target);
    }, true);

    // 快捷按钮
    document.querySelectorAll('[data-edit]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        applyAction(b.dataset.edit);
      });
    });

    // 自然语言输入
    form.addEventListener('submit', e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const action = parseFreeText(text);
      if (action) {
        applyAction(action);
        input.value = '';
      } else {
        log(`✗ 没听懂「${text}」— 试试：大一点 / 换红色 / 居中 / 加粗 / 隐藏 / 删除`, 'err');
      }
    });

    // 发给 Coder
    sendBtn.addEventListener('click', e => {
      e.stopPropagation();
      sendToCoder();
    });

    // 重置（刷新）
    reset.addEventListener('click', e => {
      e.stopPropagation();
      if (state.changes.length && !confirm('当前有 ' + state.changes.length + ' 处改动没提交。刷新会丢，确定吗？')) return;
      location.reload();
    });

    // 暴露 API 方便调试 / 编程触发
    window.litHuntEdit = {
      enable: () => setEnabled(true),
      disable: () => setEnabled(false),
      apply: applyAction,
      parse: parseFreeText,
      changes: () => state.changes,
      sendToCoder,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupEditMode);
  } else {
    setupEditMode();
  }
})();
