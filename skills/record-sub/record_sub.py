#!/usr/bin/env python3
"""
Record subscription skill for the subscriptions tracker agent.
Upserts subscriptions into subs.sqlite by vendor (dedup).
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

def monthly_equiv(price: float, cycle: str) -> float:
    """ponytail: simple cycle-to-monthly conversion."""
    cycles = {
        'weekly': 52 / 12,
        'monthly': 1.0,
        'quarterly': 4 / 12,
        'yearly': 1 / 12,
        'oneoff': 0.0,
    }
    return price * cycles.get(cycle, 1.0)

def upsert_sub(db_path: str, vendor: str, name: str, category: str, price: float, currency: str, cycle: str,
               description: str = '', status: str = 'active', started_at: str = '', trial_ends_at: str = '',
               next_charge_at: str = '', source_email_id: str = '', url: str = '', notes: str = '') -> None:
    """Upsert a subscription by vendor (dedup key)."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    equiv = monthly_equiv(price, cycle)
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

    c.execute('''
        INSERT INTO subscriptions
        (name, vendor, category, description, price, currency, cycle, monthly_equiv,
         status, started_at, trial_ends_at, next_charge_at, source_email_id, url, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vendor) DO UPDATE SET
          name = excluded.name,
          category = excluded.category,
          description = excluded.description,
          price = excluded.price,
          currency = excluded.currency,
          cycle = excluded.cycle,
          monthly_equiv = excluded.monthly_equiv,
          status = excluded.status,
          started_at = excluded.started_at,
          trial_ends_at = excluded.trial_ends_at,
          next_charge_at = excluded.next_charge_at,
          url = excluded.url,
          notes = excluded.notes,
          updated_at = excluded.updated_at
    ''', (name, vendor, category, description, price, currency, cycle, equiv, status,
          started_at, trial_ends_at, next_charge_at, source_email_id, url, notes, now, now))
    conn.commit()
    export_to_json(db_path)
    conn.close()

def export_to_json(db_path: str) -> None:
    """Export all subscriptions from the DB to subscriptions.json in webapp."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM subscriptions ORDER BY started_at DESC")
    rows = c.fetchall()
    conn.close()

    subs = []
    for r in rows:
        d = dict(r)
        d['price'] = float(d['price'])
        d['monthly_equiv'] = float(d['monthly_equiv'])
        subs.append(d)

    webapp_dir = os.path.abspath(os.path.join(os.path.dirname(db_path), '..', 'webapp'))
    os.makedirs(webapp_dir, exist_ok=True)
    json_path = os.path.join(webapp_dir, 'subscriptions.json')
    
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(subs, f, indent=2)
    print(f"Exported {len(subs)} subscriptions to {json_path}")

def update_email_state(db_path: str, last_scanned_ts: str = '', seen_ids: list = None) -> None:
    """Update email_state checkpoint. Merges new seen_ids with existing ones."""
    if seen_ids is None:
        seen_ids = []
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Get current seen_ids and merge
    current = c.execute('SELECT seen_ids FROM email_state WHERE id = 1').fetchone()
    current_ids = json.loads(current[0] if current and current[0] else '[]')
    merged_ids = sorted(set(current_ids + seen_ids))

    c.execute('''
        UPDATE email_state
        SET last_scanned_ts = ?,
            seen_ids = ?
        WHERE id = 1
    ''', (last_scanned_ts, json.dumps(merged_ids)))
    conn.commit()
    conn.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--action', required=True, choices=['upsert_sub', 'update_email_state'])
    parser.add_argument('--db', required=True)

    # upsert_sub fields
    parser.add_argument('--vendor', default='')
    parser.add_argument('--name', default='')
    parser.add_argument('--category', default='')
    parser.add_argument('--description', default='')
    parser.add_argument('--price', type=float, default=0.0)
    parser.add_argument('--currency', default='USD')
    parser.add_argument('--cycle', default='monthly')
    parser.add_argument('--status', default='active')
    parser.add_argument('--started_at', default='')
    parser.add_argument('--trial_ends_at', default='')
    parser.add_argument('--next_charge_at', default='')
    parser.add_argument('--source_email_id', default='')
    parser.add_argument('--url', default='')
    parser.add_argument('--notes', default='')

    # update_email_state fields
    parser.add_argument('--last_scanned_ts', default='')
    parser.add_argument('--seen_ids', default='[]')

    args = parser.parse_args()

    if args.action == 'upsert_sub':
        if not args.vendor or not args.name or not args.category or args.price < 0:
            print('Error: upsert_sub requires --vendor, --name, --category, --price', file=sys.stderr)
            sys.exit(1)
        upsert_sub(
            args.db, args.vendor, args.name, args.category,
            args.price, args.currency, args.cycle,
            args.description, args.status, args.started_at, args.trial_ends_at,
            args.next_charge_at, args.source_email_id, args.url, args.notes
        )
        print(f'Upserted subscription: {args.vendor}')

    elif args.action == 'update_email_state':
        seen_ids = json.loads(args.seen_ids) if args.seen_ids != '[]' else []
        update_email_state(args.db, args.last_scanned_ts, seen_ids)
        print(f'Updated email state: last_scanned={args.last_scanned_ts}')

if __name__ == '__main__':
    main()

# Self-check: verify monthly_equiv math on a few cycles
assert abs(monthly_equiv(52, 'weekly') - 52 * 52/12) < 0.01
assert abs(monthly_equiv(12, 'monthly') - 12) < 0.01
assert abs(monthly_equiv(120, 'yearly') - 10) < 0.01
