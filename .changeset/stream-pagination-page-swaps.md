---
"@confect/react": patch
---

Fix three page swap defects in the experimental `useStreamPaginatedQuery` and its `StreamPagination` state machine.

- A page whose replacement fails stays on screen. Previously a failed pin replaced the loaded page with the failure, and the page's items disappeared.
- A failed replacement is reported at once, even while a sibling replacement is still loading. Previously the failure stayed hidden until the sibling loaded. The page and its replacements stay subscribed, so a retry requests only the failed replacement.
- The hook stays `LoadingFirstPage` until the first page of the stream has loaded. Previously, once a split first page split again, the hook reported `LoadingMore` with no items.

`StreamPagination.interpret` now reports `firstPageLoaded` on its `Interpreted` and `Failed` results. It holds once the head page has its full result. Read it instead of counting pages, which splits make unreliable.
