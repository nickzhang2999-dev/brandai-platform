"""Every development branch gets CI; only the project script may publish production."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ProductWorkflowTests(unittest.TestCase):
    def test_push_and_dispatch_verify_every_branch_without_a_hidden_whitelist(self):
        wrapper = (ROOT / '.github/workflows/branch-image.yml').read_text(encoding='utf-8')
        product = (ROOT / '.github/workflows/novart-integration.yml').read_text(encoding='utf-8')
        values = re.search(r'^    branches: \[([^\]]+)\]$', wrapper, re.MULTILINE)
        self.assertIsNotNone(values)
        self.assertEqual({v.strip().strip("'\"") for v in values[1].split(',')}, {'**'})
        for source in (wrapper, product):
            guards = re.findall(r'^    if: (.+)$', source, re.MULTILINE)
            self.assertEqual(guards, [], 'CI must not silently skip a normal development branch')
        release = (ROOT / 'cds-release.sh').read_text(encoding='utf-8')
        self.assertIn('verifyReleaseIdentity()', release)
        self.assertIn('git rev-parse HEAD', release)
        self.assertIn('brandai-novartlab-local-prod', release)
        verifier = (ROOT / 'deploy/novart/production/verify.mjs').read_text(encoding='utf-8')
        self.assertIn("env.CDS_BRANCH_NAME !== 'main'", verifier)

    def test_only_verified_product_images_are_published(self):
        source = (ROOT / '.github/workflows/novart-integration.yml').read_text(encoding='utf-8')
        steps = re.findall(r'^      - name: (.+)$', source, re.MULTILINE)
        publish = steps.index('Publish checked images')
        for gate in (
            'Owned React editor interaction regression with isolated fixtures',
            'Repository gates',
            'Real login, owned canvas, database and durable upload acceptance',
            'Validate Garage storage image and durable permissions',
            'Check the built containers against the disposable database',
        ):
            self.assertLess(steps.index(gate), publish)
        self.assertNotRegex(source, r'continue-on-error:\s*true')
        for command in ('pnpm test', 'pnpm test:ai', 'pnpm -F web typecheck', 'pnpm -F web build'):
            self.assertRegex(source, r'(?m)^          ' + re.escape(command) + r'$')


if __name__ == '__main__':
    unittest.main(verbosity=2)
