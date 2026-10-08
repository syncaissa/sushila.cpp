#!/usr/bin/env python3
"""Create or update every DynamoDB table and index the sushila.ai worker uses (all named sushilaai-*).

For each table in SCHEMA below, the script checks what exists and makes it match:
  - missing table                      -> created (on-demand billing, the keys and indexes below)
  - missing index                      -> added (one index change at a time, as DynamoDB requires)
  - index no longer in SCHEMA          -> removed (only with --prune; otherwise reported)
  - index whose keys or projection differ -> removed and re-added (only with --prune)
  - billing mode, TTL, point-in-time recovery, deletion protection -> set as below
  - table whose primary key differs    -> cannot be changed in place; reported. With --recreate-empty the table is
                                          deleted and recreated, but only if it holds no items.
  --migrate-users                       -> one-time move of sushilaai-users from the old key (email) to userId: backs every
                                          row up to backups/<table>-<time>.json, recreates the table, gives each account a
                                          new userId, and repoints its rows in sushilaai-emails (and sushilaai-downloads).
  --backfill                            -> one-time: give existing rows the index keys the worker now lists by (listKey on
                                          users, models and comparison runs; adminKey on admins). Adds attributes only.
The worker never scans a table: every list is a Query on an index above (listKey / adminKey are constant partition keys),
and every other read is by key. Nothing is deleted without one of those flags. Run with --dry-run to see the plan without changing anything.

Usage:  python3 dynamodb_tables.py --region us-east-1 [--dry-run] [--prune] [--recreate-empty] [--profile NAME]
Needs botocore (installed with the AWS CLI; or: pip install botocore) and credentials allowed to manage these tables.
"""
import argparse
import json
import os
import secrets
import sys
import time

import botocore.session

# Every table and index. Keys are strings. Keep this in step with TABLES in worker.js.
SCHEMA = {
    'sushilaai-users': {                 # one row per account; key = permanent random userId (e-mails can change)
        'hash': 'userId',
        'indexes': {'list-index': {'hash': 'listKey', 'range': 'createdAt', 'projection': 'ALL'},     # every account, newest first (listKey "user")
                    'admin-index': {'hash': 'adminKey', 'range': 'createdAt', 'projection': 'ALL'}},  # sparse: only admins have adminKey "admin"
        'pitr': True, 'protect': True,
    },
    'sushilaai-emails': {                # every verified e-mail -> userId of its account
        'hash': 'email',
        'indexes': {'userId-index': {'hash': 'userId', 'projection': 'KEYS_ONLY'}},
        'pitr': True, 'protect': True,
    },
    'sushilaai-otps': {                  # pending sign-in code (keyed hash); removed by TTL
        'hash': 'email',
        'ttl': 'ttl',
    },
    'sushilaai-downloads': {             # one row per download
        'hash': 'userId', 'range': 'downloadedAt',
        'indexes': {'modelId-downloadedAt-index': {'hash': 'modelId', 'range': 'downloadedAt', 'projection': 'ALL'}},
        'pitr': True, 'protect': True,
    },
    'sushilaai-download': {              # every download of an installer, engine, pack or model file: one row per download
        'hash': 'file', 'range': 'at',   # (file, ip, country, system, kind, time; TTL 12 months) + a '#count' row per file
        'indexes': {'day-index': {'hash': 'day', 'range': 'at', 'projection': 'ALL'}},
        'ttl': 'ttl', 'pitr': True,
    },
    'sushilaai-models': {                # hosted models, their precomputed artifacts, visible flag (admin page)
        'hash': 'modelId',
        'indexes': {'list-index': {'hash': 'listKey', 'range': 'modelId', 'projection': 'ALL'}},    # every model (listKey "model")
        'pitr': True, 'protect': True,
    },
    'sushilaai-bugs': {                  # bug reports: item "bug" = the report, "c#<time>#<id>" = its comments
        'hash': 'bugId', 'range': 'item',
        'indexes': {'list-index': {'hash': 'listKey', 'range': 'createdAt', 'projection': 'ALL'},          # every report (admins)
                    'reporter-index': {'hash': 'reporterUserId', 'range': 'createdAt', 'projection': 'ALL'}},  # a user's reports
        'pitr': True, 'protect': True,
    },
    'sushilaai-waitlist': {              # serverless-API early access
        'hash': 'email',
        'pitr': True,
    },
    'sushilaai-compare': {               # admin "Compare Speeds": one row per comparison pod (pod id, model, prompts, results)
        'hash': 'runId',
        'indexes': {'list-index': {'hash': 'listKey', 'range': 'createdAt', 'projection': 'ALL'}},  # runs by time (listKey "run")
        'pitr': True,
    },
    'sushilaai-audit': {                 # sign-ups, sign-ins, e-mail changes, downloads, admin changes; views of shared links
        'hash': 'day', 'range': 'at',    # (at "view#<link id>#<visitor>": url, ip, hits, counted; one per visitor, link and day)
    },
    'sushilaai-reportabuse': {           # every report from sushila.ai/reportabuse (link, reason, details, e-mail, time, IP)
        'hash': 'reportId',
        'pitr': True, 'protect': True,
    },
    'sushilaai-localhost-links': {       # temporary internet URLs (sushila.ai/localhost/<id>/): target, userId, ip, time, status (cleared monthly)
        'hash': 'id',
        'indexes': {'user-index': {'hash': 'userId', 'range': 'createdAt', 'projection': 'ALL'}},  # My content -> Internet links
    },
    'sushilaai-file-views': {            # one row per shared link sushila.ai/c/<12 hex>: url "/c/<id>", userId (owner), views
        'hash': 'url',                   # (the row is the link: it is made first, so ids are unique, and names the owner's folder)
        'indexes': {'trash-index': {'hash': 'trashKey', 'range': 'trashedAt', 'projection': 'ALL'}},  # sparse: My content's trash (cron purge)
        'pitr': True, 'protect': True,
    },
}
TAGS = [{'Key': 'project', 'Value': 'sushila.ai'}]


