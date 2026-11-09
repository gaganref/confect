// Each push's install args. The test rewrites this file between pushes.
export default {
  bulkEmail: { fromName: "School office", maxAttempts: 3 },
  transactionalEmail: { fromName: "Receipts", maxAttempts: 2 },
  relay: { label: "Relay" },
  bulkTarget: "record" as "record" | "gone",
  withGone: true,
};
