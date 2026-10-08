"""One guarded transition boundary over the delivered M21 layout script."""
from hashlib import sha256

SOURCE_SHA256 = '0458107c2bf4edf43f8d243997a24c09541f9b15f61e489427237f1d6105fd06'
ANCHOR = b'''        if (isOpen(n) && !composing && !n.contains(document.activeElement)) document.querySelector('[data-testid="agent-collapse-button"]')?.click();'''
REPLACEMENT = b'''        if (isOpen(n) && !composing && !n.contains(document.activeElement)) {
          const collapse = document.querySelector('[data-testid="agent-collapse-button"]');
          if (collapse && !collapse.disabled) {
            collapse.click();
            // Native React commits the collapsed state after this event. Do not
            // briefly inert the focused canvas using the previous open state.
            schedule();
            return;
          }
        }'''

def build_layout(source: bytes) -> bytes:
    if not isinstance(source, bytes) or sha256(source).hexdigest() != SOURCE_SHA256:
        raise ValueError('M27 requires the delivered M21 layout source')
    if source.count(ANCHOR) != 1:
        raise ValueError('M27 layout transition anchor must be unique')
    result = source.replace(ANCHOR, REPLACEMENT, 1)
    if result.count(REPLACEMENT) != 1 or result.replace(REPLACEMENT, ANCHOR, 1) != source:
        raise ValueError('M27 layout transition inverse failed')
    return result

def manifest(source: bytes) -> dict:
    derived = build_layout(source)
    return {'sourceSha256': SOURCE_SHA256, 'derivedSha256': sha256(derived).hexdigest(),
        'anchorCount': source.count(ANCHOR), 'inverseExact': derived.replace(REPLACEMENT, ANCHOR, 1) == source,
        'scope': 'Defer one layout update after the existing automatic native chat collapse; no focus or document writes.'}