class FreshClient:
    """A DynamoDB client that reloads credentials and retries once when they expire mid-run (rotating session tokens)."""
    RETRY = ('ExpiredToken', 'UnrecognizedClient', 'InvalidClientTokenId', 'RequestExpired')

    def __init__(self, profile, region):
        self.profile, self.region = profile, region
        self._new()

    def _new(self):
        self.c = botocore.session.Session(profile=self.profile).create_client('dynamodb', region_name=self.region)
        self.exceptions = self.c.exceptions

    def get_waiter(self, name):
        return self.c.get_waiter(name)

    def __getattr__(self, name):
        def call(*a, **k):
            try:
                return getattr(self.c, name)(*a, **k)
            except Exception as e:  # noqa: BLE001
                if not any(t in str(e) for t in self.RETRY):
                    raise
                time.sleep(3)
                self._new()
                return getattr(self.c, name)(*a, **k)
        return call


def key_schema(spec):
    ks = [{'AttributeName': spec['hash'], 'KeyType': 'HASH'}]
    if spec.get('range'):
        ks.append({'AttributeName': spec['range'], 'KeyType': 'RANGE'})
    return ks


def gsi_def(name, spec):
    return {'IndexName': name, 'KeySchema': key_schema(spec), 'Projection': {'ProjectionType': spec['projection']}}


def attr_defs(spec):
    names = {spec['hash'], spec.get('range')}
    for ix in spec.get('indexes', {}).values():
        names |= {ix['hash'], ix.get('range')}
    return [{'AttributeName': n, 'AttributeType': 'S'} for n in sorted(x for x in names if x)]


