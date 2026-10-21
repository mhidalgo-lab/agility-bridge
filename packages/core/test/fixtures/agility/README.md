# Synthetic Agility fixtures

Hand-written to match the response **shapes** measured in P0-06 (`spikes/agility-api/RESULTS.md`, Agility 26.0.3.2).
Nothing here was copied from, or derived from, a tenant response (D-01): names, numbers, OIDs and dates are invented,
and hostile strings are included on purpose (L-122). Checklist: `docs/dev/verification.md`.

| File | Endpoint | Shape |
|---|---|---|
| `query-v1-stories.json` | `POST query.v1`, one query with dot paths and a nested `Owners` selection | array of result sets, each an array of rows with `_oid` |
| `query-v1-multi.json` | `POST query.v1`, two queries in one call | one result set per query |
| `error-400.json` | `POST query.v1`, unknown attribute | `{ error, exceptions: [{ type, message }] }` |
| `error-401.json` | any endpoint, invalid or missing token | 24-byte JSON body, no `WWW-Authenticate` header |
| `rest-1-data-page.json` | `GET rest-1.v1/Data/Story?sel=…&page=2,0` with `Accept: application/json` | `{ _type, pageSize, pageStart, Assets }`, no `total` |
| `rest-1-hist.json` | `GET rest-1.v1/Hist/Story/<id>` with `Accept: application/json` | one asset per version |
| `meta-v1-story.json` | `GET meta.v1/Story` with `Accept: application/json` (trimmed) | `{ _type, Name, Version, Base, Attributes, Operations }` |

Only fields seen in the probes appear. Their **values** are invented, and the string values of `_type` in the
`rest-1.v1` and `meta.v1` files are illustrative (the probes recorded that the key exists, not its value).
