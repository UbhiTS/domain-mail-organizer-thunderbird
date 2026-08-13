# Vendored dependencies

## `extension/vendor/psl.mjs`

- Package: `psl`
- Version: `1.15.0`
- Package release: https://www.npmjs.com/package/psl/v/1.15.0
- Original file: `dist/psl.mjs`
- Exact distribution file:
  https://github.com/lupomontero/psl/blob/v1.15.0/dist/psl.mjs
- Tagged parser source:
  https://github.com/lupomontero/psl/blob/v1.15.0/index.js
- Tagged generated rule data:
  https://github.com/lupomontero/psl/blob/v1.15.0/data/rules.js
- Complete tagged source: https://github.com/lupomontero/psl/tree/v1.15.0
- Distribution SHA-256:
  `66463ab217d9ac57174eb89b100058b450588ce6c8da577e6bf41c074d6514b7`
- License: MIT (`extension/vendor/PSL-LICENSE.txt`)
- License-file SHA-256:
  `ae8c4a3b09681bc30ecbc984d58c4dc2c21b56d320fc02f558d12e86995c26c8`
- Local changes: none

This pinned Public Suffix List parser prevents exact-domain customer rules from
accepting broad suffixes such as `co.uk` and unintentionally claiming unrelated
organizations.

The embedded rule data is based on the Mozilla Public Suffix List. Its source
code form and MPL 2.0 notice are available at
https://publicsuffix.org/list/public_suffix_list.dat.
