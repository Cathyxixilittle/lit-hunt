#!/usr/bin/env python3
"""
lit-hunt DOI 解析验证脚本（纯 HTTP，不走 playwright）

对应 plan_b8f5a8ac / add-doi-lookup 任务：
  1. 真实 DOI（NumPy paper, 10.1038/s41586-020-2649-2）能解析，4 个字段非空
  2. 错误 DOI（10.9999/invalid-doi-12345）返 ok:false + 友好 error
  3. 失败响应的 error 不含 Python 异常字符串（防止 bug 5 那种泄漏）
  4. 响应 JSON shape 稳定

用法：
  python3 verify_doi.py
退出码：0 = 全部通过；1 = 有 assert 失败
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BASE = "http://localhost:5180"
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = []  # [(name, ok, detail), ...]

# 抄自 server.py 的判定（保持一致）
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
PY_EXCEPTION_MARKERS = (
    "Traceback",
    "Exception",
    "AttributeError",
    "TypeError",
    "KeyError",
    "ValueError",
    "'NoneType'",
    "object has no attribute",
    "list indices must be",
    "string indices must be",
)


def record(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    mark = "✓" if ok else "✗"
    print(f"  [{mark}] {name}: {detail}")


def http_get(path, timeout=20):
    req = urllib.request.Request(BASE + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def http_get_safe(path, timeout=20):
    """GET 一次，4xx/5xx 也吃，不抛。"""
    req = urllib.request.Request(BASE + path)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), None
    except urllib.error.HTTPError as e:
        return e.code, e.read(), None
    except Exception as e:
        return None, None, str(e)


# ============================================================
# Assert 1：成功路径（NumPy paper）
# ============================================================
def assert1_success_doi():
    print("\n[Assert 1] 成功 DOI（10.1038/s41586-020-2649-2 / NumPy paper）")
    doi = "10.1038/s41586-020-2649-2"
    try:
        status, body, err = http_get_safe(f"/doi-lookup?doi={urllib.parse.quote(doi)}")
        assert err is None, f"transport error: {err}"
        assert status == 200, f"HTTP {status}, body={body[:200]!r}"
        data = json.loads(body.decode("utf-8"))
        assert isinstance(data, dict), f"response not dict: {type(data)}"
        assert data.get("ok") is True, f"ok not True: {data}"

        d = data["data"]
        # 必填字段都非空
        for f in ("doi", "title", "authors", "year", "container", "publisher", "url"):
            assert d.get(f) not in (None, "", []), f"missing/empty: {f}"
        # NumPy 论文预期字段
        assert d["doi"] == doi, f"doi mismatch: {d['doi']}"
        assert "NumPy" in d["title"], f"title missing 'NumPy': {d['title']}"
        assert d["year"] == 2020, f"year != 2020: {d['year']}"
        assert d["container"] == "Nature", f"container != Nature: {d['container']}"
        assert isinstance(d["authors"], list) and len(d["authors"]) >= 1, "no authors"
        first = d["authors"][0]
        assert first.get("family") == "Harris", f"first author != Harris: {first}"
        assert first.get("given") == "Charles R.", f"first given != Charles R.: {first}"
        # volume/issue/page 都拿到
        assert d.get("volume") == "585", f"volume != 585: {d.get('volume')}"
        assert d.get("issue") == "7825", f"issue != 7825: {d.get('issue')}"
        assert d.get("page") == "357-362", f"page != 357-362: {d.get('page')}"
        # URL 正确
        assert d["url"].startswith("https://doi.org/"), f"bad url: {d['url']}"

        record("1: 真实 DOI 返回 ok:true + 完整元数据", True,
               f"title={d['title'][:50]!r}, year={d['year']}, journal={d['container']}, authors={len(d['authors'])}")
        return True
    except AssertionError as e:
        record("1: 真实 DOI 返回 ok:true + 完整元数据", False, str(e))
        return False
    except Exception as e:
        record("1: 真实 DOI 返回 ok:true + 完整元数据", False, f"exception: {e}")
        return False


# ============================================================
# Assert 2：成功路径（IPCC 书，10.1017/9781009325844）
# ============================================================
def assert2_success_book():
    print("\n[Assert 2] 成功 DOI（10.1017/9781009325844 / IPCC 报告，monograph）")
    doi = "10.1017/9781009325844"
    try:
        status, body, err = http_get_safe(f"/doi-lookup?doi={urllib.parse.quote(doi)}")
        assert err is None, f"transport error: {err}"
        assert status == 200, f"HTTP {status}"
        data = json.loads(body.decode("utf-8"))
        assert data.get("ok") is True, f"ok not True: {data}"
        d = data["data"]
        assert d["title"], "no title"
        assert "Climate Change" in d["title"], f"title missing 'Climate Change': {d['title']}"
        assert d["publisher"] == "Cambridge University Press", f"publisher mismatch: {d['publisher']}"
        # 书没有 container-title（数组），也不该有 volume/issue/page
        assert d["container"] in (None, ""), f"book should have empty container: {d['container']}"
        assert d["volume"] in (None, ""), f"book should have empty volume: {d['volume']}"
        # type 应该是 monograph / book
        assert d["type"] in ("monograph", "book"), f"type unexpected: {d['type']}"
        # authors 至少有 IPCC 这一条（只有 family，没 given）
        assert len(d["authors"]) >= 1
        first = d["authors"][0]
        assert "IPCC" in (first.get("family") or ""), f"first author not IPCC: {first}"
        # given 字段缺失 → 应当是 '' 或 None（不能崩）
        assert first.get("given") in (None, ""), f"given should be empty: {first}"

        record("2: 书类型 DOI 返回 ok:true，container/volume 为空", True,
               f"title={d['title'][:50]!r}, type={d['type']}, publisher={d['publisher']}")
        return True
    except AssertionError as e:
        record("2: 书类型 DOI 返回 ok:true", False, str(e))
        return False
    except Exception as e:
        record("2: 书类型 DOI 返回 ok:true", False, f"exception: {e}")
        return False


# ============================================================
# Assert 3：失败路径（不存在的 DOI）—— 关键：不能漏 Python 异常
# ============================================================
def assert3_invalid_doi():
    print("\n[Assert 3] 失败 DOI（10.9999/invalid-doi-12345）")
    doi = "10.9999/invalid-doi-12345"
    try:
        status, body, err = http_get_safe(f"/doi-lookup?doi={urllib.parse.quote(doi)}")
        # 状态码应是 200（统一 JSON 响应），不能是 500
        body_repr = repr(body[:200]) if body else repr(None)
        assert status == 200, f"status != 200 (server crash?): HTTP {status}, body={body_repr}"
        assert body, "empty body"
        data = json.loads(body.decode("utf-8"))
        assert isinstance(data, dict)
        assert data.get("ok") is False, f"ok should be False: {data}"
        assert data.get("error"), f"missing error field: {data}"

        err_str = data["error"]
        # 不能包含任何 Python 异常标记
        leaked = [m for m in PY_EXCEPTION_MARKERS if m in err_str]
        assert not leaked, f"Python exception leaked into error: {leaked} → {err_str!r}"
        # 错误信息应该对用户友好（中文/英文都 OK，但要带"DOI"或"失败"之类）
        assert any(k in err_str for k in ("DOI", "失败", "不存在", "找不到", "不可用")), \
            f"error 不够友好: {err_str!r}"

        record("3: 不存在 DOI 返 ok:false + 友好 error（无 Python 异常泄漏）", True,
               f"error={err_str!r}")
        return True
    except AssertionError as e:
        record("3: 不存在 DOI 返 ok:false + 友好 error", False, str(e))
        return False
    except Exception as e:
        record("3: 不存在 DOI 返 ok:false + 友好 error", False, f"exception: {e}")
        return False


# ============================================================
# Assert 4：失败路径（DOI 格式不对）
# ============================================================
def assert4_bad_format():
    print("\n[Assert 4] 失败：DOI 格式不对（'not-a-doi'）")
    try:
        status, body, err = http_get_safe(f"/doi-lookup?doi=not-a-doi")
        assert status == 200, f"status != 200: HTTP {status}"
        data = json.loads(body.decode("utf-8"))
        assert data.get("ok") is False, f"ok should be False: {data}"
        assert data.get("error"), f"missing error: {data}"
        err_str = data["error"]
        # 不能包含 Python 异常
        leaked = [m for m in PY_EXCEPTION_MARKERS if m in err_str]
        assert not leaked, f"Python exception leaked: {leaked}"
        # 应该提到 DOI 格式
        assert "DOI" in err_str or "10" in err_str, f"error should mention DOI format: {err_str!r}"
        record("4: 格式不对返 ok:false + 友好 error", True, f"error={err_str!r}")
        return True
    except AssertionError as e:
        record("4: 格式不对返 ok:false + 友好 error", False, str(e))
        return False
    except Exception as e:
        record("4: 格式不对返 ok:false + 友好 error", False, f"exception: {e}")
        return False


# ============================================================
# Assert 5：响应 shape 稳定（不依赖具体内容，只看 schema）
# ============================================================
def assert5_response_shape():
    print("\n[Assert 5] 响应 JSON shape 稳定")
    try:
        status, body, _ = http_get_safe(f"/doi-lookup?doi={urllib.parse.quote('10.1038/s41586-020-2649-2')}")
        assert status == 200
        data = json.loads(body.decode("utf-8"))
        # 顶层 keys 必含 ok 和 data（成功）/ error（失败）
        assert "ok" in data, "missing top-level 'ok'"
        assert isinstance(data["ok"], bool), f"ok not bool: {type(data['ok'])}"
        assert "data" in data, "missing top-level 'data'"
        d = data["data"]
        # data 内部必含字段
        required = ("doi", "title", "authors", "year", "container", "volume",
                    "issue", "page", "publisher", "type", "url")
        for k in required:
            assert k in d, f"data missing key: {k}"
        # authors 每条至少要有 family/display 之一
        for a in d["authors"]:
            assert isinstance(a, dict)
            assert a.get("family") or a.get("display") or a.get("name"), \
                f"author has no name: {a}"
        record("5: 响应 JSON shape 稳定（data 包含 11 个字段）", True,
               f"keys={list(d.keys())}")
        return True
    except AssertionError as e:
        record("5: 响应 JSON shape 稳定", False, str(e))
        return False
    except Exception as e:
        record("5: 响应 JSON shape 稳定", False, f"exception: {e}")
        return False


# ============================================================
# Assert 6：access log 写出来（顺手验证 BUGFIX_REPORT 提的缺日志问题）
# ============================================================
def assert6_access_log():
    print("\n[Assert 6] server.log 里有 /doi-lookup 的 access log")
    try:
        log_path = os.path.join(HERE, "server.log")
        if not os.path.exists(log_path):
            record("6: server.log 含 /doi-lookup", False, "server.log 不存在")
            return False
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()
        # 找最近一次 doi-lookup 请求的痕迹
        if "/doi-lookup" not in content:
            record("6: server.log 含 /doi-lookup", False,
                   "server.log 没有 /doi-lookup 记录")
            return False
        record("6: server.log 含 /doi-lookup 记录", True, "找到 access log")
        return True
    except Exception as e:
        record("6: server.log 含 /doi-lookup", False, f"exception: {e}")
        return False


# ============================================================
# Main
# ============================================================
def main():
    print(f"== lit-hunt DOI lookup verifier == {time.strftime('%H:%M:%S')}")
    print(f"BASE = {BASE}")
    print(f"NOTE: server.py 必须已经在 {BASE} 跑着")

    a1 = assert1_success_doi()
    a2 = assert2_success_book()
    a3 = assert3_invalid_doi()
    a4 = assert4_bad_format()
    a5 = assert5_response_shape()
    a6 = assert6_access_log()

    print("\n== Summary ==")
    for name, ok, _ in RESULTS:
        mark = "✓" if ok else "✗"
        print(f"  [{mark}] {name}")
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
