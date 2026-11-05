"""Optional push sync to a Google Calendar.

The PRIMARY integration is the ``.ics`` subscription feed, which needs no
Google credentials and works with any calendar app.  This module is only for
families who want the events copied into a Google calendar (for reminders,
search, or editing) rather than subscribed.

Install the optional client libraries first:

    .venv/bin/pip install google-api-python-client google-auth google-auth-oauthlib

Then either:

* create an OAuth desktop client and save it at
  ``private/google-credentials.json`` (the first run opens a browser and writes
  ``private/google-token.json``), or
* share the target calendar with a service account and set
  ``google.service_account_file``.

Use ``--dry-run`` first: it prints the API calls without writing.
"""

from __future__ import annotations

from .config import AppConfig
from .ics import event_to_google
from .models import PanchangEvent

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]


def _require_google():
    try:
        from google.oauth2 import service_account  # noqa: F401
        from googleapiclient.discovery import build  # noqa: F401
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "Google Calendar sync needs the optional packages:\n"
            "  .venv/bin/pip install google-api-python-client google-auth google-auth-oauthlib\n"
            "The .ics feed works without them."
        ) from exc


def build_service(config: AppConfig):
    _require_google()
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    settings = config.google
    if settings.service_account_file:
        path = config.resolve_path(settings.service_account_file)
        if not path or not path.exists():
            raise FileNotFoundError(f"Service-account file not found: {path}")
        credentials = service_account.Credentials.from_service_account_file(
            str(path), scopes=SCOPES
        )
    else:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow

        credentials_path = config.resolve_path(settings.credentials_file)
        token_path = config.resolve_path(settings.token_file)
        if not credentials_path or not credentials_path.exists():
            raise FileNotFoundError(
                f"OAuth client file not found: {credentials_path}. "
                "Download a desktop OAuth client from Google Cloud Console, or use a "
                "service-account file."
            )
        credentials = None
        if token_path and token_path.exists():
            credentials = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        if not credentials or not credentials.valid:
            if credentials and credentials.expired and credentials.refresh_token:
                credentials.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    str(credentials_path), SCOPES
                )
                credentials = flow.run_local_server(port=0)
            if token_path:
                token_path.parent.mkdir(parents=True, exist_ok=True)
                token_path.write_text(credentials.to_json(), encoding="utf-8")
    return build("calendar", "v3", credentials=credentials, cache_discovery=False)


def _existing_events(service, calendar_id: str) -> dict[str, dict]:
    found: dict[str, dict] = {}
    page_token = None
    while True:
        response = (
            service.events()
            .list(
                calendarId=calendar_id,
                privateExtendedProperty="kula_source=kula-panchang",
                maxResults=2500,
                singleEvents=False,
                showDeleted=False,
                pageToken=page_token,
            )
            .execute()
        )
        for item in response.get("items", []):
            key = (item.get("iCalUID") or "").strip()
            if not key:
                key = (
                    ((item.get("extendedProperties") or {}).get("private") or {}).get(
                        "kula_uid"
                    )
                    or item.get("id")
                    or ""
                )
            if key:
                found[key] = item
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return found


def sync(
    config: AppConfig,
    events: list[PanchangEvent],
    *,
    calendar_id: str | None = None,
    dry_run: bool = False,
    prune: bool = False,
) -> dict:
    """Create or update events, matching on the stable iCalendar UID."""

    settings = config.google
    calendar_id = calendar_id or settings.calendar_id
    service = build_service(config)
    existing = _existing_events(service, calendar_id)
    summary = {"inserted": 0, "updated": 0, "unchanged": 0, "deleted": 0, "dry_run": dry_run}
    seen: set[str] = set()

    for event in events:
        key = event.uid
        seen.add(key)
        body = event_to_google(event, config.calendar, event.location.timezone)
        body["extendedProperties"]["private"]["kula_uid"] = key
        current = existing.get(key)
        if current:
            # Avoid a write when the date/summary did not change.
            unchanged = (
                current.get("summary") == body["summary"]
                and (current.get("start") or {}).get("date") == (body["start"] or {}).get("date")
                and (current.get("start") or {}).get("dateTime") == (body["start"] or {}).get("dateTime")
            )
            if unchanged:
                summary["unchanged"] += 1
                continue
            summary["updated"] += 1
            if not dry_run:
                service.events().update(
                    calendarId=calendar_id,
                    eventId=current["id"],
                    body=body,
                    sendUpdates="none",
                ).execute()
        else:
            summary["inserted"] += 1
            if not dry_run:
                service.events().insert(
                    calendarId=calendar_id,
                    body=body,
                    sendUpdates="none",
                ).execute()

    if prune:
        for key, item in existing.items():
            if key in seen:
                continue
            summary["deleted"] += 1
            if not dry_run:
                service.events().delete(
                    calendarId=calendar_id, eventId=item["id"], sendUpdates="none"
                ).execute()
    return summary
