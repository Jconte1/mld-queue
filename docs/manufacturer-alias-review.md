# Daily Manufacturer Alias Review

Use this guide when reviewing Specbooks `CREATE_STOCK_ITEM` manufacturer names.

## 1. Check Pending Names

In the worker's PostgreSQL database (currently `specbooks_gateway_dev`), run:

```sql
SELECT "manufacturerKey", "suppliedName", "seenCount", "lastInventoryId",
       "lastJobId", "lastSeenAt"
FROM manufacturer_aliases
WHERE status = 'pending'
ORDER BY "lastSeenAt" DESC;
```

Unknown names fail before Acumatica item creation and appear here for review.
`seenCount` counts encounters, including repeated attempts. `lastJobId` identifies
the most recent affected job; several jobs may need a retry for the same name.

## 2. Identify the Correct Mapping

Example: Specbooks sends `Mountain Plumbing Products USA`.
Confirm that it belongs to the approved `Mountain Plumbing` mapping:

```sql
SELECT "manufacturerKey", "manufacturerName", "priceClass", "itemClass",
       "vendorId", "vendorName", "status"
FROM manufacturer_mappings
WHERE "priceClass" = 'P047';
```

Expected mapping:

| Field | Value |
| --- | --- |
| Manufacturer | Mountain Plumbing |
| ItemClass | PLUMB-LOT |
| PriceClass | P047 |
| VendorID | BA0000739 |
| VendorName | Mountain Plumbing Products |
| Status | approved |

Use business knowledge to confirm the association. A similar name alone is not
enough. If no approved mapping exists, complete and approve that mapping first.

## 3. Approve the Alias

Run in PowerShell:

```powershell
Set-Location 'C:\Users\james\Documents\mld-projects\mld-queue\worker'

npm.cmd run review:manufacturer-aliases -- `
  --name "Mountain Plumbing Products USA" `
  --price-class P047
```

Replace the example name and PriceClass with the reviewed values. The command
uses `worker/.env`; confirm its `DATABASE_URL` targets the worker's database.

The command sets the alias's `mappingKey` and `status = approved`, and validates
that the target mapping is approved and its vendor exists in the active vendor
table. Do not just set `status` to approved manually: an alias needs a valid
`mappingKey` as well.

Future requests using the approved name resolve automatically. Alias approvals
do not require a rebuild or deployment and do not change Acumatica descriptions.

## 4. Retry Affected Jobs

Approval does not automatically retry existing failures. Use `lastJobId` to
identify the most recent job, review its payload/error, and retry it through the
queue using the existing retry procedure. If multiple jobs used the same name,
review and retry each affected job.

Retrying a manufacturer-name failure should proceed with the approved mapping
because that failure occurred before the Acumatica write.

## 5. Verify Success

After the retry, inspect the `jobs` row:

```sql
SELECT id, status, error, result -> 'mappingVerification' AS verification
FROM jobs
WHERE id = 'REPLACE-WITH-JOB-ID';
```

Confirm `status = succeeded` and `verification.verified = true`. The verification
contains the supplied/canonical manufacturer and the expected/actual ItemClass,
PriceClass, and VendorID from the Acumatica read-back.

## Also Check Failed Create Jobs

Alias review catches unresolved manufacturer names. Acumatica validation errors
and saved-field verification failures may not create pending alias rows.

```sql
SELECT id, payload ->> 'manufacturer' AS manufacturer,
       payload -> 'InventoryID' ->> 'value' AS inventory_id,
       error, result, "updatedAt"
FROM jobs
WHERE type = 'CREATE_STOCK_ITEM' AND status = 'failed'
ORDER BY "updatedAt" DESC;
```

For `StockItemMappingVerificationError`, inspect Acumatica before retrying:
the PUT succeeded, but the read-back failed or differed from the approved
mapping. The item may already exist. Review `result.responseBody` for the expected
and actual fields, the cause, and `writePerformed = true`.

Verification proves the saved fields match your approved mapping; it does not
prove a reviewed business association was correct. Correct the mapping or alias
if you later discover an incorrect association, and review existing affected
items separately. Mapping changes do not retroactively update Acumatica items.

## Initial Live Test

On October 12, 2026, the live gateway/queue/worker test verified:

- Item: `MLD-E2E-1822988476-403C`
- Job: `c9341756-084d-4a1c-9f08-72ae30f8aedf`
- Manufacturer: `Mountain Plumbing Products` (approved alias)
- ItemClass: `PLUMB-LOT`; PriceClass: `P047`; VendorID: `BA0000739`

The deliberately unknown test manufacturer `MLD Unknown E2E 1822988476-403C`
was left as a pending alias. Its job is
`80292aaa-2096-4031-bc3c-5d7726695e04`. It created no Acumatica item and is test
data, not a manufacturer to approve.
