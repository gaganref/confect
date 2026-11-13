---
"@confect/test": patch
---

The internal test kernel meters each attempt against Convex's transaction limits, with the binary's defaults, counting rules and messages, and `getTransactionMetrics` answers from the same counters. A failed nested mutation's writes leave the count while its reads and schedules stay, and a nested call's `transactionLimits` budget tightens only that call. A patch or replace that changes nothing writes nothing. The public `TestConfect` API is unchanged and still runs on convex-test by default.
