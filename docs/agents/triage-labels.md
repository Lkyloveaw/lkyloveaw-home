# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Wayfinder labels

`/wayfinder` also relies on five labels, created alongside the triage set:

| Label              | Applied to                                              |
| ------------------ | ------------------------------------------------------- |
| `wayfinder:map`    | The single map issue holding Notes / Decisions / Fog     |
| `wayfinder:research`  | A child ticket that answers a question from sources   |
| `wayfinder:prototype` | A child ticket that answers a question by building    |
| `wayfinder:grilling`  | A child ticket that answers a question by asking a human |
| `wayfinder:task`      | A child ticket that is just work to do                |

`needs-triage` and the `wayfinder:*` labels are the only ones these skills apply on their own. Don't apply `needs-info`, `ready-for-agent`, `ready-for-human`, or `wontfix` outside a `/triage` decision, and don't add any label a skill didn't ask for.
