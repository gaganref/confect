---
"@confect/alchemy": minor
---

Add `Convex.CustomDomain` to declare cloud backend domains, report their verification status, and optionally manage their canonical URLs.

Keep each resource's deployment name, domain, and destination fixed. To move to a new hostname, declare a second resource with `canonical: false`, configure DNS, transfer canonical ownership after verification, then remove the old resource.
