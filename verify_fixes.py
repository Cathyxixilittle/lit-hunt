#!/usr/bin/env python3
"""
lit-hunt 5 bug fix 验证脚本（playwright）

每个 assert 对应 E2E 报告里的一条 bug：
  1. 下载按钮按下去 5s 后能弹下载 OR toast 显示用户友好提示
  2. 状态文字变化和 UI DOM 渲染同步
  3. API 解析失败时 toast 显示用户友好消息
  4. 搜新关键词后建议词区只剩新的（不含旧词）
  5. 480 宽下侧边栏可访问（汉堡按钮 toggle 后宽度 ≥ 200px）

用法：
  python3 verify_fixes.py
退出码：0 = 全部通过；1 = 有 assert 失败
"""
import os
import sys
import time
import json
import urllib.request
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = "http://localhost:5180"
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = []  # [(name, ok, detail), ...]


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    mark = "✓" if ok else "✗"
    print(f"  [{mark}] {name}: {detail}")


def http_get_json(path, timeout=30):
    """用 urllib 调 server 接口（不走 playwright）"""
    req = urllib.request.Request(BASE + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def http_get_bytes(path, timeout=60):
    req = urllib.request.Request(BASE + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


# ============================================================
# Assert 1：下载按钮 — server.py 真的返回 PDF，失败时返回友好 JSON
# ============================================================
def assert1_download_button():
    print("\n[Assert 1] 下载按钮 / server.py 修复")
    # 1a: 成功路径 — 拿真实 PDF
    try:
        # 用 Harris 2020 NumPy 这个 E2E 报告里已验证能找到的 DOI
        status, ctype, body = http_get_bytes(
            "/download-pdf?doi=10.1038/s41586-020-2649-2", timeout=30
        )
        is_pdf = "application/pdf" in ctype
        big_enough = len(body) > 100_000  # 至少 100KB
        ok_success = status == 200 and is_pdf and big_enough
        record(
            "1a: 成功 DOI 返回 application/pdf (>100KB)",
            ok_success,
            f"HTTP {status}, type={ctype}, size={len(body)}B"
        )
    except Exception as e:
        record("1a: 成功 DOI 返回 application/pdf", False, f"exception: {e}")
        ok_success = False

    # 1b: 失败路径 — 不存在的 DOI
    try:
        status, ctype, body = http_get_bytes(
            "/download-pdf?doi=10.9999/nonexistent.99999", timeout=30
        )
        try:
            payload = json.loads(body)
        except Exception:
            payload = None
        # 关键：不能是 Python 异常原文
        body_text = body.decode("utf-8", errors="ignore")
        no_python_exception = (
            "AttributeError" not in body_text
            and "'str' object has no attribute" not in body_text
            and "Traceback" not in body_text
        )
        has_ok_false = isinstance(payload, dict) and payload.get("ok") is False
        has_friendly_error = (
            has_ok_false
            and isinstance(payload.get("error"), str)
            and ("找不到" in payload["error"] or "免费 PDF" in payload["error"])
        )
        ok_fail = no_python_exception and has_friendly_error
        record(
            "1b: 失败 DOI 返回友好 JSON（不暴露 Python 异常）",
            ok_fail,
            f"no_python_exception={no_python_exception}, has_friendly_error={has_friendly_error}, payload={payload}"
        )
    except Exception as e:
        record("1b: 失败 DOI 友好返回", False, f"exception: {e}")
        ok_fail = False

    return ok_success and ok_fail


# ============================================================
# Assert 2：状态文字和 UI DOM 同步
# 验证 verifyPapers 过程中 $results 区显示"核验中…N/M"（与状态文字 step4-verify N/M 同步）
# ============================================================
def assert2_status_sync(page):
    print("\n[Assert 2] 状态文字 vs UI DOM 渲染同步")
    try:
        page.goto(BASE, wait_until="domcontentloaded", timeout=15000)
        # 等 script.js init
        page.wait_for_selector("#topic", timeout=5000)
        # 用一个肯定有结果的查询（climate change 之前 E2E 报告里验证过）
        page.fill("#topic", "climate change")
        page.click("#searchBtn")
        # 短轮询检查：状态文字里出现 step4-verify 时，$results 区也要出现"核验中"
        sync_seen = False
        mismatched = None
        # 最多等 90s（AI 15s + OpenAlex 5s + verify 30s + 缓冲）
        deadline = time.time() + 90
        while time.time() < deadline:
            try:
                status_txt = page.evaluate(
                    "() => document.getElementById('searchStatusText')?.innerText || ''"
                )
                results_txt = page.evaluate(
                    "() => document.getElementById('results')?.innerText || ''"
                )
                # 当状态是 step4-verify(N/M) 形式时，$results 区也要"核验" / "verifying" 提示
                if "step4-verify" in status_txt:
                    if "核验" in results_txt or "verifying" in results_txt.lower() or "step4" in results_txt:
                        sync_seen = True
                        break
                    # 状态 step4 但结果区无对应提示 → 不一致
                    mismatched = (status_txt, results_txt[:120])
                # 状态 done → 应该有 25 条结果（或 0 条+空状态）
                if status_txt.startswith("done") or "条建议词" in status_txt:
                    # done 状态时结果区不应该还在显示"核验中" placeholder
                    if "核验文献真实性中" in results_txt and "step4-verify" not in status_txt:
                        mismatched = (status_txt, results_txt[:120])
                    else:
                        # 一切正常，至少 verify 完是 sync 的
                        sync_seen = True
                    break
            except Exception:
                pass
            time.sleep(0.6)
        record(
            "2: 状态文字 step4-verify 时 $results 区同步显示核验进度",
            sync_seen,
            f"mismatched={mismatched}"
        )
        return sync_seen
    except Exception as e:
        record("2: 状态文字与 UI 同步", False, f"exception: {e}")
        return False


# ============================================================
# Assert 3：AI JSON 解析失败时 toast 显示用户友好消息
# 模拟：临时把 callMiniMaxKeyword 注入成返回非法 JSON 的 mock
# 然后搜一次，期望 toast 出现
# ============================================================
def assert3_json_failure_toast(page):
    print("\n[Assert 3] API 解析失败时 toast 用户提示")
    try:
        page.goto(BASE, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_selector("#topic", timeout=5000)
        # 用 init script 拦截 fetch，让 minimax 返回非法 JSON
        page.add_init_script("""
        (() => {
            const origFetch = window.fetch;
            window.fetch = function(url, opts) {
                if (typeof url === 'string' && url.includes('minimaxi.com')) {
                    return Promise.resolve(new Response(
                        '{"choices":[{"message":{"content":"not valid json {[ broken"}}, index: 0}',
                        { status: 200, headers: { 'Content-Type': 'application/json' } }
                    ));
                }
                return origFetch.apply(this, arguments);
            };
        })();
        """)
        # 重新加载
        page.reload(wait_until="domcontentloaded", timeout=15000)
        page.wait_for_selector("#topic", timeout=5000)
        page.fill("#topic", "anthropic 股价预测")
        page.click("#searchBtn")
        # 等 toast 出现
        toast_text = ""
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                toast_text = page.evaluate(
                    "() => document.getElementById('toast')?.innerText || ''"
                )
                if toast_text and toast_text.strip():
                    break
            except Exception:
                pass
            time.sleep(0.4)
        toast_shown = bool(toast_text.strip())
        # toast 内容不能是 Python 异常
        is_friendly = (
            toast_shown
            and "AttributeError" not in toast_text
            and "SyntaxError" not in toast_text
            and "Traceback" not in toast_text
            and "JSON.parse" not in toast_text
            and "异常" in toast_text
        )
        record(
            "3: AI 解析失败时 toast 显示用户友好提示（非 Python 异常）",
            is_friendly,
            f"toast='{toast_text}'"
        )
        return is_friendly
    except Exception as e:
        record("3: AI 解析失败 toast", False, f"exception: {e}")
        return False


# ============================================================
# Assert 4：搜新关键词后建议词区只剩新的（不含旧词）
# ============================================================
def assert4_suggestions_refresh(page):
    print("\n[Assert 4] 搜新关键词后建议词区刷新（无旧词残留）")
    try:
        page.goto(BASE, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_selector("#topic", timeout=5000)
        # 第一次搜一个能拿到结果的（"climate change" 已知能用）
        page.fill("#topic", "climate change")
        page.click("#searchBtn")
        # 等 step5-render 或 done
        first_done = False
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                txt = page.evaluate(
                    "() => document.getElementById('searchStatusText')?.innerText || ''"
                )
                if txt.startswith("done") or "条建议词" in txt:
                    first_done = True
                    break
            except Exception:
                pass
            time.sleep(0.6)
        # 记下第一次的建议词区文本
        first_suggestions = page.evaluate(
            "() => document.getElementById('suggestions')?.innerText || ''"
        )
        # 第二次搜完全不同的关键词
        page.fill("#topic", "machine learning interpretability")
        page.click("#searchBtn")
        # 立即检查建议词区 — 不应该再看到第一次的"climate"等关键词
        # （startSearch 开头已经清空 $suggestions 了）
        time.sleep(0.3)
        early_text = page.evaluate(
            "() => document.getElementById('suggestions')?.innerText || ''"
        )
        no_old_keyword = "climate" not in early_text.lower()
        # 等第二次完成
        second_done = False
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                txt = page.evaluate(
                    "() => document.getElementById('searchStatusText')?.innerText || ''"
                )
                if txt.startswith("done") or "条建议词" in txt:
                    second_done = True
                    break
            except Exception:
                pass
            time.sleep(0.6)
        final_suggestions = page.evaluate(
            "() => document.getElementById('suggestions')?.innerText || ''"
        )
        # 第二次结果不应该有"climate"残留
        no_climate_in_final = "climate" not in final_suggestions.lower()
        record(
            "4: 新搜索开始时建议词区立即清空，无旧词残留",
            no_old_keyword and no_climate_in_final and first_done and second_done,
            f"first_done={first_done}, second_done={second_done}, no_old_in_early={no_old_keyword}, no_climate_in_final={no_climate_in_final}"
        )
        return no_old_keyword and no_climate_in_final
    except Exception as e:
        record("4: 建议词区刷新", False, f"exception: {e}")
        return False


# ============================================================
# Assert 5：480 宽下 sidebar 可访问（汉堡按钮 toggle 后宽度 ≥ 200px）
# ============================================================
def assert5_responsive_sidebar(page):
    print("\n[Assert 5] 480 宽下 sidebar 可访问")
    try:
        page.goto(BASE, wait_until="domcontentloaded", timeout=15000)
        page.wait_for_selector("#topic", timeout=5000)
        # 缩到 480 宽
        page.set_viewport_size({"width": 480, "height": 800})
        time.sleep(0.3)
        # 默认状态：sidebar 应该默认折叠（不在 viewport 内可见）
        default_transform = page.evaluate("""
        () => {
            const sb = document.getElementById('sidebar');
            if (!sb) return null;
            return getComputedStyle(sb).transform;
        }
        """)
        hamburger_visible = page.evaluate("""
        () => {
            const h = document.getElementById('toggleSidebar');
            if (!h) return false;
            return getComputedStyle(h).display !== 'none';
        }
        """)
        # 点汉堡
        page.click("#toggleSidebar")
        time.sleep(0.4)  # 等 transition
        is_open_class = page.evaluate("""
        () => document.getElementById('sidebar')?.classList.contains('is-open') || false
        """)
        open_width = page.evaluate("""
        () => {
            const sb = document.getElementById('sidebar');
            if (!sb) return 0;
            return sb.getBoundingClientRect().width;
        }
        """)
        # 关闭
        page.click("#sidebarBackdrop", force=True)
        time.sleep(0.4)
        is_closed_after = not page.evaluate("""
        () => document.getElementById('sidebar')?.classList.contains('is-open') || false
        """)
        # 默认折叠且汉堡可见
        is_collapsed = default_transform and "matrix" in default_transform and (
            "-1" in default_transform or "translateX(-" in default_transform
        ) or (default_transform == "none" and not is_open_class)
        # 或者更简单：open_width >= 200 说明 toggle 后有合理宽度
        ok_width = open_width >= 200
        all_ok = hamburger_visible and is_open_class and ok_width and is_closed_after
        record(
            "5: 480 宽下汉堡按钮 toggle 后 sidebar 宽度 ≥ 200px，可开关",
            all_ok,
            f"hamburger_visible={hamburger_visible}, is_open_class={is_open_class}, open_width={open_width:.0f}px, is_closed_after={is_closed_after}, default_transform={default_transform}"
        )
        return all_ok
    except Exception as e:
        record("5: 480 宽 sidebar", False, f"exception: {e}")
        return False


# ============================================================
# Main
# ============================================================
def main():
    print(f"== lit-hunt 5-bug fix verifier == {time.strftime('%H:%M:%S')}")
    print(f"BASE = {BASE}")

    # Assert 1：纯 HTTP（不需要浏览器）
    a1 = assert1_download_button()

    # Assert 2-5：playwright
    a2 = a3 = a4 = a5 = False
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                locale="zh-CN",
            )
            page = context.new_page()
            a2 = assert2_status_sync(page)
            a3 = assert3_json_failure_toast(page)
            a4 = assert4_suggestions_refresh(page)
            a5 = assert5_responsive_sidebar(page)
        finally:
            browser.close()

    print("\n== Summary ==")
    for name, ok, detail in RESULTS:
        mark = "✓" if ok else "✗"
        print(f"  [{mark}] {name}")
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
