"""A tiny read-only HTTP server for the generated panchangam feed.

The public site is static, so GitHub Pages can serve the same files.  This
server exists for local testing and for families who prefer to subscribe from a
small always-on box instead of publishing to GitHub.

    python -m scripts.panchang serve --build

Routes:
    /                         an index page
    /panchang.ics             combined feed (alias to the configured name)
    /panchang-2026.ics        per-year feed
    /panchang.json            combined JSON
    /health                   ``{"status": "ok"}``
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import AppConfig


def _index_html(output_dir: Path, feed_name: str, public_url: str | None) -> bytes:
    feeds = sorted(output_dir.glob("*.ics"))
    rows = []
    for feed in feeds:
        href = f"/{feed.name}"
        if public_url:
            href = f"{public_url.rstrip('/')}/{feed.name}"
        rows.append(f'<li><a href="{href}">{feed.name}</a></li>')
    years = sorted(re.findall(r"-(\d{4})\.ics$", " ".join(f.name for f in feeds)))
    year_links = " ".join(
        f'<a href="/{feed_name[:-4]}-{year}.ics">{year}</a>' for year in years
    )
    body = f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Kula Panchangam feed</title>
<style>
  body {{ font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; color: #1a1c18; background: #f6faf2; }}
  code {{ background: #e6f0e2; padding: .1rem .3rem; border-radius: .3rem; }}
  a {{ color: #4f6f52; }}
</style>
<h1>Kula Panchangam</h1>
<p>Subscribe to the combined feed, or download a single year.</p>
<ul>{''.join(rows)}</ul>
<p>Google Calendar: <em>Other calendars → From URL</em>, then paste the absolute
<code>.ics</code> URL.{' Years: ' + year_links if year_links else ''}</p>
<p>Generated {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}.</p>
</html>
"""
    return body.encode("utf-8")


class PanchangHandler(SimpleHTTPRequestHandler):
    """Serve the build directory, with an optional shared token."""

    server_version = "KulaPanchang/1.0"

    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def _authorised(self) -> bool:
        token = self.server.feed_token  # type: ignore[attr-defined]
        if not token:
            return True
        query = parse_qs(urlparse(self.path).query)
        supplied = (query.get("token") or [""])[0]
        header = self.headers.get("Authorization", "")
        return supplied == token or header == f"Bearer {token}"

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorised():
            self.send_error(HTTPStatus.UNAUTHORIZED, "A valid feed token is required")
            return
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            payload = json.dumps({"status": "ok"}).encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if parsed.path in {"/", "/index.html"}:
            feed_name = self.server.feed_name  # type: ignore[attr-defined]
            payload = _index_html(
                Path(self.directory),
                feed_name,
                getattr(self.server, "public_url", None),  # type: ignore[attr-defined]
            )
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if parsed.path == "/panchang.ics":
            self.path = f"/{self.server.feed_name}"  # type: ignore[attr-defined]
        super().do_GET()

    def end_headers(self) -> None:
        if self.path.endswith(".ics"):
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header(
                "Cache-Control",
                f"public, max-age={getattr(self.server, 'cache_seconds', 300)}",  # type: ignore[attr-defined]
            )
        elif self.path.endswith(".json"):
            self.send_header("Content-Type", "application/json; charset=utf-8")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # keep the CLI output quiet-ish
        print(f"[panchang] {self.address_string()} {fmt % args}")


def serve(config: AppConfig, *, host: str | None = None, port: int | None = None) -> None:
    output_dir = config.output_dir
    if not output_dir.exists():
        raise SystemExit(
            f"{output_dir} does not exist. Run `python -m scripts.panchang build` first."
        )
    host = host or config.server.host
    port = port or config.server.port
    handler = lambda *args, **kwargs: PanchangHandler(  # noqa: E731
        *args, directory=str(output_dir), **kwargs
    )
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    httpd.feed_token = config.server.feed_token  # type: ignore[attr-defined]
    httpd.feed_name = config.feed_name  # type: ignore[attr-defined]
    httpd.public_url = config.server.public_url  # type: ignore[attr-defined]
    httpd.cache_seconds = config.server.cache_seconds  # type: ignore[attr-defined]
    print(f"Serving {output_dir} on http://{host}:{port}/")
    print(f"Feed: http://{host}:{port}/{config.feed_name}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
