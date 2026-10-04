#!/usr/bin/env python3
"""Make a sushila.ai user an admin (or remove admin rights), by any e-mail address linked to the account.

Admins see the Admin menu on sushila.ai: the user list (filter, pages) and the model catalog (add, edit, show or hide).

Usage:
  python3 makeUserAdmin.py --region us-east-1 someone@example.com            grant admin
  python3 makeUserAdmin.py --region us-east-1 someone@example.com --revoke   remove admin
  python3 makeUserAdmin.py --region us-east-1 --list                         list current admins
The user must have signed up on sushila.ai first. Needs botocore (installed with the AWS CLI) and AWS credentials that
may read and update the sushilaai-emails and sushilaai-users tables. Changes are recorded in sushilaai-audit.
"""
import argparse
import datetime
import secrets
import sys

import botocore.session


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('email', nargs='?', help='any e-mail address linked to the account')
    ap.add_argument('--region', required=True, help='AWS region of the sushilaai-* tables (the worker\'s AWS_REGION)')
    ap.add_argument('--profile', help='AWS profile')
    ap.add_argument('--revoke', action='store_true', help='remove admin rights instead of granting them')
    ap.add_argument('--list', action='store_true', help='list the current admins')
    a = ap.parse_args()
    ddb = botocore.session.Session(profile=a.profile).create_client('dynamodb', region_name=a.region)

    if a.list:
        items, start = [], None
        while True:
            r = ddb.scan(TableName='sushilaai-users', FilterExpression='isAdmin = :t', ExpressionAttributeValues={':t': {'BOOL': True}},
                         **({'ExclusiveStartKey': start} if start else {}))
            items += r['Items']; start = r.get('LastEvaluatedKey')
            if not start:
                break
        for u in items:
            print(f"{u['userId']['S']}  {u.get('primaryEmail', {}).get('S', '')}  {u.get('firstName', {}).get('S', '')} {u.get('lastName', {}).get('S', '')}".rstrip())
        print(f'{len(items)} admin{"s" if len(items) != 1 else ""}')
        return

    if not a.email:
        ap.error('give an e-mail address, or --list')
    email = a.email.strip().lower()
    link = ddb.get_item(TableName='sushilaai-emails', Key={'email': {'S': email}}, ConsistentRead=True).get('Item')
    if not link:
        sys.exit(f'No account uses {email}. The user must sign up on sushila.ai first.')
    uid = link['userId']['S']
    user = ddb.get_item(TableName='sushilaai-users', Key={'userId': {'S': uid}}, ConsistentRead=True).get('Item')
    if not user:
        sys.exit(f'{email} points to user {uid}, which does not exist (inconsistent tables).')
    want = not a.revoke
    if user.get('isAdmin', {}).get('BOOL') is want:
        print(f"{user['primaryEmail']['S']} ({uid}) is {'already' if want else 'not'} an admin; nothing to do.")
        return
    ddb.update_item(TableName='sushilaai-users', Key={'userId': {'S': uid}}, UpdateExpression='SET isAdmin = :v',
                    ConditionExpression='attribute_exists(userId)', ExpressionAttributeValues={':v': {'BOOL': want}})
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    ddb.put_item(TableName='sushilaai-audit', Item={'day': {'S': now[:10]}, 'at': {'S': f'{now}#{secrets.token_hex(8)}'},
                 'event': {'S': 'admin-grant' if want else 'admin-revoke'}, 'userId': {'S': uid}, 'email': {'S': email}, 'by': {'S': 'makeUserAdmin.py'}})
    print(f"{user['primaryEmail']['S']} ({uid}) is {'now an admin' if want else 'no longer an admin'}.")


if __name__ == '__main__':
    main()
