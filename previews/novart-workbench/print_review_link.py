"""Print a newly created room capability locally; never store it in source control."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    parser.add_argument('--room', default='preview')
    args = parser.parse_args()
    url = urlsplit(args.origin)
    local_http = url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1')
    if (url.scheme != 'https' and not local_http) or not url.netloc or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise SystemExit('Use a dedicated HTTPS origin, or HTTP localhost for local testing; no path or credentials.')
    if not args.room.replace('-', '').isalnum():
        raise SystemExit('Invalid room name')
    runtime = Path(__file__).resolve().parent / 'sharing' / args.room / 'runtime.json'
    state = json.loads(runtime.read_text('utf-8'))
    print(args.origin.rstrip('/') + state['entryPath'])


if __name__ == '__main__':
    main()
