# Developer guide deck (version 2)
`build.js` generates `../Robokalam-Learner-OS-Developer-Guide.pptx` (38 slides; version 1 was 29, version 2 adds Phases 10-13, the provider pattern, Hostinger settings and product coverage).
Needs `pptxgenjs`, `react`, `react-dom`, `react-icons`, `sharp` installed in a scratch folder, then: `NODE_PATH=<that>/node_modules node build.js out.pptx`. (`apply_theme.js` is only a polish step; `SKIP_THEME=1` skips it.)
