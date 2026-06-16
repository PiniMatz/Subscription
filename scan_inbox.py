# scan_inbox.py
import os
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# Import record_sub modules
sys.path.append(os.path.join(os.path.dirname(__file__), 'skills', 'record-sub'))
from record_sub import upsert_sub, update_email_state

# Read-only scope is safe
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
DB_PATH = os.path.join(os.path.dirname(__file__), 'data', 'subs.sqlite')

# Common subscription vendors rules
VENDOR_RULES = [
  {"domain": "netflix.com", "vendor": "Netflix", "name": "Netflix Premium", "category": "Streaming", "desc": "Video streaming subscription"},
  {"domain": "spotify.com", "vendor": "Spotify", "name": "Spotify Premium", "category": "Music", "desc": "Music streaming subscription"},
  {"domain": "openai.com", "vendor": "OpenAI", "name": "ChatGPT Plus", "category": "Software/SaaS", "desc": "AI chat assistant"},
  {"domain": "adobe.com", "vendor": "Adobe", "name": "Adobe Creative Cloud", "category": "Software/SaaS", "desc": "Creative design tools"},
  {"domain": "github.com", "vendor": "GitHub", "name": "GitHub Copilot", "category": "Software/SaaS", "desc": "AI pair programmer"},
  {"domain": "apple.com", "vendor": "Apple", "name": "Apple Services", "category": "Cloud/Storage", "desc": "Apple cloud and media subscriptions"},
  {"domain": "google.com", "vendor": "Google", "name": "Google One Storage", "category": "Cloud/Storage", "desc": "Google cloud storage & features"},
  {"domain": "youtube.com", "vendor": "YouTube", "name": "YouTube Premium", "category": "Streaming", "desc": "Ad-free video streaming"},
  {"domain": "amazon.com", "vendor": "Amazon", "name": "Amazon Prime", "category": "Utilities", "desc": "Prime shopping & streaming"},
  {"domain": "duolingo.com", "vendor": "DuoLingo", "name": "DuoLingo Super", "category": "Software/SaaS", "desc": "Language learning subscription"}
]

def search_subscription_emails(service, last_scanned_ts=None):
    # Search receipt emails
    query = 'subject:(receipt OR invoice OR renewal OR trial OR confirmation OR charged OR "auto-renew" OR subscribe)'
    
    # Filter since last scan if available
    if last_scanned_ts:
        try:
            # Parse ISO date and format to YYYY/MM/DD for Gmail search
            dt = datetime.fromisoformat(last_scanned_ts.replace('Z', '+00:00'))
            date_query = dt.strftime(' after:%Y/%m/%d')
            query += date_query
        except Exception:
            pass

    print(f"Gmail Query: {query}")
    results = service.users().messages().list(userId='me', q=query, maxResults=50).execute()
    return results.get('messages', [])

def parse_email_data(service, msg_id):
    msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
    payload = msg.get('payload', {})
    headers = payload.get('headers', [])
    
    # Extract headers
    subject = next((h['value'] for h in headers if h['name'].lower() == 'subject'), '')
    sender = next((h['value'] for h in headers if h['name'].lower() == 'from'), '')
    date_str = next((h['value'] for h in headers if h['name'].lower() == 'date'), '')
    snippet = msg.get('snippet', '')
    
    # Find email body (fallback to snippet if body is complex)
    body = snippet
    parts = payload.get('parts', [])
    if not parts and 'body' in payload and 'data' in payload['body']:
        body_data = payload['body']['data']
        body = base64_decode(body_data)
    else:
        for part in parts:
            if part.get('mimeType') == 'text/plain' and 'data' in part.get('body', {}):
                body = base64_decode(part['body']['data'])
                break
            elif part.get('mimeType') == 'text/html' and 'data' in part.get('body', {}):
                body = base64_decode(part['body']['data'])
    
    # Parse sender email domain
    sender_email = sender
    match_email = re.search(r'[\w\.-]+@[\w\.-]+', sender)
    if match_email:
        sender_email = match_email.group(0)
    domain = sender_email.split('@')[-1].lower()
    
    # 1. Identify Vendor & Category
    vendor = domain.split('.')[0].capitalize()
    name = f"{vendor} Subscription"
    category = "Other"
    description = "Recurring subscription"
    
    for rule in VENDOR_RULES:
        if rule['domain'] in domain:
            vendor = rule['vendor']
            name = rule['name']
            category = rule['category']
            description = rule['desc']
            break
            
    # Adjust names/categories for Google/Apple if subject lists details
    if vendor == "Google" and "youtube" in subject.lower():
        vendor = "YouTube"
        name = "YouTube Premium"
        category = "Streaming"
        description = "Ad-free video streaming"
    elif vendor == "Apple" and "icloud" in subject.lower():
        name = "iCloud Storage"
        category = "Cloud/Storage"

    # 2. Extract Price & Currency
    # Look for $9.99, ₪49.90, €9.99, £12.00, etc.
    price = 0.0
    currency = "USD"
    
    # Regex to find currency symbols and values
    price_matches = re.findall(r'(ILS|\$|₪|€|£|USD|EUR|GBP)\s*([0-9]+(?:\.[0-9]{2})?)', body + " " + subject)
    # Reverse pattern (e.g. 49.90 ₪)
    price_matches_rev = re.findall(r'([0-9]+(?:\.[0-9]{2})?)\s*(ILS|\$|₪|€|£|USD|EUR|GBP)', body + " " + subject)
    
    currency_symbols = {
        '$': 'USD', 'USD': 'USD',
        '₪': 'ILS', 'ILS': 'ILS',
        '€': 'EUR', 'EUR': 'EUR',
        '£': 'GBP', 'GBP': 'GBP'
    }
    
    if price_matches:
        symbol, val = price_matches[0]
        price = float(val)
        currency = currency_symbols.get(symbol, "USD")
    elif price_matches_rev:
        val, symbol = price_matches_rev[0]
        price = float(val)
        currency = currency_symbols.get(symbol, "USD")
    else:
        # Fallback snippet scan
        price_match = re.search(r'([0-9]+\.[0-9]{2})', snippet)
        if price_match:
            price = float(price_match.group(1))

    # 3. Determine cycle
    cycle = "monthly"
    body_text = (body + " " + subject).lower()
    if any(x in body_text for x in ["year", "annual", "yearly", "/yr"]):
        cycle = "yearly"
    elif any(x in body_text for x in ["week", "weekly", "/wk"]):
        cycle = "weekly"
    elif any(x in body_text for x in ["quarter", "quarterly", "3 months"]):
        cycle = "quarterly"

    # 4. Check if Trial
    status = "active"
    trial_ends_at = ""
    if "trial" in subject.lower() or "trial" in snippet.lower():
        status = "trial"
        # Guess trial ends in 14 days
        try:
            from datetime import timedelta
            trial_end_dt = datetime.now() + timedelta(days=14)
            trial_ends_at = trial_end_dt.strftime('%Y-%m-%d')
        except Exception:
            pass

    # 5. Extract started date
    started_at = datetime.now().strftime('%Y-%m-%d')
    try:
        # Parse date from email (e.g. "Tue, 16 Jun 2026 14:30:00 -0700")
        # Strip timezone offsets for simpler parsing
        date_clean = re.sub(r'\s*[\+-]\d{4}\s*(\(.*?\))?$', '', date_str).strip()
        parsed_dt = datetime.strptime(date_clean, '%a, %d %b %Y %H:%M:%S')
        started_at = parsed_dt.strftime('%Y-%m-%d')
    except Exception:
        pass

    return {
        "vendor": vendor,
        "name": name,
        "category": category,
        "price": price,
        "currency": currency,
        "cycle": cycle,
        "status": status,
        "started_at": started_at,
        "trial_ends_at": trial_ends_at,
        "description": description,
        "url": f"https://{domain}",
        "notes": f"Imported automatically from Gmail invoice: \"{subject}\""
    }

