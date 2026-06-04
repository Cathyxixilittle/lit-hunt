#!/usr/bin/env python3
"""MiniMax API proxy server for lit-hunt.
Reads MINIMAX_API_KEY from environment and injects it into script.js on the fly.
Also serves PDF downloads via paper-fetch.
Usage:
  export MINIMAX_API_KEY='your-key-here'
  python3 server.py
Then open http://localhost:5173
"""

import os
import sys
import http.server
import socketserver
import re
import subprocess
import json
import urllib.parse
import urllib.request
import urllib.error

PORT = 5180
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
API_KEY = os.getenv("MINIMAX_API_KEY", "")
PLACEHOLDER = "MINIMAX_API_KEY_PLACEHOLDER"
ZOTERO_USER_ID = os.getenv("ZOTERO_USER_ID", "")
ZOTERO_API_KEY = os.getenv("ZOTERO_API_KEY", "")
# Crossref "polite" User-Agent 用的邮箱（Crossref 推荐设 polite email，
# 放进 UA 的 mailto 字段，方便它们遇到滥用时联系）
# 默认就是 chenyu 的 gmail，无需在 .env 里改
CROSSREF_POLITE_EMAIL = os.getenv("CROSSREF_POLITE_EMAIL", "yc1376772@gmail.com")
FETCH_SCRIPT = os.path.join(DIRECTORY, "fetch.py")
PDF_OUT_DIR = os.path.join(DIRECTORY, "pdfs")
# DOI 输入的正则（Crossref 实际格式：10.XXXX/anything）
_DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")


class LitHuntHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/zotero-add":
            self.handle_zotero_add()
            return
        self.send_json({"ok": False, "error": "unknown endpoint"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # PDF download endpoint
        if path == "/download-pdf":
            doi = urllib.parse.parse_qs(parsed.query).get("doi", [None])[0]
            if not doi:
                self.send_json({"ok": False, "error": "missing doi"})
                return
            self.handle_pdf_download(doi)
            return

        # Serve config as JSON
        if path == "/config":
            self.send_json({
                "minimaxApiKey": API_KEY,
                "zoteroUserId": ZOTERO_USER_ID,
                "zoteroApiKey": ZOTERO_API_KEY,
            })
            return

        # Semantic Scholar proxy (绕过浏览器 CORS 限制)
        if path.startswith("/s2-proxy/"):
            self.handle_s2_proxy()
            return

        # Zotero test connection
        if path == "/zotero-test":
            user_id = urllib.parse.parse_qs(parsed.query).get("userId", [None])[0]
            api_key = urllib.parse.parse_qs(parsed.query).get("apiKey", [None])[0]
            lib_type = urllib.parse.parse_qs(parsed.query).get("libraryType", ["user"])[0]
            group_id = urllib.parse.parse_qs(parsed.query).get("groupId", [None])[0]
            self.handle_zotero_test(user_id, api_key, lib_type, group_id)
            return

        # Zotero add paper
        if path == "/zotero-add":
            self.handle_zotero_add()
            return

        # Crossref DOI 解析（"引用格式速查"页用）
        if path == "/doi-lookup":
            doi = urllib.parse.parse_qs(parsed.query).get("doi", [None])[0]
            if not doi:
                self.send_json({"ok": False, "error": "缺少 doi 参数"})
                return
            self.handle_doi_lookup(doi.strip())
            return

        # script.js now has key hardcoded; serve as-is
        return super().do_GET()

    def handle_pdf_download(self, doi):
        """Run paper-fetch for the given DOI and stream the PDF back.
        fetch.py NDJSON output: the final envelope line is
          {"ok": true|false|"partial", "data": {"results": [{"file": "path/to.pdf", ...}, ...]}, ...}
        On failure, envelope may be {"ok": false, "error": {"code": "...", "message": "..."}, ...}
        """
        os.makedirs(PDF_OUT_DIR, exist_ok=True)
        cmd = [
            "python3", FETCH_SCRIPT,
            doi,
            "--out", PDF_OUT_DIR,
            "--format", "json",
        ]
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            self.send_json({"ok": False, "error": "下载超时，请稍后重试", "code": "timeout"})
            return
        except Exception as e:
            # 兜底：把进程级错误转成用户友好提示，绝不把 Python 异常 str 漏给前端
            self.send_json({"ok": False, "error": "下载服务暂时不可用，请稍后重试", "code": "server_error"})
            print(f"[handle_pdf_download] process error: {e}", flush=True)
            return

        # 解析 fetch.py NDJSON：找最后一行带 "ok" 字段的 envelope
        envelope = None
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and "ok" in obj:
                envelope = obj  # 保留最后一个 envelope

        if envelope is None:
            # 没拿到任何 envelope（fetch.py 输出异常）
            self.send_json({
                "ok": False,
                "error": "这篇文献暂时找不到免费 PDF，可以去出版社官网或 Sci-Hub 试试",
                "code": "no_oa",
            })
            return

        # 成功 / 部分成功：取 results[0].file
        if envelope.get("ok") in (True, "partial"):
            results = envelope.get("data", {}).get("results", []) or []
            # 找第一个 success=True 的 result
            hit = next((r for r in results if isinstance(r, dict) and r.get("success") and r.get("file")), None)
            if hit:
                pdf_path = hit["file"]
                if os.path.isabs(pdf_path) and os.path.exists(pdf_path):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header(
                        "Content-Disposition",
                        f"attachment; filename*=UTF-8''{os.path.basename(pdf_path)}"
                    )
                    self.send_header("Content-Length", os.path.getsize(pdf_path))
                    self.end_headers()
                    with open(pdf_path, "rb") as f:
                        self.wfile.write(f.read())
                    return
                # 路径是相对项目根（fetch.py 默认 --out=pdfs/）
                if not os.path.isabs(pdf_path):
                    pdf_path = os.path.join(DIRECTORY, pdf_path)
                if os.path.exists(pdf_path):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header(
                        "Content-Disposition",
                        f"attachment; filename*=UTF-8''{os.path.basename(pdf_path)}"
                    )
                    self.send_header("Content-Length", os.path.getsize(pdf_path))
                    self.end_headers()
                    with open(pdf_path, "rb") as f:
                        self.wfile.write(f.read())
                    return

        # 解析失败或没拿到 file —— 安全地读 error.message（dict 或 str 都兼容）
        err = envelope.get("error") if isinstance(envelope, dict) else None
        if isinstance(err, dict):
            err_msg = err.get("message") or "no_oa"
        elif isinstance(err, str):
            err_msg = err
        else:
            err_msg = ""
        if not err_msg:
            err_msg = "no_oa"

        self.send_json({
            "ok": False,
            "error": "这篇文献暂时找不到免费 PDF，可以去出版社官网或 Sci-Hub 试试",
            "code": "no_oa",
            "detail": err_msg,
        })

    def handle_zotero_test(self, user_id, api_key, lib_type, group_id):
        """Test Zotero API connection and return HTML page."""
        import urllib.request, urllib.error
        if lib_type == "group" and group_id:
            url = f"https://api.zotero.org/groups/{group_id}/items?limit=1"
        else:
            url = f"https://api.zotero.org/users/{user_id}/items?limit=1"
        req = urllib.request.Request(url, headers={
            "Zotero-API-Key": api_key,
            "Zotero-API-Version": "3",
        })
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                total_reqs = resp.headers.get("Total-Results", "0")
                body = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body {{ font-family: -apple-system, sans-serif; background: #F7F5F2; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }}
  .card {{ background:#fff; border-radius:12px; padding:32px 40px; box-shadow:0 2px 12px rgba(0,0,0,.08); text-align:center; max-width:400px; }}
  .ok {{ color:#4a7c59; }} .err {{ color:#c0392b; }}
  h2 {{ margin:0 0 16px; font-size:20px; }} p {{ margin:8px 0; color:#5a4838; font-size:15px; }}
  a {{ display:inline-block; margin-top:20px; color:#B59680; text-decoration:none; }}
</style></head><body>
<div class="card">
  <h2 class="ok">✓ Zotero 连接成功</h2>
  <p>用户：{user_id}</p>
  <p>文献数量：{total_reqs} 条</p>
  <a href="javascript:window.close()">关闭此页</a>
</div></body></html>"""
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(body.encode("utf-8"))
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", errors="ignore")
            try:
                err = json.loads(msg)
                detail = err[0].get("message", msg[:200])
            except Exception:
                detail = msg[:200]
            body = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body {{ font-family: -apple-system, sans-serif; background: #F7F5F2; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }}
  .card {{ background:#fff; border-radius:12px; padding:32px 40px; box-shadow:0 2px 12px rgba(0,0,0,.08); text-align:center; max-width:440px; }}
  h2 {{ color:#c0392b; margin:0 0 16px; font-size:20px; }} p {{ margin:8px 0; color:#5a4838; font-size:15px; word-break:break-all; }}
  a {{ display:inline-block; margin-top:20px; color:#B59680; text-decoration:none; }}
</style></head><body>
<div class="card">
  <h2>✗ 连接失败</h2>
  <p>错误：HTTP {e.code}</p>
  <p>{detail}</p>
  <a href="javascript:window.close()">关闭此页</a>
</div></body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
        except Exception as e:
            body = f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body {{ font-family: -apple-system, sans-serif; background: #F7F5F2; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }}
  .card {{ background:#fff; border-radius:12px; padding:32px 40px; box-shadow:0 2px 12px rgba(0,0,0,.08); text-align:center; }}
  h2 {{ color:#c0392b; margin:0 0 16px; }} p {{ color:#5a4838; margin:8px 0; }}
  a {{ display:inline-block; margin-top:20px; color:#B59680; text-decoration:none; }}
</style></head><body>
<div class="card">
  <h2>✗ 连接失败</h2>
  <p>{str(e)}</p>
  <a href="javascript:window.close()">关闭此页</a>
</div></body></html>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

    def handle_zotero_add(self):
        """Add a paper to Zotero via the API."""
        import urllib.request, urllib.error
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length == 0:
                self.send_json({"ok": False, "error": "no body"})
                return
            body = self.rfile.read(length)
            paper = json.loads(body.decode("utf-8"))
        except Exception as e:
            self.send_json({"ok": False, "error": f"parse error: {e}"})
            return

        user_id = paper.get("userId")
        api_key = paper.get("apiKey")
        lib_type = paper.get("libraryType", "user")
        group_id = paper.get("groupId")

        if not user_id or not api_key:
            self.send_json({"ok": False, "error": "missing credentials"})
            return

        # Build Zotero API item payload
        item = {
            "itemType": "journalArticle" if paper.get("source") else "document",
            "title": paper.get("title", "Untitled"),
            "creators": [],
            "abstractNote": "",
        }
        # Zotero API requires a JSON array
        payload = [item]
        # Parse authors (handle "LastName, FirstName" or "FirstName LastName" format)
        authors = paper.get("authors", "")
        if authors:
            for name in authors.split(","):
                name = name.strip()
                if not name:
                    continue
                # Try "LastName, FirstName" format
                if "," in name:
                    parts = [p.strip() for p in name.split(",", 1)]
                    item["creators"].append({
                        "creatorType": "author",
                        "lastName": parts[0],
                        "firstName": parts[1] if len(parts) > 1 else "",
                    })
                else:
                    # Plain name — use as lastName
                    parts = name.split()
                    if len(parts) == 1:
                        item["creators"].append({"creatorType": "author", "lastName": name})
                    else:
                        item["creators"].append({
                            "creatorType": "author",
                            "lastName": parts[-1],
                            "firstName": " ".join(parts[:-1]),
                        })
        if paper.get("year"):
            item["date"] = paper.get("year")
        if paper.get("doi"):
            item["DOI"] = paper.get("doi")
        if paper.get("source"):
            item["publicationTitle"] = paper.get("source")
        if paper.get("url"):
            item["url"] = paper.get("url")

        if lib_type == "group" and group_id:
            base_url = f"https://api.zotero.org/groups/{group_id}"
        else:
            base_url = f"https://api.zotero.org/users/{user_id}"
        url = f"{base_url}/items"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Zotero-API-Key": api_key,
            "Zotero-API-Version": "3",
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read())
                # Zotero returns {"successful": {"0": {"key": "...", "version": N}}, ...}
                successful = result.get("successful", {})
                if isinstance(successful, dict) and successful:
                    first_key = list(successful.keys())[0]
                    key = successful[first_key].get("key", "")
                else:
                    key = ""
                self.send_json({"ok": True, "key": key})
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", errors="ignore")
            try:
                err = json.loads(msg)
                detail = err[0].get("message", msg[:300])
            except Exception:
                detail = msg[:300]
            self.send_json({"ok": False, "error": f"HTTP {e.code}: {detail}"})
        except Exception as e:
            self.send_json({"ok": False, "error": str(e)})

    def send_json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def handle_doi_lookup(self, doi):
        """用 Crossref 解析 DOI，提取出 4 种引用格式需要的元数据。

        失败策略：绝不把 Python 异常 str 漏给前端。
        """
        if not _DOI_RE.match(doi):
            self.send_json({"ok": False, "error": "DOI 格式不对，应是 10.xxxx/... 形式"})
            return

        url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}"
        ua = f"lit-hunt/0.5 (mailto:{CROSSREF_POLITE_EMAIL})"
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json",
                "User-Agent": ua,
            })
            with urllib.request.urlopen(req, timeout=12) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 404 = DOI 不在 Crossref 里
            if e.code == 404:
                self.send_json({"ok": False, "error": "DOI 解析失败：Crossref 找不到这篇文献（DOI 不存在或未登记）"})
            else:
                self.send_json({"ok": False, "error": f"DOI 解析失败：Crossref 返回 HTTP {e.code}"})
            return
        except urllib.error.URLError as e:
            self.send_json({"ok": False, "error": f"DOI 解析失败：连不上 Crossref（{e.reason}）"})
            return
        except (json.JSONDecodeError, TimeoutError) as e:
            self.send_json({"ok": False, "error": f"DOI 解析失败：返回数据无法解析"})
            return
        except Exception as e:
            # 兜底：绝不把 Python 异常字符串透出去
            print(f"[handle_doi_lookup] unexpected error: {e}", flush=True)
            self.send_json({"ok": False, "error": "DOI 解析失败：服务暂时不可用，请稍后重试"})
            return

        msg = payload.get("message") if isinstance(payload, dict) else None
        if not isinstance(msg, dict):
            self.send_json({"ok": False, "error": "DOI 解析失败：Crossref 返回结构异常"})
            return

        # 提取字段
        authors_raw = msg.get("author") or []
        title_list = msg.get("title") or []
        container_list = msg.get("container-title") or []
        issued = msg.get("issued") or msg.get("published-print") or msg.get("published-online") or {}
        date_parts = (issued.get("date-parts") or [[None]])[0]

        # 提取规范化作者：{family, given, display}，兼容各种 fallback
        authors = []
        for a in authors_raw:
            if not isinstance(a, dict):
                continue
            family = (a.get("family") or "").strip()
            given = (a.get("given") or "").strip()
            display = a.get("display_name") or a.get("name") or ""
            if not display and family:
                display = f"{family}, {given}".strip(", ")
            authors.append({
                "family": family,
                "given": given,
                "display": display.strip(),
            })

        data = {
            "doi": msg.get("DOI") or doi,
            "title": (title_list[0] if title_list else "").strip(),
            "authors": authors,
            "year": date_parts[0] if date_parts and date_parts[0] else None,
            "container": (container_list[0] if container_list else "").strip(),
            "volume": msg.get("volume") or "",
            "issue": msg.get("issue") or "",
            "page": msg.get("page") or "",
            "publisher": msg.get("publisher") or "",
            "type": msg.get("type") or "",
            "url": msg.get("URL") or f"https://doi.org/{doi}",
        }
        self.send_json({"ok": True, "data": data})

    def log_message(self, format, *args):
        """覆盖默认 access log：用 print 写 stdout，方便跟其它 print 走同一份 server.log。"""
        try:
            sys.stderr.write(
                "%s - - [%s] %s\n" %
                (self.address_string(),
                 self.log_date_time_string(),
                 format % args)
            )
            sys.stderr.flush()
        except Exception:
            pass

    def handle_s2_proxy(self):
        """代理 Semantic Scholar 请求，绕过浏览器 CORS 限制。
        前端调用 /s2-proxy/graph/v1/paper/DOI:xxx?fields=...
        本方法转发到 https://api.semanticscholar.org/graph/v1/paper/DOI:xxx?fields=...
        """
        parsed = urllib.parse.urlparse(self.path)
        s2_subpath = parsed.path[len("/s2-proxy/"):]
        s2_url = f"https://api.semanticscholar.org/{s2_subpath}"
        if parsed.query:
            s2_url += "?" + parsed.query
        try:
            req = urllib.request.Request(s2_url, headers={
                "Accept": "application/json",
                "User-Agent": "lit-hunt/0.5",
            })
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "application/json")
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            # S2 错误：把 S2 的状态码和 body 透传给浏览器
            try:
                body = e.read()
            except Exception:
                body = json.dumps({"error": str(e)}).encode("utf-8")
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_json({"ok": False, "error": f"s2-proxy failed: {e}"})

    def translate_path(self, path):
        import os
        filepath = super().translate_path(path)
        if filepath.endswith("/") or not os.path.isfile(filepath):
            return os.path.join(DIRECTORY, "index.html")
        return filepath


if __name__ == "__main__":
    print(f"Starting lit-hunt server at http://localhost:{PORT}")
    print(f"MiniMax API Key: {'✓ 已加载' if API_KEY else '✗ 未设置（请先 export MINIMAX_API_KEY）'}")
    print(f"Serving files from: {DIRECTORY}")
    os.makedirs(PDF_OUT_DIR, exist_ok=True)
    print(f"PDF output dir: {PDF_OUT_DIR}")
    with socketserver.TCPServer(("", PORT), LitHuntHandler) as httpd:
        print(f"Open http://localhost:{PORT}")
        httpd.serve_forever()
