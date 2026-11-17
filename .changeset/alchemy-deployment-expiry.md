---
"@confect/alchemy": minor
---

Add an `expiresAt` prop to `Convex.Deployment` to set, update, or clear a cloud backend's automatic deletion deadline in milliseconds since the Unix epoch. Only explicit `null` clears an expiry; omission preserves the current deadline. Reject non-finite numbers, fractions, and unsafe integers before cloud API calls. Local backends ignore expiry changes without restarting.
