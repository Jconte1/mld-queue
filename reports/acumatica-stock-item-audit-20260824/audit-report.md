# Acumatica Stock Item Read-Only Audit

Generated: 2026-08-24 09:18 America/Denver

## Read-Only Scope

- No StockItem or Vendor mutations were performed.
- Acumatica data calls used `GET` only.
- OAuth token retrieval used the existing password-grant auth flow.
- Source workbook was not modified.

## Confirmed API Shape

- Stock item endpoint used by the repository fallback: `CustomEndpoint/24.200.001/StockItem`
- Required StockItem expand: `WarehouseDetails,VendorDetails,CrossReferences`
- Inventory safety path: `WarehouseDetails[].QtyOnHand`
- Warehouse identifier path: `WarehouseDetails[].WarehouseID`
- Vendor relationship path for StockItem: `VendorDetails[].VendorID`
- Useful vendor-detail fields: `VendorDetails[].VendorName`, `VendorDetails[].Active`, `VendorDetails[].Default`, `VendorDetails[].Location`, `VendorDetails[].PurchaseUnit`
- Vendor master endpoint: `CustomEndpoint/24.200.001/Vendor`
- Useful vendor fields: `VendorID`, `VendorName`, `LegalName`, `Status`, `VendorClass`, `AccountRef`

The live StockItem shape did not expose a direct top-level `VendorID` field. The item-vendor relationship is represented in `VendorDetails`.

## Summary Counts

- Total Excel rows: 1,942
- Unique InventoryIDs: 1,942
- Items found in Acumatica: 1,942
- Items not found: 0
- API errors: 0
- Qty eligible: 1,601
- Skip because `QtyOnHand > 0`: 341
- Items with no `WarehouseDetails` rows: 386
- READY: 498
- SKIP_QTY_ON_HAND: 341
- UNKNOWN_ITEM_CLASS: 332
- VENDOR_REVIEW_REQUIRED: 771

## Item Class Mapping Counts

- `PLUMBING -> PLUMB-LOT`: 1,317
- `HARDWARE -> HARD-LOT`: 17
- `APPLIANCE -> APLS-RCVD`: 91
- `APLS-LOT -> APLS-RCVD`: 6
- `APLS-USED -> APLS-RCVD`: 1
- No defined mapping: 510

Rows already on target classes such as `PLUMB-LOT`, `HARD-LOT`, or `APLS-RCVD` were treated as having no defined correction mapping because those current values are not in the explicit source mapping list.

## Vendor Audit

- Vendor records retrieved: 2,495
- Vendor status counts: Active 2,437; Inactive 56; On Hold 1; One-Time 1
- Proposed vendor status counts in this audit: Active 1,280
- High-confidence vendor rows: 1,107
- Medium-confidence vendor rows: 173
- No vendor inferred: 662

Inactive, on-hold, and one-time vendors should be excluded from any automatic future assignment. They can still be surfaced for manual review if a human intentionally chooses them.

## Vendor Matching Strategy Used

High confidence:

- Current live `StockItem.VendorDetails` already contains a vendor. Preference order: active default, first active, first default, then first row.
- Deterministic InventoryID prefix evidence from existing vendor-populated StockItems, usually requiring at least 3 matches and at least 95% agreement.
- Leading brand-token evidence only when the proposed vendor name/legal name also contains that brand token.

Medium confidence:

- Strong existing pattern that does not satisfy the stricter high-confidence rules, such as a distributor-to-brand relationship (`WOLF -> Roth Living`) or product-line token (`HENRY -> Waterworks`).

No confidence:

- No current `VendorDetails` and no deterministic existing StockItem evidence that met the audit threshold.

## Example Evidence

- `BH234PSLD SS`: prefix `BH234` mapped to `BA0000787` in 6/6 existing vendor-populated StockItems.
- `DD24DCTX9 N`: prefix `DD24` mapped to `BA0000773` in 27/27 existing vendor-populated StockItems.
- `KM7745FL`: current `VendorDetails` contains `BA0000784`; skipped because `SALT LAKE APPLIANCES=1`.
- `04953000`: leading brand-token `HANSGROHE` mapped to `BA0000005` in 11/11 existing vendor-populated StockItems and the vendor name supports the token.
- `9067529`: brand-token `WOLF` suggests `BA0000002` in 18/18 existing vendor-populated StockItems, but remains manual review because the vendor name is `Roth Living`.

## Data Inconsistencies / Review Notes

- The Excel `VendorID` column was blank for all 1,942 rows, but live Acumatica `VendorDetails` already contained a vendor for many items.
- 386 items had no `WarehouseDetails` rows. They were not skipped because the authoritative rule only skips when any `QtyOnHand > 0.00`, but this should be reviewed before mutation approval.
- Several duplicate or ambiguous vendor-name groups exist in the vendor master, including active-active duplicates such as `BSH Home Appliances`, `Rocky Mountain Hardware, Inc.`, and `AMB Design`.

## Recommended Future Correction Script

Build the mutation script as a worker-side TypeScript script using the existing Acumatica auth/env conventions. Keep a hard read/dry-run phase before any write.

1. Read and validate the workbook or a normalized CSV/JSON export.
2. Dedupe InventoryIDs.
3. GET each StockItem with `$expand=WarehouseDetails,VendorDetails,CrossReferences`.
4. Refuse to update any item where any `WarehouseDetails[].QtyOnHand > 0.00`.
5. Apply only the explicit ItemClass map.
6. Resolve vendor through `VendorDetails[].VendorID`; do not write top-level `VendorID`.
7. Permit automatic vendor write only for `HIGH` confidence rows.
8. Exclude inactive/on-hold/one-time vendors from automatic assignment.
9. Produce a dry-run report with before/after payloads.
10. Require explicit approval and a write-enabled environment variable before PUT.
11. Log before/after values, request payloads, response status, and errors for every attempted update.