class Reconciler:
    def __init__(self, ddb, dry, prune, recreate):
        self.ddb, self.dry, self.prune, self.recreate = ddb, dry, prune, recreate
        self.problems = []

    def act(self, msg, fn=None, *a, **k):
        print(('  [plan] ' if self.dry else '  ') + msg)
        if not self.dry and fn:
            return fn(*a, **k)

    def describe(self, name):
        try:
            return self.ddb.describe_table(TableName=name)['Table']
        except self.ddb.exceptions.ResourceNotFoundException:
            return None

    def wait_active(self, name):
        if self.dry:
            return
        while True:
            t = self.describe(name)
            if t and t['TableStatus'] == 'ACTIVE' and all(g['IndexStatus'] == 'ACTIVE' for g in t.get('GlobalSecondaryIndexes', [])):
                return
            time.sleep(5)

    def create(self, name, spec):
        args = dict(TableName=name, BillingMode='PAY_PER_REQUEST', KeySchema=key_schema(spec), AttributeDefinitions=attr_defs(spec),
                    Tags=TAGS, DeletionProtectionEnabled=bool(spec.get('protect')))
        if spec.get('indexes'):
            args['GlobalSecondaryIndexes'] = [gsi_def(n, s) for n, s in spec['indexes'].items()]
        self.act(f'create table {name} (keys {[k["AttributeName"] for k in args["KeySchema"]]}, '
                 f'indexes {list(spec.get("indexes", {}))})', self.ddb.create_table, **args)
        self.wait_active(name)

    def reconcile(self, name, spec):
        print(name)
        t = self.describe(name)
        if t is None:
            self.create(name, spec)
            t = self.describe(name)
        elif [(k['AttributeName'], k['KeyType']) for k in t['KeySchema']] != [(k['AttributeName'], k['KeyType']) for k in key_schema(spec)]:
            have = [k['AttributeName'] for k in t['KeySchema']]
            want = [k['AttributeName'] for k in key_schema(spec)]
            if not self.recreate:
                self.problems.append(f'{name}: primary key is {have}, schema wants {want} (needs --recreate-empty)')
                print(f'  ! primary key {have} differs from {want}; a key cannot be changed in place')
                return
            if self.ddb.scan(TableName=name, Limit=1, Select='COUNT')['Count'] > 0:
                self.problems.append(f'{name}: primary key differs and the table has items; migrate it by hand')
                print('  ! table has items: not recreating')
                return
            if t.get('DeletionProtectionEnabled'):
                self.act('turn off deletion protection', self.ddb.update_table, TableName=name, DeletionProtectionEnabled=False)
            self.act(f'delete empty table {name} (wrong key)', self.ddb.delete_table, TableName=name)
            if not self.dry:
                self.ddb.get_waiter('table_not_exists').wait(TableName=name)
            self.create(name, spec)
            t = self.describe(name)
        else:
            print('  table ok')
        if t is None:  # dry run of a new table
            return
        # billing mode
        if t.get('BillingModeSummary', {}).get('BillingMode', 'PROVISIONED') != 'PAY_PER_REQUEST':
            self.act('switch to on-demand billing', self.ddb.update_table, TableName=name, BillingMode='PAY_PER_REQUEST')
            self.wait_active(name)
        # indexes: one change per UpdateTable call
        have = {g['IndexName']: g for g in t.get('GlobalSecondaryIndexes', [])}
        want = spec.get('indexes', {})
        for ix, g in have.items():
            same = ix in want and [(k['AttributeName'], k['KeyType']) for k in g['KeySchema']] == \
                [(k['AttributeName'], k['KeyType']) for k in key_schema(want[ix])] and g['Projection']['ProjectionType'] == want[ix]['projection']
            if same:
                print(f'  index {ix} ok')
                continue
            why = 'not in schema' if ix not in want else 'keys or projection differ'
            if not self.prune:
                self.problems.append(f'{name}: index {ix} {why} (use --prune to replace or remove it)')
                print(f'  ! index {ix} {why}; kept (use --prune)')
                continue
            self.act(f'delete index {ix} ({why})', self.ddb.update_table, TableName=name, GlobalSecondaryIndexUpdates=[{'Delete': {'IndexName': ix}}])
            self.wait_active(name)
        t = self.describe(name) or t
        present = {g['IndexName'] for g in t.get('GlobalSecondaryIndexes', [])}
        if self.dry:  # a dry run deletes nothing: treat planned deletions as gone
            present -= {ix for ix in have if ix not in want or self.prune}
        for ix, s in want.items():
            if ix in present:  # matching, or differing and kept (reported above)
                continue
            self.act(f'add index {ix} (keys {[k["AttributeName"] for k in key_schema(s)]}, {s["projection"]})', self.ddb.update_table,
                     TableName=name, AttributeDefinitions=attr_defs(spec), GlobalSecondaryIndexUpdates=[{'Create': gsi_def(ix, s)}])
            self.wait_active(name)
        # time to live
        ttl = self.ddb.describe_time_to_live(TableName=name)['TimeToLiveDescription']
        want_ttl = spec.get('ttl')
        if want_ttl and not (ttl.get('TimeToLiveStatus') in ('ENABLED', 'ENABLING') and ttl.get('AttributeName') == want_ttl):
            if ttl.get('TimeToLiveStatus') in ('ENABLED', 'ENABLING'):
                self.act(f'turn off TTL on {ttl.get("AttributeName")}', self.ddb.update_time_to_live, TableName=name,
                         TimeToLiveSpecification={'Enabled': False, 'AttributeName': ttl['AttributeName']})
            self.act(f'turn on TTL ({want_ttl})', self.ddb.update_time_to_live, TableName=name,
                     TimeToLiveSpecification={'Enabled': True, 'AttributeName': want_ttl})
        elif want_ttl:
            print(f'  TTL ok ({want_ttl})')
        elif ttl.get('TimeToLiveStatus') in ('ENABLED', 'ENABLING'):
            self.act(f'turn off TTL ({ttl.get("AttributeName")})', self.ddb.update_time_to_live, TableName=name,
                     TimeToLiveSpecification={'Enabled': False, 'AttributeName': ttl['AttributeName']})
        # point-in-time recovery
        pitr = self.ddb.describe_continuous_backups(TableName=name)['ContinuousBackupsDescription'] \
            .get('PointInTimeRecoveryDescription', {}).get('PointInTimeRecoveryStatus') == 'ENABLED'
        if pitr != bool(spec.get('pitr')):
            try:
                self.act(f'{"turn on" if spec.get("pitr") else "turn off"} point-in-time recovery', self.ddb.update_continuous_backups,
                         TableName=name, PointInTimeRecoverySpecification={'PointInTimeRecoveryEnabled': bool(spec.get('pitr'))})
            except Exception as e:  # noqa: BLE001
                if 'ContinuousBackupsUnavailable' not in str(e):
                    raise
                print('  point-in-time recovery is still being switched on; run again later to confirm')
        else:
            print(f'  point-in-time recovery {"on" if pitr else "off"} ok')
        # deletion protection
        if bool(t.get('DeletionProtectionEnabled')) != bool(spec.get('protect')):
            self.act(f'{"turn on" if spec.get("protect") else "turn off"} deletion protection', self.ddb.update_table,
                     TableName=name, DeletionProtectionEnabled=bool(spec.get('protect')))
            self.wait_active(name)
        else:
            print(f'  deletion protection {"on" if spec.get("protect") else "off"} ok')