def base64_decode(data):
    try:
        # base64url decode
        padded = data.replace('-', '+').replace('_', '/')
        padded += '=' * (4 - len(padded) % 4)
        return base64.b64decode(padded).decode('utf-8', errors='ignore')
    except Exception:
        return ""

def main():
    if not os.path.exists('token.json'):
        print("Error: token.json missing! Run gmail_auth.py first.")
        return
        
    # Read state checkpoint from SQLite
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("CREATE TABLE IF NOT EXISTS email_state (id INTEGER PRIMARY KEY, last_scanned_ts TEXT, seen_ids TEXT)")
    state_row = c.execute("SELECT last_scanned_ts, seen_ids FROM email_state WHERE id = 1").fetchone()
    
    last_scanned_ts = None
    seen_ids = []
    
    if state_row:
        last_scanned_ts, seen_ids_json = state_row
        seen_ids = json.loads(seen_ids_json) if seen_ids_json else []
    else:
        # Seed state row
        c.execute("INSERT INTO email_state (id, last_scanned_ts, seen_ids) VALUES (1, NULL, '[]')")
        conn.commit()
    conn.close()

    creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    service = build('gmail', 'v1', credentials=creds)
    
    print("Fetching email threads from Gmail...")
    messages = search_subscription_emails(service, last_scanned_ts)
    
    new_seen_ids = []
    new_subs_count = 0
    
    for m in messages:
        msg_id = m['id']
        if msg_id in seen_ids:
            continue
            
        try:
            print(f"\nProcessing Email ID: {msg_id}")
            sub_details = parse_email_data(service, msg_id)
            new_seen_ids.append(msg_id)
            
            # Skip emails where we failed to find a valid price (e.g. false alerts)
            if sub_details['price'] <= 0.0:
                print(f"Skipped: Could not parse price for vendor {sub_details['vendor']}")
                continue

            print(f"Parsed Subscription:")
            print(f"  Vendor: {sub_details['vendor']}")
            print(f"  Plan: {sub_details['name']}")
            print(f"  Price: {sub_details['price']} {sub_details['currency']} ({sub_details['cycle']})")
            print(f"  Category: {sub_details['category']}")
            print(f"  Started: {sub_details['started_at']}")
            
            # Upsert into SQLite (which also updates webapp/subscriptions.json!)
            upsert_sub(
                DB_PATH,
                vendor=sub_details['vendor'],
                name=sub_details['name'],
                category=sub_details['category'],
                price=sub_details['price'],
                currency=sub_details['currency'],
                cycle=sub_details['cycle'],
                description=sub_details['description'],
                status=sub_details['status'],
                started_at=sub_details['started_at'],
                trial_ends_at=sub_details['trial_ends_at'],
                url=sub_details['url'],
                notes=sub_details['notes'],
                source_email_id=msg_id
            )
            new_subs_count += 1
        except Exception as e:
            print(f"Error parsing email {msg_id}: {str(e)}")

    # Update state checkpoint with new seen IDs and last scanned timestamp
    merged_seen_ids = list(set(seen_ids + new_seen_ids))
    now_ts = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    update_email_state(DB_PATH, now_ts, merged_seen_ids)
    
    print("\n==============================================")
    print(f"Scan finished. Added {new_subs_count} new subscriptions.")
    print(f"Seen IDs count updated from {len(seen_ids)} to {len(merged_seen_ids)}")
    print("==============================================")

if __name__ == '__main__':
    main()