# SpecBooks Integration Guide

## Authentication
All SpecBooks requests must include:

`X-SPECBOOKS-API-KEY: {{specbook-api-key}}`

## Available Endpoints (5)
1. Get Customer
`GET /api/specbooks/customers/{customerId}`
Fetch customer account details, including address/contact fields.

2. Get Opportunity
`GET /api/specbooks/opportunities/{opportunityId}`
Fetch an opportunity and its line items.

3. Create Opportunity
`POST /api/specbooks/opportunities`
Create a new opportunity with provided payload.

4. Update Opportunity
`PATCH /api/specbooks/opportunities/{opportunityId}`
Apply partial updates to an existing opportunity, including product line changes.

5. Poll Job
`GET /api/specbooks/jobs/{jobId}`
Check async job status/result (`queued`, `processing`, `succeeded`, `failed`).

## Endpoint 1: Get Customer

### Purpose
Fetch customer details from Acumatica through the queue gateway.

### Request
- Method: `GET`
- URL: `{{baseUrl}}/api/specbooks/customers/{{customerId}}`
- Required Header: `X-SPECBOOKS-API-KEY: {{specbook-api-key}}`

### Example JSON Response
```json
{
  "jobId": "641e2822-d230-40af-9b1f-96bc53cb9e84",
  "vendorId": "specbooks",
  "type": "GET_CUSTOMER",
  "status": "succeeded",
  "result": [
    {
      "id": "ec5d75df-265f-eb11-a814-00155d640503",
      "City": { "value": "Murray" },
      "Zip5": { "value": "84107" },
      "State": { "value": "UTAH" },
      "Country": { "value": "US" },
      "AddressLine1": { "value": "6227 Longview Drive" },
      "CustomerID": { "value": "BA0001318" },
      "CustomerName": { "value": "Ben Devenport Construction" },
      "_links": {
        "self": "/entity/CustomEndpoint/24.200.001/Customer/ec5d75df-265f-eb11-a814-00155d640503"
      }
    }
  ],
  "error": null,
  "createdAt": "2026-03-05T17:44:34.267Z",
  "updatedAt": "2026-03-05T17:44:35.372Z"
}
```