def migrate_users(ddb, dry):
    """Old layout: users keyed by email (with primaryEmail on e-mail rows). New: users keyed by a random userId."""
    t = ddb.describe_table(TableName='sushilaai-users')['Table']
    if [k['AttributeName'] for k in t['KeySchema']] != ['email']:
        print('sushilaai-users already keyed by userId: nothing to migrate')
        return
    items, start = [], None
    while True:
        r = ddb.scan(TableName='sushilaai-users', **({'ExclusiveStartKey': start} if start else {}))
        items += r['Items']; start = r.get('LastEvaluatedKey')
        if not start:
            break
    os.makedirs('backups', exist_ok=True)
    path = f'backups/sushilaai-users-{time.strftime("%Y%m%d-%H%M%S")}.json'
    json.dump(items, open(path, 'w'), indent=1)
    print(f'backed up {len(items)} user rows to {path}')
    if dry:
        print('  [plan] recreate sushilaai-users keyed by userId and repoint e-mails'); return
    new = []
    for it in items:
        uid = 'u_' + secrets.token_hex(12)
        email = it['email']['S']
        row = {k: v for k, v in it.items() if k != 'email'}
        row.update({'userId': {'S': uid}, 'primaryEmail': {'S': email}})
        row.setdefault('isAdmin', {'BOOL': False})
        new.append((uid, row, row.get('emails', {}).get('SS', [email])))
    if t.get('DeletionProtectionEnabled'):
        ddb.update_table(TableName='sushilaai-users', DeletionProtectionEnabled=False)
        ddb.get_waiter('table_exists').wait(TableName='sushilaai-users')
    ddb.delete_table(TableName='sushilaai-users')
    ddb.get_waiter('table_not_exists').wait(TableName='sushilaai-users')
    ddb.create_table(TableName='sushilaai-users', BillingMode='PAY_PER_REQUEST', KeySchema=[{'AttributeName': 'userId', 'KeyType': 'HASH'}],
                     AttributeDefinitions=[{'AttributeName': 'userId', 'AttributeType': 'S'}], Tags=TAGS, DeletionProtectionEnabled=True)
    ddb.get_waiter('table_exists').wait(TableName='sushilaai-users')
    for uid, row, emails in new:
        ddb.put_item(TableName='sushilaai-users', Item=row)
        for e in emails:
            ddb.update_item(TableName='sushilaai-emails', Key={'email': {'S': e}}, UpdateExpression='SET userId = :u REMOVE primaryEmail',
                            ExpressionAttributeValues={':u': {'S': uid}})
        print(f'  {row["primaryEmail"]["S"]} -> {uid} ({len(emails)} e-mail{"s" if len(emails) != 1 else ""})')
    print(f'migrated {len(new)} accounts')


