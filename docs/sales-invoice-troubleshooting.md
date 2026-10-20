# Sales Invoice Troubleshooting

## Credit Hold Can Surface as an InventoryID Null Reference

Confirmed by the user on October 20, 2026: the failure below was caused by
the customer business account being on **Credit Hold** in Acumatica.
The error did not explicitly mention credit hold.

### Recognize the Error

- Job type: `ERP_PUT_SALES_INVOICE` (Service Fusion).
- Endpoint: `PUT /entity/CustomEndpoint/24.200.001/SalesInvoice`.
- HTTP status: `500 Internal Server Error`.
- Outer error: `Operation failed`.
- Inner error: `An error occurred during processing of the field InventoryID: Object reference not set to an instance of an object..`
- Deepest exception: `System.NullReferenceException`.
- Stack includes `ARInvoiceEntry.ARTran_AccountID_FieldDefaulting`,
  `SOInvoiceEntry.ARTran_AccountID_FieldDefaulting`, and
  `ARInvoiceEntry.ARTran_InventoryID_FieldUpdated`.

When this signature appears, check the payload's `CustomerID` (BA number)
and its Acumatica status early. Do not assume an item is missing or inactive
just because the exception names `InventoryID`.

### Confirmed Example

| Field | Value |
| --- | --- |
| Job ID | `9bd1b493-7931-4c52-8d41-081d1091c5ab` |
| Customer | `BA0012702` / Renovation Brothers |
| Customer status at investigation | Credit Hold |
| Service Fusion ExternalRef | `38556656` |
| Failure time | October 19, 2026, 11:01 p.m. MDT (`2026-10-20T05:01:53.385Z`) |
| Default location | `MAIN` (active); payload omitted `LocationID` |

The four submitted items were:

- `INS-U/C FRIDGE`
- `INS-UNDERCOUNTERREFERATPANEL`
- `INS-TRIPCHARGESALTLAKECOUNTY`
- `INS-CUSTOMHANDLE`

All four were active, with sales account `4500`, subaccount `0000`, and
posting class `INSTALL`. They had succeeded on other customers' invoices.
The customer's default location had sales account `4000` and AR account
`1200`. The same reference failed on five consecutive nightly submissions
(October 15-19 MDT). These were separate jobs, not worker retries.

### Investigation and Recovery Checklist

1. Read the failed job's `payload.payload.CustomerID` and ExternalRef.
2. Check that customer's current status in Acumatica, especially Credit Hold.
3. If credit hold applies, have the authorized accounting team decide how
   to resolve it. Do not automatically remove or bypass the hold.
4. Before retrying, search Acumatica for the ExternalRef and any matching
   custom external reference to avoid creating a duplicate invoice.
5. After authorized resolution, retry only one submission for that reference
   and verify the resulting invoice. Do not replay every historical failure.
6. If the customer is not on hold, continue investigating item, customer,
   location, and accounting defaults. This signature is not proof that
   every future null reference has the same cause.

At investigation time, an ExternalRef lookup returned no invoice for this
example. Recheck before any later retry. Hold resolution and a successful
retry were not verified as part of this documentation update.

### Relevant Code

- `worker/src/worker.ts`: `ERP_PUT_SALES_INVOICE` unwraps the supplied payload.
- `worker/src/lib/acumaticaClient.ts`: `putSalesInvoice` sends the payload and
  preserves Acumatica's response body on failure.
- `worker/src/lib/jobRetry.ts`: sales-invoice jobs are excluded from automatic
  transient retries; repeated nightly jobs can still originate upstream.
