# Third-party resource provenance

This directory contains an independent NovartLab interaction prototype and captured third-party browser resources. It is not the upstream Lovart source repository. A downloaded browser build and a source hash do not establish a license or redistribution permission.

## Captured build

- Origin: `https://web-static3.lovart.ai/lovart_canvas_online/`.
- Captured release: `1244-b282c318`; entry `canvas.325741a0.js`; runtime `runtime.dc1a2d6c.js`; editor `lovart-canvas.358a3a91.js`.
- Preserved inputs: `originals/`. Public resource URLs and SHA-256 values are recorded in `SOURCE_MANIFEST.json`, `originals/capture.json`, `originals/entry-dependencies.json`, and the two resource maps under `evidence/`.
- The snapshot includes Lovart application code, a bundled tldraw editor, and their transitive browser dependencies. Existing notices embedded in those files are retained.
- Additional captured resources include tldraw 5.4.2 fonts and translations from `cdn.tldraw.com`, Inter from `fonts.gstatic.com`, font catalogs from `web-static3.lovart.ai`, and a vendor avatar from `assets-persist.lovart.ai`.
- The prototype includes a Nova Art Lab logo supplied for this project.

No separate upstream LICENSE or permission grant was present in the captured snapshot. This prototype does not grant rights to those third-party resources and does not represent them as company-authored or newly open-sourced. Their applicable terms and any required permission must be established by the rights holder before use beyond the authorized scope. Repository-level licensing must not be assumed to override third-party rights.

## Local adaptations

The `harness/` Python adapters, UI shell, and bridges support isolated project persistence and frontend interaction review. Patch modules verify fixed source hashes and exact anchors before constructing derived browser responses in memory. The original files in `originals/` remain unchanged. The gateway routes captured external resource requests to this package rather than forwarding them to live business services.

The runtime uses Pillow, separately installed through `requirements.txt`; its distribution supplies its own license notices. This document is a provenance record, not a substitute for those licenses or a legal assessment.
