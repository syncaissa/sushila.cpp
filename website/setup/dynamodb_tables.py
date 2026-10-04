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
Nothing is deleted without one of those flags. Run with --dry-run to see the plan without changing anything.

Usage:  python3 dynamodb_tables.py --region us-east-1 [--dry-run] [--prune] [--recreate-empty] [--profile NAME]
Needs botocore (installed with the AWS CLI; or: pip install botocore) and credentials allowed to manage these tables.
"""
import argparse
import sys
import time

import botocore.session

# Every table and index. Keys are strings. Keep this in step with TABLES in worker.js.
SCHEMA = {
    'sushilaai-users': {                 # one row per account; key = primary e-mail
        'hash': 'email',
        'pitr': True, 'protect': True,
    },
    'sushilaai-emails': {                # every verified e-mail -> primaryEmail of its account
        'hash': 'email',
        'indexes': {'primaryEmail-index': {'hash': 'primaryEmail', 'projection': 'KEYS_ONLY'}},
        'pitr': True, 'protect': True,
    },
    'sushilaai-otps': {                  # pending sign-in code (keyed hash); removed by TTL
        'hash': 'email',
        'ttl': 'ttl',
    },
    'sushilaai-downloads': {             # one row per download
        'hash': 'userEmail', 'range': 'downloadedAt',
        'indexes': {'modelId-downloadedAt-index': {'hash': 'modelId', 'range': 'downloadedAt', 'projection': 'ALL'}},
        'pitr': True, 'protect': True,
    },
    'sushilaai-waitlist': {              # serverless-API early access
        'hash': 'email',
        'pitr': True,
    },
    'sushilaai-audit': {                 # sign-ups, sign-ins, e-mail changes, downloads
        'hash': 'day', 'range': 'at',
    },
}
TAGS = [{'Key': 'project', 'Value': 'sushila.ai'}]


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
            self.act(f'{"turn on" if spec.get("pitr") else "turn off"} point-in-time recovery', self.ddb.update_continuous_backups,
                     TableName=name, PointInTimeRecoverySpecification={'PointInTimeRecoveryEnabled': bool(spec.get('pitr'))})
        else:
            print(f'  point-in-time recovery {"on" if pitr else "off"} ok')
        # deletion protection
        if bool(t.get('DeletionProtectionEnabled')) != bool(spec.get('protect')):
            self.act(f'{"turn on" if spec.get("protect") else "turn off"} deletion protection', self.ddb.update_table,
                     TableName=name, DeletionProtectionEnabled=bool(spec.get('protect')))
            self.wait_active(name)
        else:
            print(f'  deletion protection {"on" if spec.get("protect") else "off"} ok')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--region', required=True)
    ap.add_argument('--profile')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--prune', action='store_true', help='remove or replace indexes that differ from SCHEMA')
    ap.add_argument('--recreate-empty', action='store_true', help='recreate EMPTY tables whose primary key differs')
    a = ap.parse_args()
    sess = botocore.session.Session(profile=a.profile)
    ddb = sess.create_client('dynamodb', region_name=a.region)
    who = sess.create_client('sts', region_name=a.region).get_caller_identity()
    print(f'account {who["Account"]}, region {a.region}{" (dry run)" if a.dry_run else ""}\n')
    r = Reconciler(ddb, a.dry_run, a.prune, a.recreate_empty)
    for name, spec in SCHEMA.items():
        r.reconcile(name, spec)
    extra = [t for t in ddb.list_tables()['TableNames'] if t.startswith('sushilaai-') and t not in SCHEMA]
    if extra:
        print(f'\nnote: sushilaai-* tables not in SCHEMA (left alone): {extra}')
    if r.problems:
        print('\nneeds attention:\n  ' + '\n  '.join(r.problems))
        sys.exit(1)
    print('\ndry run: nothing changed' if a.dry_run else '\nall tables match the schema')


if __name__ == '__main__':
    main()
