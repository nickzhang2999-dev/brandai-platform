"""Verify exact approved branch coverage and retain product image acceptance gates."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
APPROVED = {
    'main', 'devUpdate1012', 'claude/novart-product-integration', 'claude/layer-quality',
    'fix/p1-remove-captured-bundle', 'fix/p2-security',
    'fix/p3-ai-reliability', 'fix/p4-frontend', 'chore/p5-engineering',
}


class ProductWorkflowTests(unittest.TestCase):
    def test_packaged_ai_gate_matches_web_required_capabilities(self):
        """A client capability upgrade must not leave the image gate on r1."""
        source = (ROOT / '.github/workflows/novart-integration.yml').read_text(encoding='utf-8')
        web = (ROOT / 'apps/web/src/lib/ai-service.ts').read_text(encoding='utf-8')
        for field, constant in (
            ('studioDecompositionRevision', 'REQUIRED_AI_STUDIO_DECOMPOSITION_REVISION'),
            ('studioDecompositionQueueRevision', 'REQUIRED_AI_STUDIO_DECOMPOSITION_QUEUE_REVISION'),
            ('studioLayerPlanRevision', 'REQUIRED_AI_STUDIO_LAYER_PLAN_REVISION'),
        ):
            required = re.search(r'export const ' + constant + r' = "([a-z0-9-]+)";', web)
            self.assertIsNotNone(required, constant)
            asserted = re.findall(r"assert ai_health\.get\('" + field + r"'\) == '([a-z0-9-]+)'", source)
            self.assertEqual(asserted, [required[1]], field)

    def test_push_and_both_dispatch_guards_allow_exactly_approved_branches(self):
        wrapper = (ROOT / '.github/workflows/branch-image.yml').read_text(encoding='utf-8')
        product = (ROOT / '.github/workflows/novart-integration.yml').read_text(encoding='utf-8')
        values = re.search(r'^    branches: \[([^\]]+)\]$', wrapper, re.MULTILINE)
        self.assertIsNotNone(values)
        self.assertEqual({v.strip().strip("'\"") for v in values[1].split(',')}, APPROVED)
        for source in (wrapper, product):
            guards = re.findall(r'^    if: (.+)$', source, re.MULTILINE)
            self.assertEqual(len(guards), 1)
            predicates = guards[0].split(' || ')
            self.assertEqual(set(predicates), {"github.ref == 'refs/heads/" + name + "'" for name in APPROVED})
            self.assertEqual(len(predicates), len(APPROVED))
            self.assertNotIn('previews/novart-workbench', source)

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