def backfill(ddb, dry):
    """One-time: rows written before the list indexes existed get their index keys (adds attributes, changes nothing else).
    It reads each of the three small tables once (the only scan, run by hand, never by the worker)."""
    for table, key, value in [('sushilaai-users', 'userId', 'user'), ('sushilaai-models', 'modelId', 'model'), ('sushilaai-compare', 'runId', 'run')]:
        start, n, admins = None, 0, 0
        while True:
            r = ddb.scan(TableName=table, **({'ExclusiveStartKey': start} if start else {}))
            for it in r['Items']:
                sets, vals = [], {}
                if 'listKey' not in it:
                    sets.append('listKey = :l'); vals[':l'] = {'S': value}
                if table == 'sushilaai-users' and 'createdAt' not in it:
                    sets.append('createdAt = :c'); vals[':c'] = {'S': it.get('lastLoginAt', {}).get('S', '2026-01-01T00:00:00.000Z')}
                if table == 'sushilaai-compare' and 'createdAt' not in it:
                    sets.append('createdAt = :c'); vals[':c'] = {'S': '2026-01-01T00:00:00.000Z'}
                if table == 'sushilaai-users' and it.get('isAdmin', {}).get('BOOL') and 'adminKey' not in it:
                    sets.append('adminKey = :a'); vals[':a'] = {'S': 'admin'}; admins += 1
                if sets:
                    n += 1
                    if not dry:
                        ddb.update_item(TableName=table, Key={key: it[key]}, UpdateExpression='SET ' + ', '.join(sets),
                                        ConditionExpression=f'attribute_exists({key})', ExpressionAttributeValues=vals)
            start = r.get('LastEvaluatedKey')
            if not start:
                break
        print(f'{table}: {n} row{"s" if n != 1 else ""} {"would get" if dry else "got"} index keys' + (f' ({admins} admin{"s" if admins != 1 else ""})' if table == 'sushilaai-users' else ''))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--region', required=True)
    ap.add_argument('--profile')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--prune', action='store_true', help='remove or replace indexes that differ from SCHEMA')
    ap.add_argument('--recreate-empty', action='store_true', help='recreate EMPTY tables whose primary key differs')
    ap.add_argument('--migrate-users', action='store_true', help='move sushilaai-users from the old email key to userId (backs up first)')
    ap.add_argument('--backfill', action='store_true', help='one-time: add listKey/adminKey to rows written before the list indexes')
    a = ap.parse_args()
    sess = botocore.session.Session(profile=a.profile)
    ddb = FreshClient(a.profile, a.region)
    who = sess.create_client('sts', region_name=a.region).get_caller_identity()
    print(f'account {who["Account"]}, region {a.region}{" (dry run)" if a.dry_run else ""}\n')
    if a.migrate_users:
        migrate_users(ddb, a.dry_run)
    r = Reconciler(ddb, a.dry_run, a.prune, a.recreate_empty)
    for name, spec in SCHEMA.items():
        r.reconcile(name, spec)
    if a.backfill:
        print()
        backfill(ddb, a.dry_run)
    extra = [t for t in ddb.list_tables()['TableNames'] if t.startswith('sushilaai-') and t not in SCHEMA]
    if extra:
        print(f'\nnote: sushilaai-* tables not in SCHEMA (left alone): {extra}')
    if r.problems:
        print('\nneeds attention:\n  ' + '\n  '.join(r.problems))
        sys.exit(1)
    print('\ndry run: nothing changed' if a.dry_run else '\nall tables match the schema')


if __name__ == '__main__':
    main()
